/** 剧情 sticky 注册表的数据契约；闭包只保存沙箱引用标识，必须由执行日志重建后才能恢复。 */
export interface TemplateStickyPrompt {
    key: string;
    uid: string;
    prompt: string;
    order: number;
    sticky: number;
}
export interface TemplateStickyRegex {
    uuid: string;
    source: string;
    flags: string;
    sticky: number;
    revision: number;
    replacement: {
        kind: 'text';
        value: string;
    } | {
        kind: 'callback';
        id: number;
        identity: string;
    };
    options: Record<string, string | number | boolean | null>;
}
export interface TemplateStickyState {
    version: 1;
    revision: number;
    callbackSerial: number;
    prompts: TemplateStickyPrompt[];
    regex: {
        basic: TemplateStickyRegex[];
        generate: TemplateStickyRegex[];
        message: TemplateStickyRegex[];
    };
    tombstones: {
        prompts: {
            key: string;
            uid: string;
        }[];
        basic: string[];
        generate: string[];
        message: string[];
    };
}
/** 解析完全来自数据边界的对象，拒绝重复身份、额外字段与无界计数。 */
export declare function parseTemplateStickyState(value: unknown): TemplateStickyState;
export declare function hasTemplateStickyClosures(state: TemplateStickyState): boolean;
