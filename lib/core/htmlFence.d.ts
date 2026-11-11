import { markdownCodeScanner } from './markdownCode.js';
export declare function findHtmlFence(text: string, code?: ReturnType<typeof markdownCodeScanner>): {
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
} | null;
