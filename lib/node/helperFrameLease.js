/** 服务端卡面租约：新运行时入站立即撤销旧许可；写锁内在提交开始前复核，断开和失败记录有界清理。 */
import { randomUUID } from 'node:crypto';
import { displaySessionEventAt, readDisplaySessionEvents } from './sessionEvents.js';
const MAX_FRAMES = 1024;
const CLOSED_RETENTION_MS = 15 * 60 * 1000;
const records = new WeakMap();
const bindingKey = (binding) => JSON.stringify(binding);
function mapFor(state) {
    let map = records.get(state);
    if (!map) {
        map = new Map();
        records.set(state, map);
    }
    for (const [key, value] of map)
        if (value.closedAt !== undefined && Date.now() - value.closedAt > CLOSED_RETENTION_MS)
            map.delete(key);
    return map;
}
function identity(request) {
    if (!request.sessionId || !Number.isSafeInteger(request.messageId) || request.messageId < 0 || !Number.isSafeInteger(request.epoch) || request.epoch < 1 || request.epoch > 2147483647
        || typeof request.frameId !== 'string' || request.frameId.length < 8 || request.frameId.length > 96
        || typeof request.runtimeId !== 'string' || request.runtimeId.length < 1 || request.runtimeId.length > 96)
        throw new Error('卡面运行时身份无效');
}
function liveFrameCount(map) {
    let live = 0;
    for (const value of map.values())
        if (!value.closed)
            live++;
    return live;
}
/** 墓碑总量与活动连接共用同一总量上界：超限时淘汰最旧墓碑，断开风暴不能让记录无界增长。 */
function evictStaleTombstones(map) {
    while (map.size >= MAX_FRAMES) {
        let oldest;
        for (const [key, value] of map)
            if (value.closed) {
                oldest = key;
                break;
            }
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
export async function openHelperFrame(ctx, state, request) {
    identity(request);
    const map = mapFor(state), old = map.get(request.frameId);
    if (old && (old.sessionId !== request.sessionId || old.messageId !== request.messageId || request.epoch <= old.epoch))
        throw new Error('卡面运行时连接已失效');
    // 已关闭的墓碑只用于拒绝迟到旧连接（CLOSED_RETENTION_MS 内），不占连接预算：
    // 卡面刷新会不断产生新 frameId，把墓碑计入会让关闭旧卡面也释放不了预算，新帧被误拒。
    if (!old && map.size >= MAX_FRAMES) {
        if (liveFrameCount(map) >= MAX_FRAMES)
            throw new Error('卡面运行时连接超过 1024 个的接口预算，请关闭旧卡面后重试');
        evictStaleTombstones(map);
    }
    // 先替换记录，不能把失效操作排到旧写入占用的剧情/会话队列之后。
    const record = { ...request, closed: false, closedAt: Date.now() };
    map.set(request.frameId, record);
    try {
        const binding = await state.loadBindingUnwaited(request.sessionId, true);
        if (!binding?.storyId || binding.storyId !== request.storyId)
            throw new Error('卡面剧情绑定已经改变');
        if (!state.config.interactiveCards || binding.interactiveCards === false)
            throw new Error('交互卡已关闭');
        // 气泡并发连接只按固定 seq 验证目标，避免每个 iframe 再扫描并复制整份历史。
        const event = displaySessionEventAt(await readDisplaySessionEvents(ctx, request.sessionId), request.messageId);
        if (event?.type !== 'assistant/message' || event.surfaceOp !== undefined && event.surfaceOp !== 'append'
            || !event.data.message.content.some(block => block.type === 'text' && block.text.trim()))
            throw new Error('卡面消息不在当前剧情中');
        const current = await state.loadBindingUnwaited(request.sessionId, true);
        if (!current || bindingKey(current) !== bindingKey(binding) || !state.config.interactiveCards)
            throw new Error('卡面连接期间绑定已经改变');
        if (map.get(request.frameId) !== record || record.closed)
            throw new Error('卡面运行时连接已失效');
        record.token = randomUUID();
        record.binding = bindingKey(binding);
        delete record.closedAt;
        return { token: record.token };
    }
    catch (error) {
        // 保留本次 epoch 的断开墓碑；迟到的旧连接不能恢复被撤销的令牌。
        if (map.get(request.frameId) === record) {
            delete record.token;
            record.closed = true;
            record.closedAt = Date.now();
        }
        throw error;
    }
}
export function closeHelperFrame(state, request) {
    identity(request);
    const record = mapFor(state).get(request.frameId);
    if (!record || record.sessionId !== request.sessionId || record.messageId !== request.messageId || record.runtimeId !== request.runtimeId || record.epoch !== request.epoch
        || request.token !== undefined && record.token !== request.token)
        return;
    delete record.token;
    record.closed = true;
    record.closedAt = Date.now();
}
export function helperFrameWriteGuard(state, scope, lease) {
    if (lease === undefined)
        return undefined; // 可信设置面板沿用原业务入口；iframe 宿主总是注入私有租约。
    return binding => {
        const record = mapFor(state).get(lease.frameId);
        if (!record?.token || record.readOnly || record.token !== lease.token || record.runtimeId !== lease.runtimeId || record.epoch !== lease.epoch
            || record.sessionId !== scope.sessionId || scope.messageId !== undefined && record.messageId !== scope.messageId
            || scope.storyId !== undefined && record.storyId !== scope.storyId || record.storyId !== binding.storyId
            || record.binding !== bindingKey(binding) || !state.config.interactiveCards || binding.interactiveCards === false)
            throw new Error('卡面运行时租约已失效，请重新加载卡面');
    };
}
