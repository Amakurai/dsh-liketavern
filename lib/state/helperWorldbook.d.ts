import { type HelperWorldbookEntry } from '../core/helperWorldbook.js';
export declare function readHelperWorldbook(input: unknown): {
    entries: HelperWorldbookEntry[];
    originalIds: Map<number, string>;
};
export declare function writeHelperWorldbook(input: unknown, previous?: unknown): unknown;
