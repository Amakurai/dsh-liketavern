export interface MarkdownFence {
    info: string;
    contentStart: number;
    contentEnd: number;
    end: number;
    closed: boolean;
    standalone: boolean;
}
export interface MarkdownInlineSpan {
    start: number;
    end: number;
    width: number;
}
export declare function markdownCodeScanner(text: string): {
    inlineEnd: (start: number) => number | null;
    inlineSpan: (start: number) => MarkdownInlineSpan | null;
    fence: (start: number) => MarkdownFence | null;
};
/**
 * 识别文本中属于 GFM 表格的行号（0 基），跳过围栏代码块。
 * 放在 `markdownCodeScanner` 之外以保持扫描器本体无外部闭包依赖。
 */
export declare function findGfmTableLines(text: string, code?: ReturnType<typeof markdownCodeScanner>): Set<number>;
