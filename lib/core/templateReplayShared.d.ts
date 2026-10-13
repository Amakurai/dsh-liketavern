import type { TemplateReplayShared } from './templateReplay.js';
export type TemplateReplayJsonShared = {
    jsonArray: number[];
} | {
    jsonObject: Array<[string, number]>;
} | {
    jsonArrayPages: number[];
} | {
    jsonObjectPages: number[];
};
export declare const TEMPLATE_REPLAY_JSON_PAGE = 64;
export declare function templateReplayJsonVisits(value: unknown, limit?: number): number;
/** 内容摘要只用于相等节点去重；节点保留原键序，分页根只复制少量页引用。 */
export declare class TemplateReplayJsonWriter {
    private readonly nodes;
    private readonly values;
    private readonly objectBoundaries;
    private readonly shared;
    private readonly digest;
    private readonly appended;
    constructor(shared: TemplateReplayShared[], digest: (text: string) => string, appended: (chars: number) => void);
    private intern;
    private pages;
    /** 内容决定边界，插入/裁剪后在下一锚点重新对齐；最大页长限制最坏节点大小。 */
    private partition;
    private objectBoundary;
    write(value: unknown, json?: string): number;
    private writeNew;
}
/** 每个节点都必须独立可安全展开；不能用很小的引用图放大成无限对象或绕过输入计量。 */
export declare function templateReplaySharedReader(shared: TemplateReplayShared[]): {
    sizes: number[];
    expand: (index: number) => unknown;
    measure: (index: number, length?: number) => {
        chars: number;
        visits: number;
    };
};
