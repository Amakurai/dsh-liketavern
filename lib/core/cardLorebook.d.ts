/** 旧 lorebook 浏览器接口复用现代世界书业务桥；updater 在沙箱执行，局部更新保留未指定条目和字段。 */
import type { HelperWorldbookEntry } from './helperWorldbook.js';
import type { HelperLorebookCodec } from './helperLorebook.js';
interface WorldbookApi {
    getWorldbookNames(): string[];
    getCharWorldbookNames(character: string): {
        primary: string | null;
        additional: string[];
    };
    rebindCharWorldbooks(character: string, input: unknown, partial?: boolean): Promise<void>;
    rebindChatWorldbook(chat: string, input: unknown): Promise<void>;
    getChatWorldbookName(chat: string): string | null;
    getOrCreateChatWorldbook(chat: string, label?: string): Promise<string>;
    createWorldbook(book: string, entries?: unknown): Promise<boolean>;
    deleteWorldbook(book: string): Promise<boolean>;
    getWorldbook(book: string): Promise<HelperWorldbookEntry[]>;
    updateWorldbookWith(book: string, updater: (entries: HelperWorldbookEntry[]) => unknown): Promise<HelperWorldbookEntry[]>;
    createWorldbookEntries(book: string, input: unknown): Promise<{
        worldbook: HelperWorldbookEntry[];
        new_entries: HelperWorldbookEntry[];
    }>;
    deleteWorldbookEntries(book: string, predicate: (entry: HelperWorldbookEntry) => boolean): Promise<{
        worldbook: HelperWorldbookEntry[];
        deleted_entries: HelperWorldbookEntry[];
    }>;
}
export declare function installCardLorebook(modern: WorldbookApi, codec: HelperLorebookCodec): void;
export {};
