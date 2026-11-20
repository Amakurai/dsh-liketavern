/** 是否为展示层应隐藏的机读块标签名（忽略大小写）。 */
export declare function isDisplayMetaTagName(name: string): boolean;
/** 只删除机读块及其内容；不 trim，也不处理 details/style/widget/透明协议壳。 */
export declare function stripOpaqueDisplayMeta(text: string, removeComments?: boolean): string;
/** 跨有序片段延续机读标签状态，再把保留内容映射回原 kind/title。 */
export declare function stripOpaqueDisplayMetaParts<T extends {
    text: string;
}>(parts: readonly T[], removeComments?: boolean, separator?: string): T[];
/** 同一卡面跨宿主续写消息仍是连续 HTML；脚本和属性语境不能在消息边界重置。 */
export declare function stripContinuedDisplayMetaParts<T extends {
    text: string;
}>(parts: readonly T[]): T[];
/** 是否为标准 HTML / SVG / MathML 元素名（忽略大小写）。 */
export declare function isKnownHtmlElementName(name: string): boolean;
/** 独立样式片段不应占一个空 iframe；跨过普通台词，将 CSS 交给下一张真正的卡面。 */
export declare function mergeDetachedCardStyles<T extends {
    kind: 'markdown' | 'html';
    text: string;
    title?: string;
}>(parts: readonly T[]): T[];
/** 展示层机读清理：保护 Markdown 代码示例里的伪/机读标签，同时仍清理 HTML 卡片和 HTML 围栏内的机读块。 */
export declare function stripDisplayOpaqueMeta(text: string, removeComments?: boolean): string;
/** 跨有序片段展示层机读清理：仅保护 Markdown 片段的代码示例，HTML 片段内反引号按原样 HTML 处理。 */
export declare function stripDisplayOpaqueMetaParts<T extends {
    kind?: 'markdown' | 'html';
    text: string;
}>(parts: readonly T[], removeComments?: boolean, separator?: string): T[];
/** 去掉展示不该看见的机读块与小部件；角色正文与 Markdown 代码示例保留。 */
export declare function stripDisplayMeta(text: string): string;
/** 流式正文只显示卡面前的台词；关闭交互卡时维持显式源码展示。 */
export declare function presentStreamingOutput(text: string, allowHtml: boolean): {
    text: string;
    pendingHtml: boolean;
};
/** 找到未闭合卡面的起点；已完成的卡面、普通台词与代码示例不因后面的半张卡而被收起。 */
export declare function findIncompleteHtmlStart(text: string): number | null;
/** 未闭合卡片只保留之前的内容，供显示提示；不补造 HTML、不运行脚本，也不修改存储原文。 */
export declare function hideIncompleteHtml(text: string): {
    text: string;
    pendingHtml?: true;
};
/** 交互卡关闭后的源码回退：围栏长于内容中的反引号，不能逃逸成可执行 HTML。 */
export declare function htmlSourceFallback(html: string): string;
/**
 * 正则渲染后的展示拆分：交互卡 HTML 进 iframe（可能连续多段），剩余正文再收起机读标签。
 * `allowHtml` 为 false 时整段当文本（交互卡开关关闭）。
 */
export declare function presentRenderedOutput(rendered: string, allowHtml: boolean): {
    html: string | null;
    htmls: string[];
    text: string;
    pendingHtml?: true;
};
