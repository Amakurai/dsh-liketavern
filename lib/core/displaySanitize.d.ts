export declare const DISPLAY_META_TAGS: readonly ["UpdateVariable", "JSONPatch", "Analysis", "think", "thinking", "StatusPlaceHolderImpl"];
/** 只删除机读块及其内容；不 trim，也不处理 details/style/widget/透明协议壳。 */
export declare function stripOpaqueDisplayMeta(text: string, removeComments?: boolean): string;
/** 跨有序片段延续机读标签状态，再把保留内容映射回原 kind/title。 */
export declare function stripOpaqueDisplayMetaParts<T extends {
    text: string;
}>(parts: readonly T[], removeComments?: boolean, separator?: string): T[];
/** 去掉展示不该看见的机读块与小部件；角色正文保留。 */
export declare function stripDisplayMeta(text: string): string;
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
};
