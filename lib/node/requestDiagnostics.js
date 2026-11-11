import { summarizeCacheUsage } from '../core/cacheUsage.js';
import { isTavernRuntimeSession } from './tavernSession.js';
/** 私有计划用于 Session 重放，既不是入模内容，也不应随每轮历史反复序列化到诊断。 */
function diagnosticMessage(message) {
    if (!message.source || !('tavernPromptPlan' in message.source) && message.source.kind !== 'tavern-prompt-plan')
        return message;
    const source = { ...message.source };
    delete source.tavernPromptPlan;
    if (source.kind === 'tavern-prompt-plan')
        delete source.plan;
    return { ...message, source };
}
/** 同一有界缓存既记录宿主输入，也允许布局适配器覆盖为实际投影后的消息；惰性格式化避免每步生成两次序列化完整历史。 */
export function recordRequestDiagnostics(state, id, options, stage = 'host', projectionNotes = []) {
    const observedAt = new Date().toISOString();
    const turn = state.currentTurns.get(id);
    const step = state.currentSteps.get(id);
    const notes = projectionNotes.length ? [...projectionNotes] : undefined;
    const { signal: _signal, ...request } = options;
    let payload = {
        observedAt,
        stage,
        ...(notes ? { projectionNotes: notes } : {}),
        turn,
        step,
        request: { ...request, messages: request.messages.map(diagnosticMessage) },
    };
    let formatted = null;
    const limit = 2 * 1024 * 1024;
    const ensure = () => {
        if (formatted)
            return formatted;
        let raw;
        try {
            raw = JSON.stringify(payload, null, 2);
        }
        catch {
            // 诊断属于旁路；第三方来源元数据不能序列化时，也不能阻断真实适配器的消息发送。
            raw = JSON.stringify({ observedAt, stage, error: '本次请求诊断无法序列化；生成继续。' });
        }
        payload = null;
        formatted = { text: raw.slice(0, limit), truncated: raw.length > limit };
        return formatted;
    };
    state.requestDiagnostics.delete(id);
    state.requestDiagnostics.set(id, {
        get text() { return ensure().text; },
        get truncated() { return ensure().truncated; },
    });
    while (state.requestDiagnostics.size > 8)
        state.requestDiagnostics.delete(state.requestDiagnostics.keys().next().value);
}
export function registerRequestDiagnostics(ctx, state) {
    ctx.on('llm/stream', (options, next) => {
        const id = options.sessionId;
        const session = id ? ctx.sessions.get(id) : undefined;
        try {
            if (id && session && !options.purpose && isTavernRuntimeSession(ctx, session)) {
                recordRequestDiagnostics(state, id, options);
            }
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: 请求诊断记录失败：${String(error)}`);
        }
        return next();
    });
}
/** 宿主把每步 usage 随 assistant/message 持久化；分支继承的父会话事件已在父会话计费，不重复统计。 */
export function sessionCacheUsage(session) {
    const steps = [];
    for (const event of session.snapshotEvents().slice(Number(session.inheritedEventCount))) {
        if (event.type !== 'assistant/message' || !event.data.usage)
            continue;
        steps.push({ turn: event.data.turn, ...event.data.usage });
    }
    return summarizeCacheUsage(steps);
}
