import type { WorldInfoGlobalSettings } from './types.js';
export interface HelperLorebookSettings {
    selected_global_lorebooks: string[];
    scan_depth: number;
    context_percentage: number;
    budget_cap: number;
    min_activations: number;
    max_depth: number;
    max_recursion_steps: number;
    insertion_strategy: 'evenly' | 'character_first' | 'global_first';
    include_names: boolean;
    recursive: boolean;
    case_sensitive: boolean;
    match_whole_words: boolean;
    use_group_scoring: boolean;
    overflow_alert: boolean;
}
export declare function createHelperWorldbookSettingsCodec(json: (value: unknown, maxBytes: number) => unknown): {
    patch: (input: unknown) => Partial<HelperLorebookSettings>;
    toNative: (input: unknown) => Partial<WorldInfoGlobalSettings>;
    fromNative: (input: WorldInfoGlobalSettings, selected: string[]) => HelperLorebookSettings;
    nativePatch: (input: unknown) => Partial<WorldInfoGlobalSettings>;
};
export declare const helperWorldbookSettingsCodec: {
    patch: (input: unknown) => Partial<HelperLorebookSettings>;
    toNative: (input: unknown) => Partial<WorldInfoGlobalSettings>;
    fromNative: (input: WorldInfoGlobalSettings, selected: string[]) => HelperLorebookSettings;
    nativePatch: (input: unknown) => Partial<WorldInfoGlobalSettings>;
};
