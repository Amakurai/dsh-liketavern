export type TemplateDisplayPart = {
    kind: 'markdown';
    text: string;
} | {
    kind: 'html';
    text: string;
    title?: string;
};
export declare function parseTemplateDisplayParts(value: unknown): TemplateDisplayPart[];
/** 利用已有 HTML 识别规则定位原始子串，再分别拆分两侧，避免聚合 htmls 时将尾部卡面移到前面。 */
export declare function splitTemplateDisplay(text: string, preserveMeta?: boolean): TemplateDisplayPart[];
