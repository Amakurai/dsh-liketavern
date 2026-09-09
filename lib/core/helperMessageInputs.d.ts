/** 消息读写往返适配：合并完整页集合与旧别名，验证只读字段并拒绝矛盾的新值。 */
import { helperJson } from './helperRuntime.js';
import { parseHelperSwipes } from './helperSwipes.js';
import type { HelperMessageTextEdit } from './helperChatEdits.js';
export declare function normalizeHelperMessageInputs(input: unknown, lookup: (id: number) => Record<string, unknown> | undefined, json?: typeof helperJson, codec?: typeof parseHelperSwipes): HelperMessageTextEdit[];
