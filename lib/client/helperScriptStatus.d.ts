/** 页面内脚本运行诊断：只存有界状态，不存代码、变量或剧情正文；卸载后清除对应会话。 */
export interface ScriptRuntimeStatus {
    sessionId: string;
    cardId: string;
    state: 'loading' | 'disabled' | 'waiting' | 'running' | 'error';
    error?: string;
    nativeMvu: boolean;
    /** 绑定未表态且脚本含官方 MVU 入口：页面会在会话空闲时自动开启。 */
    mvuFollow?: boolean;
    mvuBusy?: boolean;
    mvuError?: string;
    mvuRestartRequired?: boolean;
    mvuCanCancel?: boolean;
    mvuCanceling?: boolean;
    mvuCancelError?: string;
    /** 后台脚本改写消息创建子分支后若自动导航失败，在此暴露错误与手动打开入口。 */
    editedBranchError?: string;
    editedBranchTitle?: string;
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
/** 设置页的取消等待入口；运行时已卸载时返回 false，不假装已取消。 */
export declare function cancelScriptMvu(sessionId: string): Promise<boolean>;
/** 后台脚本编辑分支导航失败后的手动打开入口。 */
export declare function openScriptEditedBranch(sessionId: string): Promise<boolean>;
/** 设置页的一键开启；运行时已卸载时返回 false 由调用方提示，不假装已开启。 */
export declare function enableScriptMvu(sessionId: string): Promise<boolean>;
export declare const scriptStatusStore: {
    getSnapshot: () => readonly ScriptRuntimeStatus[];
    subscribe: (listener: () => void) => () => void;
};
export declare function publishScriptStatus(owner: symbol, status: ScriptRuntimeStatus, retry?: () => void, enable?: () => Promise<void>, actions?: {
    cancel?: () => Promise<void>;
    openBranch?: () => Promise<void>;
}): void;
export declare function clearScriptStatus(owner: symbol, sessionId: string): void;
