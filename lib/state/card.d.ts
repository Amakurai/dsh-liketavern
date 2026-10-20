/**
 * SillyTavern 角色卡解析。
 * 支持 PNG 内嵌 tEXt / zTXt / iTXt（关键字 chara / ccv3）与纯 JSON 卡，统一归一化为 CharacterCard。
 * 零第三方依赖：PNG chunk 遍历手写实现；读取不校验 CRC，写出时补 CRC 以便其它工具能打开。
 * 第三方卡文件不可信且全部在主进程同步解析：导入入口设字节数硬上限，
 * zTXt/iTXt 解压设输出上限（压缩炸弹防御），超限一律抛 CardParseError。
 */
import type { CardRegexScript, CharacterCard, LorebookFile } from '../core/types.js';
/** 角色卡解析失败时抛出，消息使用中文。 */
export declare class CardParseError extends Error {
    constructor(message: string);
}
/**
 * character_book → LorebookFile。
 * 兼容：对象（entries 为数组或 map）、顶层即为条目数组、JSON 字符串。
 */
export declare function normalizeBook(value: unknown): LorebookFile | null;
/** 从 data / 顶层 / extensions 挑出 regex_scripts（V3 卡常放在 extensions 里）。 */
export declare function pickRegexScripts(json: Record<string, unknown>, data: Record<string, unknown>): CardRegexScript[];
/** 已落盘的归一化卡也可能 regexScripts 为空，从 raw / extensions 补回。 */
export declare function regexScriptsOf(card: CharacterCard): CardRegexScript[];
/**
 * 用户拒绝导入内嵌世界书时的纯函数清洗：运行字段、兼容镜像和 raw 原文一起清除。
 * raw 仍保留未知 V3 字段与其它 extensions，不原地修改预检得到的卡对象。
 */
export declare function withoutEmbeddedCharacterBook(card: CharacterCard): CharacterCard;
/**
 * 工作区 card.json 的 UTF-8 字节上限，写入侧与 doctor/backup 共用，保证「运行时写得出，诊断读得进」。
 * 推导：导入闸 MAX_CARD_JSON_CHARS 按紧凑 JSON 的 UTF-16 码元计，每码元 UTF-8 至多 3 字节
 * （代理对 2 码元 → 4 字节），单份卡数据 ≤ 24 MiB；card.json 同时保存 raw、归一化字段与
 * characterBook（entries 与 raw 各序列化一次），世界书文本最多出现 3 份 → ≤ 72 MiB；
 * 再加 2 空格缩进与换行（随嵌套深度增长）取 128 MiB。世界书、脚本库等编辑可使 card.json
 * 超出导入时体积，故所有写入都经 serializeStoredCard 执行同一上限，超限在任何写入前明确拒绝。
 */
export declare const MAX_STORED_CARD_JSON_BYTES: number;
/** 序列化待落盘的 card.json（剔除 pngBytes 后的卡）；超出 MAX_STORED_CARD_JSON_BYTES 抛错。 */
export declare function serializeStoredCard(cardJson: Record<string, unknown>): string;
/** 工作区 card.json 是归一化卡；旧文件可能只有 extensions.depth_prompt。 */
export declare function hydrateStoredCard(record: Record<string, unknown>): CharacterCard;
/**
 * 解析 PNG 角色卡：遍历 chunk 找 tEXt / zTXt / iTXt（关键字 chara 或 ccv3，同时存在时优先 ccv3），
 * 其 text 为 Base64 编码的 UTF-8 JSON。读取不校验 CRC，遇 IEND 停止。
 */
export declare function parsePngCard(bytes: Uint8Array): CharacterCard;
/** 把角色卡 JSON 嵌进 PNG（去掉旧 chara/ccv3 块，在 IEND 前写入 tEXt）。无原图则用 1×1 占位图。 */
export declare function embedCardInPng(pngBytes: Uint8Array | null, json: unknown, spec: CharacterCard['spec']): Uint8Array;
/** 导出 SillyTavern 角色卡 JSON（V2 data 包装；V3 保持 spec）。 */
export declare function cardToStJson(card: CharacterCard): unknown;
/** 从编辑字段合成一张卡（保留内嵌书、正则、头像字节与 spec）。 */
export declare function applyCharacterPatch(card: CharacterCard, patch: Partial<Pick<CharacterCard, 'name' | 'description' | 'personality' | 'scenario' | 'firstMes' | 'alternateGreetings' | 'mesExample' | 'systemPrompt' | 'postHistoryInstructions' | 'creatorNotes' | 'creator' | 'characterVersion' | 'tags' | 'depthPrompt'>>): CharacterCard;
export declare function createBlankCard(name: string): CharacterCard;
/** 解析 JSON 角色卡（.json 导入），无 PNG 字节。 */
export declare function parseJsonCard(json: unknown): CharacterCard;
