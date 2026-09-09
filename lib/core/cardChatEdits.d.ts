import type { HelperMessageTextEdit } from './helperChatEdits.js';
export declare function installCardChatEdits(parse: (input: unknown, lookup: (id: number) => Record<string, unknown> | undefined) => HelperMessageTextEdit[], json: (input: unknown) => unknown): () => void;
