/**
 * 消息操作栏状态批处理：同一时刻挂载的多条 assistant 操作条（长对话首屏、向上翻页、分支切换）
 * 在一个宏任务窗口内合并为单次 getFloorActionStates，服务端共享一次会话事件快照、一次开场白变体读取
 * 与一次工作区锁内的分支兄弟校验，消除 2N 次独立 RPC 与 O(N·E) 重复事件扫描。
 * 当旧版宿主或局部测试桩未提供 getFloorActionStates 时，自动退回 getGreetingSwipe + getFloorSiblings。
 */
import { describeError } from '../core/guards.js';
import { FLOOR_ACTION_BATCH_MAX } from '../remote.js';
const queues = new Map();
function failure(message) {
    return { ok: false, error: { code: 'floor-state-failed', message } };
}
async function fallbackSingle(remote, request) {
    try {
        const [greeting, siblings] = await Promise.all([
            remote.getGreetingSwipe(request),
            remote.getFloorSiblings(request),
        ]);
        if (!greeting.ok)
            return greeting;
        if (!siblings.ok)
            return siblings;
        return {
            ok: true,
            value: {
                greeting: greeting.value,
                siblings: siblings.value,
                canContinue: !greeting.value.isGreeting,
            },
        };
    }
    catch (error) {
        return failure(describeError(error));
    }
}
export function floorActionStateBatched(remote, request) {
    if (typeof remote.getFloorActionStates !== 'function') {
        return fallbackSingle(remote, request);
    }
    return new Promise((resolve) => {
        let sessions = queues.get(remote);
        if (!sessions) {
            sessions = new Map();
            queues.set(remote, sessions);
            setTimeout(() => flush(remote), 0);
        }
        const list = sessions.get(request.sessionId) ?? [];
        list.push({ request, resolve });
        sessions.set(request.sessionId, list);
    });
}
function flush(remote) {
    const sessions = queues.get(remote);
    queues.delete(remote);
    if (!sessions)
        return;
    for (const [sessionId, pending] of sessions) {
        for (let start = 0; start < pending.length; start += FLOOR_ACTION_BATCH_MAX) {
            const chunk = pending.slice(start, start + FLOOR_ACTION_BATCH_MAX);
            // 同一窗口内若同一 messageId 重复请求，去重发信后再按原顺序扇出。
            const uniqueIds = [];
            const indexById = new Map();
            for (const { request } of chunk) {
                if (!indexById.has(request.messageId)) {
                    indexById.set(request.messageId, uniqueIds.length);
                    uniqueIds.push(request.messageId);
                }
            }
            void Promise.resolve()
                .then(() => remote.getFloorActionStates({ sessionId, messageIds: uniqueIds }))
                .then((response) => {
                if (!response.ok) {
                    for (const item of chunk)
                        item.resolve(response);
                    return;
                }
                for (const item of chunk) {
                    const idx = indexById.get(item.request.messageId);
                    const state = idx !== undefined ? response.value.items[idx] : undefined;
                    item.resolve(state ? { ok: true, value: state } : failure('批量楼层状态缺少该消息'));
                }
            })
                .catch((error) => {
                const err = failure(describeError(error));
                for (const item of chunk)
                    item.resolve(err);
            });
        }
    }
}
