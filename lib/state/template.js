/** 剧情模板状态共用原子根事务；大型快照无损分块复用，预览只读，楼层写入先 WAL。 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { emptyTemplateScopes, parseTemplateScopes } from '../core/template.js';
import { EMPTY_TIMER_STATE } from '../core/types.js';
import { withWorkspaceLock } from './workspaceLock.js';
import { attachTemplateGeneration, detachTemplateGeneration, isDetachedTemplateGeneration, parseDetachedTemplateGeneration, parseTemplateGeneration } from './templateGeneration.js';
import { parseTemplateDisplayParts, TEMPLATE_DISPLAY_PARTS_VERSION } from '../core/templateDisplay.js';
import { parseTemplateContinuation, resolveTemplateContinuation } from './templateContinuation.js';
import { parseTemplateMessageVariables } from '../core/templateMessageVariables.js';
import { adoptTemplateDocument, loadTemplateDocument, loadTemplateDocumentPaths, prepareTemplateDocument, readTemplateDocumentPaths, readTemplateDocumentText, writeTemplateBlocks, TEMPLATE_DATA_PATH, TEMPLATE_DOCUMENT_LIMIT, TEMPLATE_INLINE_LIMIT } from './templateStorage.js';
import { ledgerKey, openLedger, writtenSince } from './writeLedger.js';
export const TEMPLATE_STATE_PATH = 'state/template.json';
/**
 * 未结束轮次的冻结计划与闭包重放正文。它每轮整体替换、收口即作废，体积又随可见历史增长：
 * 留在分块历史里，每轮都会产生几十个只用一次的数据块并把同样的字节再写进楼层日志。
 * 大型状态把正文按内容摘要单独存放，根里只留归属与摘要；回滚只恢复根，仍可恢复的根引用正文必须保留。
 */
export const TEMPLATE_GENERATION_PATH = 'state/template-generation';
/** 文件名带所属楼层：收口或重新生成同一楼层时，只清理这一层自己留下的正文。 */
const generationFloor = (floor) => {
    const base = floor.replace(/[^A-Za-z0-9_-]/g, '_');
    return /^[A-Za-z0-9-]+#t\d+$/.test(floor) ? `${base}.` : `${base}-${templateTextHash(floor).slice(0, 12)}.`;
};
const generationPath = (floor, hash) => `${TEMPLATE_GENERATION_PATH}/${generationFloor(floor)}${hash}.json`;
export const templateTextHash = (text) => createHash('sha256').update(text).digest('hex');
const generationBodies = new Map();
const bodyKey = (root) => { const absolute = resolve(root); return process.platform === 'win32' ? absolute.toLowerCase() : absolute; };
const generationReferences = new Map();
const rootIdentity = (raw) => raw === null ? 'empty' : templateTextHash(raw);
const generationDataKey = ledgerKey(TEMPLATE_DATA_PATH);
function generationReferenceCache(fs, current) {
    const key = bodyKey(fs.root), ledger = openLedger(fs.root), identity = rootIdentity(current);
    let cache = generationReferences.get(key);
    if (cache)
        generationReferences.delete(key);
    else
        cache = { roots: new Map(), current: identity, revision: ledger.counter, epoch: ledger.epoch };
    let changed = cache.epoch !== ledger.epoch || cache.current !== identity || writtenSince(ledger, TEMPLATE_STATE_PATH, cache.revision);
    for (const [dir, order] of ledger.dirs)
        changed ||= order > cache.revision && (dir === generationDataKey || dir.startsWith(generationDataKey + '/'));
    if (changed)
        cache.roots.clear();
    cache.current = identity;
    cache.epoch = ledger.epoch;
    cache.revision = ledger.counter;
    generationReferences.set(key, cache);
    if (generationReferences.size > 8)
        generationReferences.delete(generationReferences.keys().next().value);
    return cache;
}
function rememberGenerationReference(cache, raw, path) {
    const key = rootIdentity(raw);
    cache.roots.delete(key);
    cache.roots.set(key, path);
    if (cache.roots.size > 16)
        cache.roots.delete(cache.roots.keys().next().value);
}
function rememberGenerationBody(fs, body) {
    const key = bodyKey(fs.root);
    generationBodies.delete(key);
    if (!body)
        return;
    generationBodies.set(key, body);
    if (generationBodies.size > 8)
        generationBodies.delete(generationBodies.keys().next().value);
}
function knownGenerationBody(fs, path) {
    const body = generationBodies.get(bodyKey(fs.root)), ledger = openLedger(fs.root);
    // 工作区内改写或删除过这份正文就重新读盘核对。
    return body && body.path === path && body.epoch === ledger.epoch && !writtenSince(ledger, path, body.revision) ? body : undefined;
}
async function readGenerationBody(fs, detached) {
    const owner = JSON.stringify(detached), hash = detached.payload.hash, path = generationPath(detached.floor, hash);
    const known = knownGenerationBody(fs, path);
    if (known?.owner === owner && known.json !== undefined)
        return JSON.parse(known.json);
    const plain = fs.withFloor(null);
    const info = await plain.stat(path);
    if (!info)
        throw new Error('模板生成恢复数据缺失，无法恢复未结束的轮次；请回退该楼层后继续');
    if (info.size !== detached.payload.bytes || info.size > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error('模板生成恢复数据校验失败');
    const raw = await plain.readText(path);
    if (raw === null || templateTextHash(raw) !== hash)
        throw new Error('模板生成恢复数据校验失败');
    const generation = attachTemplateGeneration(detached, JSON.parse(raw));
    const ledger = openLedger(fs.root);
    rememberGenerationBody(fs, { owner, path, json: JSON.stringify(generation), revision: ledger.counter, epoch: ledger.epoch });
    return generation;
}
export async function loadTemplateState(fs) {
    return withWorkspaceLock(fs.root, async () => {
        const stored = await loadTemplateDocument(fs, TEMPLATE_STATE_PATH, parseStoredTemplateState);
        const state = stored.state;
        if (stored.detached)
            state.generation = await readGenerationBody(fs, stored.detached);
        else
            rememberGenerationBody(fs, undefined);
        resolveTemplateContinuation(state);
        return state;
    });
}
export async function loadTemplateGenerationIdentity(fs) {
    return withWorkspaceLock(fs.root, async () => {
        const fields = await readTemplateFields(fs, ['generation']);
        const raw = fields?.generation;
        const generation = raw === undefined ? undefined : isDetachedTemplateGeneration(raw)
            ? parseDetachedTemplateGeneration(raw) : parseTemplateGeneration(raw);
        if (!generation)
            return undefined;
        const { version, status, sessionId, cardId, storyId, turn, floor } = generation;
        return { version, status, sessionId, cardId, storyId, turn, floor };
    });
}
/** 只读取生成记录；正文按需恢复，历史 outputs 与消息变量不参与本次复制。 */
export async function loadTemplateGeneration(fs) {
    return withWorkspaceLock(fs.root, async () => {
        const raw = (await readTemplateFields(fs, ['generation']))?.generation;
        if (raw === undefined)
            return undefined;
        return isDetachedTemplateGeneration(raw) ? readGenerationBody(fs, parseDetachedTemplateGeneration(raw)) : parseTemplateGeneration(raw);
    });
}
const metadataKeys = ['variables', 'messageVariables', 'wiTimers', 'continuation', 'generation'];
const metadataPaths = [['version'], ...metadataKeys.map(key => [key])];
/** 稳定解析器供路径缓存复用；只读查询不必反复展开校验同一份大型重放。 */
function parseMetadataFields(values) {
    const fields = parseTemplateFields(metadataKeys, values);
    return parseStoredTemplateState(fields === null ? null : { ...fields, outputs: {} });
}
export async function loadTemplateMetadata(fs) {
    return withWorkspaceLock(fs.root, async () => {
        const stored = await loadTemplateDocumentPaths(fs, TEMPLATE_STATE_PATH, metadataPaths, parseMetadataFields);
        if (stored.detached)
            stored.state.generation = await readGenerationBody(fs, stored.detached);
        resolveTemplateContinuation(stored.state);
        const { outputs: _outputs, ...metadata } = stored.state;
        return metadata;
    });
}
/** 调用方持有剧情锁；缺字段保持缺省，不能把 null/损坏字段当作旧格式回退。 */
async function readTemplateFields(fs, keys) {
    const values = await readTemplateDocumentPaths(fs, TEMPLATE_STATE_PATH, [['version'], ...keys.map(key => [key])]);
    return parseTemplateFields(keys, values);
}
function parseTemplateFields(keys, values) {
    if (values === null)
        return null;
    if (values[0] !== 1)
        throw new Error('模板状态文件损坏');
    return Object.fromEntries([['version', 1], ...keys.flatMap((key, index) => values[index + 1] === undefined ? [] : [[key, values[index + 1]]])]);
}
/** 展示按真实消息身份读取快照；冷启动也不展开其它回复的正文和卡面片段。 */
export async function loadTemplateOutputs(fs, messageIds) {
    if (messageIds.some(id => !Number.isSafeInteger(id) || id < 0))
        throw new Error('模板回复消息身份无效');
    const keys = [...new Set(messageIds.map(String))];
    if (!keys.length)
        return {};
    return withWorkspaceLock(fs.root, async () => {
        const values = await readTemplateDocumentPaths(fs, TEMPLATE_STATE_PATH, [['version'], ...keys.map(key => ['outputs', key])]);
        if (values === null)
            return {};
        if (values[0] !== 1)
            throw new Error('模板状态文件损坏');
        const outputs = Object.fromEntries(keys.flatMap((key, index) => values[index + 1] === undefined ? [] : [[key, values[index + 1]]]));
        return parseStoredTemplateState({ version: 1, variables: emptyTemplateScopes(), outputs }).state.outputs;
    });
}
/** 渲染单条消息或续写片段只提取需要的回复；project 的输入递归冻结，返回值单独复制。 */
export async function selectTemplateOutputs(fs, project) {
    return withWorkspaceLock(fs.root, () => loadTemplateDocument(fs, TEMPLATE_STATE_PATH, parseStoredTemplateState, value => project(value.state.outputs)));
}
function parseStoredTemplateState(data) {
    if (data === null)
        return { state: { version: 1, variables: emptyTemplateScopes(), outputs: {} } };
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
        || !('variables' in data) || !('outputs' in data) || !data.outputs || typeof data.outputs !== 'object' || Array.isArray(data.outputs))
        throw new Error('模板状态文件损坏');
    const variables = parseTemplateScopes(data.variables);
    const outputs = {};
    for (const [key, value] of Object.entries(data.outputs)) {
        if (!/^\d+$/.test(key) || !value || typeof value !== 'object' || !('hash' in value) || typeof value.hash !== 'string'
            || !/^[a-f0-9]{64}$/.test(value.hash) || !('text' in value) || typeof value.text !== 'string')
            throw new Error('模板回复快照损坏');
        if ('partsVersion' in value && value.partsVersion !== TEMPLATE_DISPLAY_PARTS_VERSION)
            throw new Error('模板回复展示版本无效');
        outputs[key] = { hash: value.hash, text: value.text,
            ...('parts' in value ? { parts: parseTemplateDisplayParts(value.parts) } : {}),
            ...('partsVersion' in value ? { partsVersion: TEMPLATE_DISPLAY_PARTS_VERSION } : {}) };
    }
    let wiTimers;
    if ('wiTimers' in data) {
        if (!data.wiTimers || typeof data.wiTimers !== 'object' || Array.isArray(data.wiTimers))
            throw new Error('模板定时状态损坏');
        wiTimers = Object.fromEntries(Object.entries(data.wiTimers).map(([id, timers]) => [id, parseTimerState(timers)]));
    }
    const detached = 'generation' in data && isDetachedTemplateGeneration(data.generation) ? parseDetachedTemplateGeneration(data.generation) : undefined;
    const generation = 'generation' in data && !detached ? parseTemplateGeneration(data.generation) : undefined;
    const continuation = 'continuation' in data ? parseTemplateContinuation(data.continuation) : undefined;
    const messageVariables = 'messageVariables' in data ? parseTemplateMessageVariables(data.messageVariables, 'stored') : undefined;
    const state = { version: 1, variables, outputs, ...(messageVariables ? { messageVariables } : {}), ...(wiTimers ? { wiTimers } : {}), ...(generation ? { generation } : {}), ...(continuation ? { continuation } : {}) };
    // 续存记录可能借用 prepared 记录里的重放；正文合并后由 loadTemplateState 统一核对。
    return { state, ...(detached ? { detached } : {}) };
}
export async function saveTemplateState(fs, state) {
    if (!fs.currentFloor)
        throw new Error('模板持久化需要已开启的剧情楼层');
    await withWorkspaceLock(fs.root, () => writeTemplateState(fs, state));
}
/**
 * 冻结计划等元数据写入保留提交时最新的回复快照，不用把完整 outputs 交给组装管线往返复制。
 * 只在同一工作区锁内借用缓存的递归冻结视图；写入器只读 outputs，这份引用不会暴露给调用方。
 */
export async function saveTemplateMetadata(fs, metadata) {
    if (!fs.currentFloor)
        throw new Error('模板持久化需要已开启的剧情楼层');
    await withWorkspaceLock(fs.root, () => writeTemplateMetadata(fs, metadata));
}
/** 调用方已持有工作区锁；定时器面板允许使用无楼层句柄发布独立维护。 */
async function writeTemplateMetadata(fs, metadata) {
    let outputs = {};
    await loadTemplateDocument(fs, TEMPLATE_STATE_PATH, parseStoredTemplateState, stored => {
        outputs = stored.state.outputs;
        return null;
    });
    await writeTemplateState(fs, { ...metadata, outputs });
}
async function writeTemplateState(fs, state) {
    if (state.version !== 1 || !state.outputs || typeof state.outputs !== 'object' || Array.isArray(state.outputs))
        throw new Error('模板状态文件损坏');
    parseTemplateScopes(state.variables);
    if (state.messageVariables)
        state.messageVariables = parseTemplateMessageVariables(state.messageVariables, 'stored');
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
        if (output.partsVersion !== undefined && output.partsVersion !== TEMPLATE_DISPLAY_PARTS_VERSION)
            throw new Error('模板回复展示版本无效');
    }
    if (state.generation)
        parseTemplateGeneration(state.generation);
    // 小状态整份内联，与旧格式一致；大型状态的 prepared 正文不进入分块历史。
    let stored = state;
    let detached;
    if (state.generation?.status === 'prepared' && Buffer.byteLength(JSON.stringify(state)) > TEMPLATE_INLINE_LIMIT) {
        const parts = detachTemplateGeneration(state.generation), text = JSON.stringify(parts.body), bytes = Buffer.byteLength(text);
        if (bytes > TEMPLATE_DOCUMENT_LIMIT)
            throw new Error('模板生成恢复数据超过 64 MiB 上限，原状态未替换；请压缩历史，或从较早楼层创建分支后继续');
        detached = { generation: { ...parts.identity, payload: { hash: templateTextHash(text), bytes } }, text };
        stored = { ...state, generation: detached.generation };
    }
    const document = prepareTemplateDocument(stored), raw = document.raw;
    const current = await fs.readText(TEMPLATE_STATE_PATH);
    if (raw === current)
        return;
    const references = generationReferenceCache(fs, current);
    if (!references.roots.has(rootIdentity(current))) {
        try {
            const retained = await loadTemplateDocument(fs, TEMPLATE_STATE_PATH, parseStoredTemplateState, value => value.detached
                ? generationPath(value.detached.floor, value.detached.payload.hash) : null);
            rememberGenerationReference(references, current, retained);
        }
        catch {
            references.roots.clear(); /* 旧根无法验证时不记结论；保存本身仍可修复缺失的不可变块。 */
        }
    }
    const plain = fs.withFloor(null);
    const body = detached && generationPath(detached.generation.floor, detached.generation.payload.hash);
    try {
        // 正文先于引用它的根落盘，不记楼层日志：按内容寻址，重试或再次保存同一份计划不重写。
        if (detached && body && !knownGenerationBody(fs, body) && await plain.readText(body) !== detached.text)
            await plain.writeText(body, detached.text);
        await writeTemplateBlocks(fs, document, current);
        await fs.writeText(TEMPLATE_STATE_PATH, raw);
    }
    catch (error) {
        // 某些文件系统在 rename 已完成后仍报告失败；读回确认提交结果，防重试重复增量。
        if (await fs.readText(TEMPLATE_STATE_PATH) !== raw)
            throw error;
    }
    // 根只在全部新块落盘后发布；读回即为 raw 说明这些块都已在磁盘。解析结果与之后从磁盘读取所得相同；
    // 状态此时已经提交，解析不出来就留给下次读取从磁盘报告，不能把已提交的保存改报失败。
    let parsed;
    if (document.blocks.size)
        try {
            parsed = parseStoredTemplateState(JSON.parse(document.json));
        }
        catch {
            parsed = undefined;
        }
    adoptTemplateDocument(fs, TEMPLATE_STATE_PATH, document, parsed);
    const ledger = openLedger(fs.root);
    // 锁内本次写入只发布已验证的不可变块与新根，既有根的正文引用结论仍然成立。
    rememberGenerationReference(references, raw, body || null);
    references.current = rootIdentity(raw);
    references.revision = ledger.counter;
    references.epoch = ledger.epoch;
    rememberGenerationBody(fs, detached && body ? { owner: JSON.stringify(detached.generation), path: body, revision: ledger.counter, epoch: ledger.epoch } : undefined);
    // 楼层外维护会打断根的连续写入：回滚会保留手动根，它可能仍引用本层的 prepared 正文。
    // 先按同一套 WAL 撤销语义推算回滚后的根，只清理当前根与可恢复根均不引用的正文；判断失败则保守保留。
    // 其它楼层留下的正文（例如继承自来源剧情的未结束记录）仍可能随回滚重新成为当前状态，不在这里处理。
    if (fs.currentFloor !== null) {
        const prefix = generationFloor(fs.currentFloor);
        try {
            const candidates = (await plain.list(TEMPLATE_GENERATION_PATH, { recursive: false })).filter(name => name.startsWith(prefix) && `${TEMPLATE_GENERATION_PATH}/${name}` !== body);
            if (candidates.length) {
                const restored = await fs.rollbackSnapshot(TEMPLATE_STATE_PATH, raw);
                const restoredKey = rootIdentity(restored);
                if (!references.roots.has(restoredKey)) {
                    const previous = parseStoredTemplateState(await readTemplateDocumentText(plain, restored));
                    rememberGenerationReference(references, restored, previous.detached ? generationPath(previous.detached.floor, previous.detached.payload.hash) : null);
                }
                const retained = references.roots.get(restoredKey);
                for (const name of candidates) {
                    const path = `${TEMPLATE_GENERATION_PATH}/${name}`;
                    if (path !== retained)
                        await plain.delete(path).catch(() => { });
                }
            }
        }
        catch { /* 清理只回收冗余文件，不能将已提交根改报失败或猜测损坏日志里的可达性。 */ }
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
    const timers = await withWorkspaceLock(fs.root, () => readTemplateTimer(fs, sessionId));
    if (timers)
        return timers;
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
/** 定时器表远小于回复历史；校验整张表，损坏的新字段仍禁止回退旧文件。 */
async function readTemplateTimer(fs, sessionId) {
    const fields = await readTemplateFields(fs, ['wiTimers']);
    if (!fields || !Object.hasOwn(fields, 'wiTimers'))
        return undefined;
    const timers = fields.wiTimers;
    if (!timers || typeof timers !== 'object' || Array.isArray(timers))
        throw new Error('模板定时状态损坏');
    const parsed = Object.fromEntries(Object.entries(timers).map(([id, value]) => [id, parseTimerState(value)]));
    return Object.hasOwn(parsed, sessionId) ? parsed[sessionId] : undefined;
}
/**
 * 普通计时更新与分支复制只改变计时字段；未迁移会话保留原路径，不创建空模板文件。
 * 内容未变时不重写：每轮都落一条同值 WAL 记录既无意义，也会给后续楼层回滚制造假依赖。
 */
export async function saveTemplateTimers(fs, sessionId, timers) {
    await withWorkspaceLock(fs.root, async () => {
        const parsed = parseTimerState(timers);
        const previous = await readTemplateTimer(fs, sessionId);
        if (previous) {
            // 大部分轮次没有计时变化：先比较小字段，无需复制全部回复、更不必恢复生成正文。
            if (JSON.stringify(previous) === JSON.stringify(parsed))
                return;
            const state = await loadTemplateMetadata(fs);
            await writeTemplateMetadata(fs, { ...state, wiTimers: { ...state.wiTimers, [sessionId]: parsed } });
        }
        else {
            const path = legacyTimerPath(sessionId), raw = JSON.stringify(parsed, null, 2) + '\n';
            if (raw !== await fs.readText(path))
                await fs.writeText(path, raw);
        }
    });
}
/** 分支草稿把边界定时器复制到子会话旧路径；不改祖先模板镜像，跨分支 WAL 才能逐层撤销。 */
export async function copyTemplateTimers(fs, fromSessionId, toSessionId) {
    if (fromSessionId === toSessionId)
        return;
    await withWorkspaceLock(fs.root, async () => {
        const timers = await readTemplateTimer(fs, fromSessionId);
        if (timers) {
            await fs.writeText(legacyTimerPath(toSessionId), JSON.stringify(timers, null, 2) + '\n');
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
            else {
                await fs.delete(legacyTimerPath(toSessionId));
            }
        }
    });
}
