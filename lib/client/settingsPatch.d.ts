/** 设置表单的字段补丁、草稿合并与宿主写保护错误格式化：只提交实际编辑项，数组整体替换，保留服务器最新的未编辑字段。 */
type Fields = Record<string, unknown>;
/** 识别宿主因命令行 --patch 或主目录配置补丁（home overlay）拒绝保存配置时的错误。 */
export declare function isSettingsOverlayProtectedError(message: string): boolean;
/** 为宿主配置 overlay 写保护错误附加清晰的本地化解释与操作指引，同时保留原始报错文本。 */
export declare function formatSettingsWriteError(message: string, translate: (key: 'settings.overlayWriteProtected') => string): string;
export declare function changedSettingsPatch(current: Fields, baseline: unknown): Fields;
export declare function applySettingsPatch<T extends object>(current: T, patch: Fields): T;
export {};
