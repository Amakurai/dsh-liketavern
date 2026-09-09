/** 卡面世界书接口：元数据同步读取，条目异步请求；updater/predicate 与 RegExp 转码仅在沙箱内执行。 */
import type { createHelperWorldbookSettingsCodec } from './helperWorldbookSettings.js';
import type { HelperWorldbookContext } from './helperWorldbook.js';
export declare function installCardWorldbook(initial: HelperWorldbookContext, json: (value: unknown, maxBytes: number) => unknown, settingsCodec: ReturnType<typeof createHelperWorldbookSettingsCodec>): () => void;
