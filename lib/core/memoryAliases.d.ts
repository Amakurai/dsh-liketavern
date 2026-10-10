/** 每条记忆最多保留的别名数与单个别名的长度上限（字）。 */
export declare const ALIAS_LIMIT = 8;
export declare const ALIAS_MAX_CHARS = 16;
/** 一次请求最多处理的记忆条数：控制单次辅助调用的长度，存量记忆分多次空闲补完。 */
export declare const ALIAS_BATCH = 12;
export interface AliasRecord {
    /** 生成别名时的正文指纹；与当前正文不符即作废。 */
    hash: string;
    aliases: string[];
}
/** 让模型为一批记忆写别名的提示词；序号从 1 起，与 parseAliasReply 对应。 */
export declare function buildAliasPrompt(bodies: readonly string[]): string;
/**
 * 清理一组别名：去掉包裹的引号括号与首尾标点，丢掉过长、空白、与正文相同、重复的，以及不该成为检索词的——
 * 单个虚词或假名、功能词（别名与 key 一样会把单个字、单个词声明为词，「什么」「他」混进来会让它们从此参与每次检索）。
 */
export declare function normalizeAliases(raw: readonly unknown[], body: string): string[];
/**
 * 解析模型回复：返回与输入等长的数组，没有对应行的位置为 null。
 * 同一序号出现多次只取第一次；序号越界、没有序号的行一律忽略——宁可少要，也不把解释性的话当成别名。
 */
export declare function parseAliasReply(text: string, bodies: readonly string[]): Array<string[] | null>;
/** 别名文件 → 记忆 id 到记录的映射。文件是派生数据：格式不对的整份或单条直接丢弃，等以后重新生成。 */
export declare function parseAliasFile(text: string): Map<string, AliasRecord>;
export declare function serializeAliasFile(records: ReadonlyMap<string, AliasRecord>): string;
