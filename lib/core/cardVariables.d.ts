/** 卡内变量兼容：完全运行于无同源权限的 iframe；只维护当前卡面临时数据，并提供文本备份/恢复。 */
export interface CardVariableLabels {
    title: string;
    note: string;
    backup: string;
    text: string;
}
/** 用户在宿主对话框中粘贴备份后验证，再注入新的 iframe；没有卡片到主窗口的存储桥。 */
export declare function restoreCardVariableBackup(srcDoc: string, text: string): string;
/** 自包含函数会被序列化注入沙箱，不引用宿主状态，不发送主窗口消息。 */
export declare function installCardVariables(labels: CardVariableLabels, styles?: string): void;
