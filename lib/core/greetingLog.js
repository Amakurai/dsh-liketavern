/**
 * 开场白日志判定：assistant/message 不翻转 dsh 的 blank（只看 turn/start）。
 * 空白会话一旦被写入开场白，英雄区（含模式选择）会因可见内容消失，
 * 「新对话」却仍复用该会话，表现为永远卡在 Tavern。
 */
/** ensureGreeting / swipeGreeting 写入的开场白来源标记。 */
export const TAVERN_GREETING_SOURCE = { provider: 'dsh-tavern', model: 'greeting' };
function greetingSource(event) {
    if (event.data === null || typeof event.data !== 'object')
        return undefined;
    const message = event.data.message;
    return message?.source;
}
export function isTavernGreetingEvent(event) {
    if (event.type !== 'assistant/message')
        return false;
    const source = greetingSource(event);
    return source?.provider === TAVERN_GREETING_SOURCE.provider && source?.model === TAVERN_GREETING_SOURCE.model;
}
/** 仍算 blank（无 turn/start）但已经有本插件开场白，会被「新对话」复用且藏掉英雄区。 */
export function isGreetingOnlyBlank(events) {
    if (events.some((event) => event.type === 'turn/start'))
        return false;
    return events.some(isTavernGreetingEvent);
}
export function sessionHasUserMessage(events) {
    return events.some((event) => event.type === 'user/message');
}
/**
 * 按绑定下标取开场白。空串 / 纯空白不算有开场白（不偷偷改用别的变体，以免和 swipe 下标错位）。
 * 下标越界时回退到变体 0。
 */
export function pickGreetingText(variants, index) {
    const direct = index >= 0 && index < variants.length ? variants[index] : variants[0];
    if (typeof direct === 'string' && direct.trim() !== '')
        return direct;
    return undefined;
}
function greetingMessageId(event) {
    if (event.data === null || typeof event.data !== 'object')
        return undefined;
    return event.data.message?.id;
}
/**
 * 开场白楼层判定：只有「第一条 assistant 消息且来源是本插件 greeting」才算开场白。
 * 对话开始后仍识别为开场白（好让 UI 藏掉重新生成/编辑），但 swipe 为 null。
 */
export function greetingFloorState(events, messageId, greetingIndex, variantCount) {
    const started = sessionHasUserMessage(events);
    const none = { isGreeting: false, started, swipe: null };
    if (!messageId)
        return none;
    const hit = events.find((event) => event.type === 'assistant/message');
    if (!hit || !isTavernGreetingEvent(hit) || greetingMessageId(hit) !== messageId)
        return none;
    const total = Math.max(0, variantCount);
    // 越界一律回退变体 0，与 pickGreetingText 保持一致：
    // 这里若改成夹到 total - 1，UI 报的位次就和实际渲染的正文对不上，两个 swipe 箭头会都指向当前这条。
    const index = greetingIndex >= 0 && greetingIndex < total ? greetingIndex : 0;
    return {
        isGreeting: true,
        started,
        swipe: !started && total >= 2 ? { index, total } : null,
    };
}
