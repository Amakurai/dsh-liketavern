/** 跨轮注册表与闭包日志的持久化边界：prepared 期间复用单份日志，收口时再转移到续存记录。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { templatePreloadAssets } from '../core/templateContinuation.js';
import { validateTemplateJson } from '../core/template.js';
import { templateReplayGenerationContext } from '../core/templateReplay.js';
import { parseTemplateMessageVariables, visibleTemplateMessageVariables } from '../core/templateMessageVariables.js';
import { parseTemplateStickyState } from '../core/templateSticky.js';
import { parseTemplateReplay, closeTemplateGeneration } from './templateGeneration.js';
export function templatePreloadRevision(context) {
    const canonical = (value) => {
        if (Array.isArray(value))
            return value.map(canonical);
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        return value;
    };
    return createHash('sha256').update(JSON.stringify(canonical(templatePreloadAssets(context)))).digest('hex');
}
export function templateStickyHasClosures(state) {
    return [...state.regex.generate, ...state.regex.message].some(rule => rule.replacement.kind === 'callback');
}
/** 指纹属于日志最近一次生成的冻结资产，不能靠伪造指纹使重建预加载被当成一次真实刷新。 */
function validateContinuationReplayRevision(revision, replay) {
    if (revision !== templatePreloadRevision(templateReplayGenerationContext(replay)))
        throw new Error('模板跨轮资产指纹与执行日志不一致');
}
export function parseTemplateContinuation(value) {
    validateTemplateJson(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
        || typeof value.preloadRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.preloadRevision)
        || Object.keys(value).some(key => !['version', 'preloadRevision', 'state', 'replay'].includes(key)))
        throw new Error('模板跨轮状态损坏');
    const state = parseTemplateStickyState(value.state);
    const replay = value.replay === undefined ? undefined : parseTemplateReplay(value.replay);
    if (replay && !templateStickyHasClosures(state))
        throw new Error('模板跨轮状态包含无用的闭包日志');
    if (replay)
        validateContinuationReplayRevision(value.preloadRevision, replay);
    return { version: 1, preloadRevision: value.preloadRevision, state, ...(replay ? { replay } : {}) };
}
/** 仅在当前剧情内解析引用；不会因为回执缺失而重新执行某个旧生成阶段。 */
export function resolveTemplateContinuation(stored) {
    const carry = stored.continuation;
    if (!carry)
        return undefined;
    if (!templateStickyHasClosures(carry.state))
        return carry;
    const replay = carry.replay ?? (stored.generation?.status === 'prepared' ? stored.generation.replay : undefined);
    if (!replay)
        throw new Error('跨轮闭包缺少可恢复的执行日志');
    validateContinuationReplayRevision(carry.preloadRevision, replay);
    if (!isDeepStrictEqual(replay.variables, stored.variables))
        throw new Error('模板跨轮执行日志与已提交变量不一致');
    const lastPhase = [...replay.operations].reverse().find(operation => operation.kind === 'phase');
    const context = lastPhase?.kind === 'phase' ? lastPhase.context : replay.context;
    if (context.historyIdentities) {
        const visible = parseTemplateMessageVariables(visibleTemplateMessageVariables(stored.messageVariables, context.historyIdentities));
        const fingerprint = createHash('sha256').update(JSON.stringify(visible)).digest('hex');
        if (fingerprint !== replay.messageVariablesHash)
            throw new Error('模板跨轮历史消息变量与已提交消息快照不一致');
    }
    return carry.replay ? carry : { ...carry, replay };
}
/** 关闭 prepared 回执前保留仍活跃的共享词法环境；不存在回调时释放日志，计数与过期状态继续保留。 */
export function closeTemplateGenerationState(stored, status) {
    if (!stored.generation)
        return;
    const carry = resolveTemplateContinuation(stored);
    if (carry)
        stored.continuation = carry;
    stored.generation = closeTemplateGeneration(stored.generation, status);
}
