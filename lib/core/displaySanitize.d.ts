export declare const DISPLAY_META_TAGS: readonly ["UpdateVariable", "JSONPatch", "Analysis", "think", "thinking", "StatusPlaceHolderImpl"];
/** 去掉展示不该看见的机读块与小部件；角色正文保留。 */
export declare function stripDisplayMeta(text: string): string;
/**
 * 正则渲染后的展示拆分：交互卡 HTML 进 iframe（可能连续多段），剩余正文再收起机读标签。
 * `allowHtml` 为 false 时整段当文本（交互卡开关关闭）。
 */
export declare function presentRenderedOutput(rendered: string, allowHtml: boolean): {
    html: string | null;
    htmls: string[];
    text: string;
};
