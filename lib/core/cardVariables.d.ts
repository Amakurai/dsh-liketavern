/** 卡内变量兼容：完全运行于无同源权限的 iframe；维护同步变量快照，并提供文本备份/恢复；真实会话通过独立持久层提交。 */
export interface CardVariableLabels {
    title: string;
    note: string;
    backup: string;
    text: string;
    editor?: string;
    scope?: string;
    messageId?: string;
    editorText?: string;
    load?: string;
    validate?: string;
    save?: string;
    discard?: string;
    valid?: string;
    saved?: string;
    localSaved?: string;
    saving?: string;
    unsaved?: string;
    conflict?: string;
    failed?: string;
    timeout?: string;
    scopeGlobal?: string;
    scopePreset?: string;
    scopeCharacter?: string;
    scopeChat?: string;
    scopeMessage?: string;
}
/** 用户在宿主对话框中粘贴备份后验证，再注入新的 iframe；真实会话恢复后的变量仍须通过剧情提交协议。 */
export declare function restoreCardVariableBackup(srcDoc: string, text: string): string;
/** 自包含函数会被序列化注入沙箱，不引用宿主状态，不发送主窗口消息。 */
export declare function installCardVariables(labels: CardVariableLabels, styles?: string, messageId?: number, messageCount?: number, showTools?: boolean): void;
