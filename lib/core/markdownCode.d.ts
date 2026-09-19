export interface MarkdownFence {
    info: string;
    contentStart: number;
    contentEnd: number;
    end: number;
    closed: boolean;
    standalone: boolean;
}
export declare function markdownCodeScanner(text: string): {
    inlineEnd: (start: number) => number | null;
    fence: (start: number) => MarkdownFence | null;
};
