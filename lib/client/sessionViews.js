/**
 * 正在显示的会话登记表。
 *
 * 宿主 0.1.7 起会话列表快照不再公开 `current`（视图选择留在 UiSession 私有状态），
 * 旧的 `list.getSnapshot().current` 恒为 undefined，会让 assistant-step 永不接管、
 * 实时脚本事件与选项输入失效。会话作用域的组件（会话头部 chip、新会话英雄区）
 * 只在其会话被显示时挂载，因此由它们在挂载期间登记，替代已移除的宿主字段。
 *
 * 同一会话可被多个组件登记，按令牌计数；「当前 Tavern 会话」取最近登记且仍在显示的那一个。
 */
import { useEffect } from 'react';
const views = new Map();
const listeners = new Set();
let serial = 0;
let scheduled = false;
/** 登记发生在 React 提交阶段；合并到微任务里通知，避免在组件 effect 中同步改动 slot 注册。 */
function notify() {
    if (scheduled)
        return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        for (const listener of [...listeners])
            listener();
    });
}
/** 登记一个正在显示的会话；返回撤销函数（幂等）。 */
export function markSessionView(sessionId, tavern) {
    const token = Symbol(sessionId);
    views.set(token, { sessionId, tavern, serial: ++serial });
    notify();
    return () => {
        if (views.delete(token))
            notify();
    };
}
export function isSessionShown(sessionId) {
    for (const view of views.values())
        if (view.sessionId === sessionId)
            return true;
    return false;
}
/** 是否有任何会话处于显示状态（无会话 hero 判定用）。 */
export function hasShownSession() {
    return views.size > 0;
}
/** 最近登记且仍在显示的 Tavern 会话。 */
export function currentTavernSession() {
    let latest;
    for (const view of views.values())
        if (view.tavern && (!latest || view.serial > latest.serial))
            latest = view;
    return latest?.sessionId;
}
export function isTavernSessionShown(sessionId) {
    for (const view of views.values())
        if (view.tavern && view.sessionId === sessionId)
            return true;
    return false;
}
export function subscribeSessionViews(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/** 组件挂载期间登记其会话；Tavern 模式切换时重新登记。 */
export function useSessionView(sessionId, tavern) {
    useEffect(() => markSessionView(sessionId, tavern), [sessionId, tavern]);
}
export const sessionViews = {
    currentTavernSession,
    isTavernSessionShown,
    isSessionShown,
    hasShownSession,
    subscribe: subscribeSessionViews,
};
