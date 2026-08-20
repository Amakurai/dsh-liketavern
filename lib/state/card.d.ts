/**
 * SillyTavern 角色卡解析。
 * 支持 PNG 内嵌 tEXt / zTXt / iTXt（关键字 chara / ccv3）与纯 JSON 卡，统一归一化为 CharacterCard。
 * 零第三方依赖：PNG chunk 遍历手写实现；读取不校验 CRC，写出时补 CRC 以便其它工具能打开。
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
/** 归一化入口：接受任意已解析 JSON（V1 平铺 / V2 / V3），pngBytes 为来源 PNG 或 null。 */
export declare function normalizeCard(json: unknown, pngBytes: Uint8Array | null): CharacterCard;
/** 提取问候语配图来源：PNG 卡自身即头像来源，JSON 卡为 null。 */
export declare function extractGreetingImages(card: CharacterCard): Uint8Array | null;
