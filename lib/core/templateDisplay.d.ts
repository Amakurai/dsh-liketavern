export type TemplateDisplayPart = {
    kind: 'markdown';
    text: string;
} | {
    kind: 'html';
    text: string;
    title?: string;
};
export declare const TEMPLATE_DISPLAY_PARTS_VERSION: 1;
export declare function parseTemplateDisplayParts(value: unknown): TemplateDisplayPart[];
/** 利用已有 HTML 识别规则定位原始子串，再分别拆分两侧，避免聚合 htmls 时将尾部卡面移到前面。 */
export declare function splitTemplateDisplay(text: string, preserveMeta?: boolean): TemplateDisplayPart[];
/**
 * 对有序展示片段做一次跨片段机读清理；HTML 类型与折叠标题保持不变。
 * 模板首次生成和展示正则之后都调用，避免标签跨 markdown/html 边界时丢失状态。
 */
export declare function sanitizeTemplateDisplayParts(parts: readonly TemplateDisplayPart[]): TemplateDisplayPart[];
/** 会话/全局关闭交互卡时跨片段清理，再逐 HTML 段安全降级并保持顺序。 */
export declare function disableInteractiveParts(parts: readonly TemplateDisplayPart[]): TemplateDisplayPart[];
