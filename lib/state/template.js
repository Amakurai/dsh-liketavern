/** 剧情模板状态与已处理回复共用单文件事务；预览只读，楼层写入先 WAL，分支按文件快照继承。 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { emptyTemplateScopes, parseTemplateScopes } from '../core/template.js';
import { EMPTY_TIMER_STATE } from '../core/types.js';
import { withWorkspaceLock } from './workspaceLock.js';
import { parseTemplateGeneration } from './templateGeneration.js';
import { parseTemplateDisplayParts } from '../core/templateDisplay.js';
import { parseTemplateContinuation, resolveTemplateContinuation } from './templateContinuation.js';
import { parseTemplateMessageVariables } from '../core/templateMessageVariables.js';
export const TEMPLATE_STATE_PATH = 'state/template.json';
export const templateTextHash = (text) => createHash('sha256').update(text).digest('hex');
export async function loadTemplateState(fs) {
    const metadata = await fs.stat(TEMPLATE_STATE_PATH);
    if (metadata && metadata.size > 4 * 1024 * 1024)
        throw new Error('模板状态超过 4 MiB 上限');
    const raw = await fs.readText(TEMPLATE_STATE_PATH);
    if (raw === null)
        return { version: 1, variables: emptyTemplateScopes(), outputs: {} };
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024)
        throw new Error('模板状态超过 4 MiB 上限');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
        || !('variables' in data) || !('outputs' in data) || !data.outputs || typeof data.outputs !== 'object' || Array.isArray(data.outputs))
        throw new Error('模板状态文件损坏');
    const variables = parseTemplateScopes(data.variables);
    const outputs = {};
    for (const [key, value] of Object.entries(data.outputs)) {
        if (!/^\d+$/.test(key) || !value || typeof value !== 'object' || !('hash' in value) || typeof value.hash !== 'string'
            || !/^[a-f0-9]{64}$/.test(value.hash) || !('text' in value) || typeof value.text !== 'string')
            throw new Error('模板回复快照损坏');
        outputs[key] = { hash: value.hash, text: value.text, ...('parts' in value ? { parts: parseTemplateDisplayParts(value.parts) } : {}) };
    }
    let wiTimers;
    if ('wiTimers' in data) {
        if (!data.wiTimers || typeof data.wiTimers !== 'object' || Array.isArray(data.wiTimers))
            throw new Error('模板定时状态损坏');
        wiTimers = Object.fromEntries(Object.entries(data.wiTimers).map(([id, timers]) => [id, parseTimerState(timers)]));
    }
    const generation = 'generation' in data ? parseTemplateGeneration(data.generation) : undefined;
    const continuation = 'continuation' in data ? parseTemplateContinuation(data.continuation) : undefined;
    const messageVariables = 'messageVariables' in data ? parseTemplateMessageVariables(data.messageVariables) : undefined;
    const state = { version: 1, variables, outputs, ...(messageVariables ? { messageVariables } : {}), ...(wiTimers ? { wiTimers } : {}), ...(generation ? { generation } : {}), ...(continuation ? { continuation } : {}) };
    resolveTemplateContinuation(state);
    return state;
}
export async function saveTemplateState(fs, state) {
    if (!fs.currentFloor)
        throw new Error('模板持久化需要已开启的剧情楼层');
    await writeTemplateState(fs, state);
}
async function writeTemplateState(fs, state) {
    if (state.version !== 1 || !state.outputs || typeof state.outputs !== 'object' || Array.isArray(state.outputs))
        throw new Error('模板状态文件损坏');
    parseTemplateScopes(state.variables);
    if (state.messageVariables)
        state.messageVariables = parseTemplateMessageVariables(state.messageVariables);
    if (state.continuation) {
        parseTemplateContinuation(state.continuation);
        resolveTemplateContinuation(state);
    }
    if (state.wiTimers !== undefined && (!state.wiTimers || typeof state.wiTimers !== 'object' || Array.isArray(state.wiTimers)))
        throw new Error('模板定时状态损坏');
    for (const timers of Object.values(state.wiTimers ?? {}))
        parseTimerState(timers);
    for (const [key, output] of Object.entries(state.outputs)) {
        if (!/^\d+$/.test(key) || !output || typeof output !== 'object' || typeof output.hash !== 'string'
            || !/^[a-f0-9]{64}$/.test(output.hash) || typeof output.text !== 'string')
            throw new Error('模板回复快照损坏');
        if (output.parts !== undefined)
            parseTemplateDisplayParts(output.parts);
    }
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024)
        throw new Error('模板状态超过 4 MiB 上限');
    if (state.generation)
        parseTemplateGeneration(JSON.parse(raw).generation);
    if (raw !== await fs.readText(TEMPLATE_STATE_PATH)) {
        try {
            await fs.writeText(TEMPLATE_STATE_PATH, raw);
        }
        catch (error) {
            // 某些文件系统在 rename 已完成后仍报告失败；读回确认提交结果，防重试重复增量。
            if (await fs.readText(TEMPLATE_STATE_PATH) !== raw)
                throw error;
        }
    }
}
function parseTimerState(value) {
    if (!value || typeof value !== 'object' || !('stickyLeft' in value) || !('cooldownLeft' in value))
        throw new Error('模板定时状态损坏');
    const map = (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error('模板定时状态损坏');
        return Object.fromEntries(Object.entries(input).map(([key, left]) => {
            if (typeof left !== 'number' || !Number.isFinite(left) || left < 0)
                throw new Error('模板定时状态损坏');
            return [key, left];
        }));
    };
    return { stickyLeft: map(value.stickyLeft), cooldownLeft: map(value.cooldownLeft) };
}
const legacyTimerPath = (sessionId) => `state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
/** 新状态优先；旧文件保留为迁移来源和回滚旧楼层所需的历史数据。 */
export async function loadTemplateTimers(fs, sessionId) {
    const state = await loadTemplateState(fs);
    if (state.wiTimers && Object.hasOwn(state.wiTimers, sessionId))
        return state.wiTimers[sessionId];
    const raw = await fs.readText(legacyTimerPath(sessionId));
    if (raw === null)
        return structuredClone(EMPTY_TIMER_STATE);
    try {
        return parseTimerState(JSON.parse(raw));
    }
    catch (cause) {
        throw new Error('模板定时状态损坏', { cause });
    }
}
/** 普通计时更新与分支复制只改变计时字段；未迁移会话保留原路径，不创建空模板文件。 */
export async function saveTemplateTimers(fs, sessionId, timers) {
    await withWorkspaceLock(fs.root, async () => {
        const state = await loadTemplateState(fs);
        const parsed = parseTimerState(timers);
        if (state.wiTimers && Object.hasOwn(state.wiTimers, sessionId)) {
            await writeTemplateState(fs, { ...state, wiTimers: { ...state.wiTimers, [sessionId]: parsed } });
        }
        else {
            await fs.writeText(legacyTimerPath(sessionId), JSON.stringify(parsed, null, 2) + '\n');
        }
    });
}
/** 分支草稿把边界定时器复制到子会话旧路径；不改祖先模板镜像，跨分支 WAL 才能逐层撤销。 */
export async function copyTemplateTimers(fs, fromSessionId, toSessionId) {
    await withWorkspaceLock(fs.root, async () => {
        const state = await loadTemplateState(fs);
        if (state.wiTimers && Object.hasOwn(state.wiTimers, fromSessionId)) {
            await fs.writeText(legacyTimerPath(toSessionId), JSON.stringify(state.wiTimers[fromSessionId], null, 2) + '\n');
        }
        else {
            const raw = await fs.readText(legacyTimerPath(fromSessionId));
            if (raw !== null) {
                // 草稿发布前先校验迁移来源，不能把损坏文件复制到已发布的子剧情。
                try {
                    parseTimerState(JSON.parse(raw));
                }
                catch (cause) {
                    throw new Error('模板定时状态损坏', { cause });
                }
                await fs.writeText(legacyTimerPath(toSessionId), raw);
            }
        }
    });
}
