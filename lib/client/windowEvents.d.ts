/**
 * 客户端共享 window 自定义事件分发器：长历史同时挂载数十个聊天气泡、操作条与头部控件时，
 * 不在 window 上重复注册成百上千个监听器。每个事件名在同一个 window 实例上只挂 1 个监听器，
 * 按路由键（sessionId 或 cardId）以及可选的无 detail 全局广播做 O(1) 分发；按 EventTarget
 * WeakMap 隔离，兼容单测替换全局 window 的场景。
 */
export type KeyedWindowEventCallback = () => void;
export declare function subscribeKeyedWindowEvent(eventName: string, key: string, acceptEmptyDetail: boolean, callback: KeyedWindowEventCallback): () => void;
