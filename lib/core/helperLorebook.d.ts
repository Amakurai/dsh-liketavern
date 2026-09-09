/** 旧 lorebook 字段适配器；有界 JSON 先校验，局部更新保留原条目及现代接口额外字段。可序列化到沙箱。 */
import type { HelperWorldbookEntry } from './helperWorldbook.js';
export interface HelperLorebookEntry {
    uid: number;
    display_index: number;
    comment: string;
    enabled: boolean;
    type: HelperWorldbookEntry['strategy']['type'];
    position: string;
    depth: number | null;
    order: number;
    probability: number;
    keys: string[];
    logic: HelperWorldbookEntry['strategy']['keys_secondary']['logic'];
    filters: string[];
    scan_depth: 'same_as_global' | number;
    case_sensitive: 'same_as_global' | boolean;
    match_whole_words: 'same_as_global' | boolean;
    use_group_scoring: 'same_as_global' | boolean;
    automation_id: string | null;
    exclude_recursion: boolean;
    prevent_recursion: boolean;
    delay_until_recursion: boolean | number;
    content: string;
    group: string;
    group_prioritized: boolean;
    group_weight: number;
    sticky: number | null;
    cooldown: number | null;
    delay: number | null;
}
export type HelperLorebookCodec = ReturnType<typeof createHelperLorebookCodec>;
export declare function createHelperLorebookCodec(json: (value: unknown, maxBytes: number) => unknown): {
    toLegacy: (entry: HelperWorldbookEntry, index?: number) => HelperLorebookEntry;
    replace: (input: unknown, before?: HelperWorldbookEntry[]) => unknown[];
    patch: (input: unknown, before: HelperWorldbookEntry[]) => unknown[];
    uid: (value: unknown) => number;
    list: (input: unknown) => Record<string, unknown>[];
    ids: (input: unknown) => number[];
    filter: (entries: HelperLorebookEntry[], input: unknown) => HelperLorebookEntry[];
};
