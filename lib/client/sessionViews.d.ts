/** 登记一个正在显示的会话；返回撤销函数（幂等）。 */
export declare function markSessionView(sessionId: string, tavern: boolean): () => void;
export declare function isSessionShown(sessionId: string): boolean;
/** 是否有任何会话处于显示状态（无会话 hero 判定用）。 */
export declare function hasShownSession(): boolean;
/** 最近登记且仍在显示的 Tavern 会话。 */
export declare function currentTavernSession(): string | undefined;
export declare function isTavernSessionShown(sessionId: string): boolean;
export declare function subscribeSessionViews(listener: () => void): () => void;
/** 组件挂载期间登记其会话；Tavern 模式切换时重新登记。 */
export declare function useSessionView(sessionId: string, tavern: boolean): void;
/** 供安装函数注入的最小视图接口（测试可替换）。 */
export interface SessionViewsPort {
    currentTavernSession(): string | undefined;
    isTavernSessionShown(sessionId: string): boolean;
    isSessionShown(sessionId: string): boolean;
    hasShownSession(): boolean;
    subscribe(listener: () => void): () => void;
}
export declare const sessionViews: SessionViewsPort;
