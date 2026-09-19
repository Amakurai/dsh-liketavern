/** 页面内脚本运行诊断：只存有界状态，不存代码、变量或剧情正文；卸载后清除对应会话。 */
export interface ScriptRuntimeStatus {
    sessionId: string;
    cardId: string;
    state: 'loading' | 'disabled' | 'waiting' | 'running' | 'error';
    error?: string;
    nativeMvu: boolean;
    mvuBusy?: boolean;
    mvuError?: string;
    scripts: {
        id: string;
        name: string;
        state: 'loading' | 'ready' | 'error';
        error?: string;
        native: boolean;
    }[];
}
/** 浏览器拒绝跨窗口读取时给出兼容说明；只用于展示，不改变失败状态或放行权限。 */
export declare function isScriptWindowAccessError(error: string | undefined): boolean;
export declare function retryScriptMvu(sessionId: string): void;
export declare const scriptStatusStore: {
    getSnapshot: () => readonly ScriptRuntimeStatus[];
    subscribe: (listener: () => void) => () => void;
};
export declare function publishScriptStatus(owner: symbol, status: ScriptRuntimeStatus, retry?: () => void): void;
export declare function clearScriptStatus(owner: symbol, sessionId: string): void;
