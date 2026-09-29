/** 只处理真实边界跨过的代码段；真正 HTML 卡面内部的 JavaScript 反引号不是 Markdown。 */
export declare function continuedMarkdown(previous: string, current: string): {
    start: number;
    text: string;
} | undefined;
