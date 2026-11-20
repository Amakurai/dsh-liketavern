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
