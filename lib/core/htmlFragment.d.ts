/**
 * code/pre 只是代码示例的启发式边界，浏览器里仍是普通元素：正文提到未闭合的 `<code>`
 * 时只忽略这个开标签，不能让后续真实卡面全部失去识别。
 */
export declare const LENIENT_OPAQUE: Set<string>;
/**
 * 跳过不会在当前脚本环境中成为活动 DOM 的内容区。template 允许合理嵌套；其中的
 * script/style/noscript 字节也不能伪造 template 闭标签。其它既有 RAW_TEXT 仍沿用
 * 浏览器遇到首个同名闭标签即结束的边界。
 */
export declare function findHtmlOpaqueEnd(text: string, contentStart: number, tag: string): number | null;
/** 完整文档也按标签扫描；注释、代码示例与 script/style 字符串不参与文档边界判断。 */
export declare function findHtmlDocument(text: string): {
    start: number;
    end: number;
} | null;
/** 是否包含真实完整文档边界；扫描会跳过注释、Markdown 代码及 script/style 字符串。 */
export declare function isFullHtmlDocument(text: string): boolean;
export declare function findHtmlFragment(text: string): {
    start: number;
    end: number;
} | null;
