/** 酒馆助手世界书契约及 JSON 校验：公开条目使用数值 UID，正则键以原生 /source/flags 文本跨沙箱传递。 */
import type { HelperLorebookSettings } from './helperWorldbookSettings.js';
import { type HelperTable } from './helperRuntime.js';
export declare const HELPER_WORLDBOOK_MAX_BYTES: number;
export declare const HELPER_CHARACTER_WORLDBOOK = "@dsh/character";
export declare const HELPER_CHAT_WORLDBOOK = "@dsh/chat";
export interface HelperWorldbookEntry {
    uid: number;
    name: string;
    enabled: boolean;
    content: string;
    probability: number;
    strategy: {
        type: 'constant' | 'selective' | 'vectorized';
        keys: string[];
        keys_secondary: {
            logic: 'and_any' | 'and_all' | 'not_all' | 'not_any';
            keys: string[];
        };
        scan_depth: 'same_as_global' | number;
    };
    position: {
        type: 'before_character_definition' | 'after_character_definition' | 'before_author_note' | 'after_author_note' | 'at_depth' | 'before_example_messages' | 'after_example_messages' | 'outlet';
        role: 'system' | 'assistant' | 'user';
        depth: number;
        order: number;
    };
    recursion: {
        prevent_incoming: boolean;
        prevent_outgoing: boolean;
        delay_until: number | null;
    };
    effect: {
        sticky: number | null;
        cooldown: number | null;
        delay: number | null;
    };
    extra: HelperTable;
}
export interface HelperWorldbookContext {
    storyId: string;
    bindingRevision: string;
    names: string[];
    global: string[];
    characterName: string;
    settings?: HelperLorebookSettings;
    character: {
        primary: string | null;
        additional: string[];
    };
    chat: string | null;
}
export interface HelperWorldbookSnapshot {
    name: string;
    revision: string;
    entries: HelperWorldbookEntry[];
}
export type HelperWorldbookOperation = 'get' | 'replace' | 'create' | 'upsert' | 'delete';
export interface HelperWorldbookRequest {
    storyId: string;
    bindingRevision: string;
    name: string;
    operation: HelperWorldbookOperation;
    revision?: string;
    entries?: unknown;
    label?: string;
}
export interface HelperWorldbookRebindRequest {
    storyId: string;
    bindingRevision: string;
    kind: 'global' | 'character' | 'chat' | 'ensure-chat' | 'settings';
    selection: unknown;
}
export interface HelperWorldbookResult {
    context?: HelperWorldbookContext;
    snapshot?: HelperWorldbookSnapshot;
    missing?: boolean;
    created?: boolean;
    deleted?: boolean;
}
/** 完全替换与新建的默认字段；拒绝错误类型和重复 UID，不在宿主求值任何脚本或正则。 */
export declare function parseHelperWorldbook(input: unknown): HelperWorldbookEntry[];
