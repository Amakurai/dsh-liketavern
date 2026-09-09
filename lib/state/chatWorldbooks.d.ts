export declare const CHAT_WORLDBOOK_PATH = "assets/chat-lorebook.json";
export declare const CHAT_WORLDBOOK_META = "dsh_tavern_chat_books";
export declare const CHAT_WORLDBOOK_TOTAL_BYTES: number;
export interface ChatWorldbooks {
    active: string | null;
    books: Map<string, unknown>;
}
export declare function chatWorldbookId(ref: string): string | null;
export declare function chatWorldbookRef(value: string): string;
export declare function plainChatWorldbook(value: unknown): unknown;
export declare function decodeChatWorldbooks(input: unknown | null): ChatWorldbooks;
export declare function parseChatWorldbookFile(text: string | null): ChatWorldbooks;
export declare function encodeChatWorldbooks(store: ChatWorldbooks): unknown | null;
