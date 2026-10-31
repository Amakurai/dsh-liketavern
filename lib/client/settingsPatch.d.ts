/** 设置表单的字段补丁与草稿合并：只提交实际编辑项，数组整体替换，保留服务器最新的未编辑字段。 */
type Fields = Record<string, unknown>;
export declare function changedSettingsPatch(current: Fields, baseline: unknown): Fields;
export declare function applySettingsPatch<T extends object>(current: T, patch: Fields): T;
export {};
