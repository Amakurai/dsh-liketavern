/**
 * SillyTavern 角色卡解析。
 * 支持 PNG 内嵌 tEXt 块（关键字 chara / ccv3）与纯 JSON 卡，统一归一化为 CharacterCard。
 * 零第三方依赖：PNG chunk 遍历手写实现，不校验 CRC；zTXt/iTXt 压缩块不支持。
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
 * 解析 PNG 角色卡：遍历 chunk 找 tEXt（关键字 chara 或 ccv3，同时存在时优先 ccv3），
 * 其 text 为 Base64 编码的 UTF-8 JSON。不校验 CRC，遇 IEND 停止。
 */
export declare function parsePngCard(bytes: Uint8Array): CharacterCard;
/** 解析 JSON 角色卡（.json 导入），无 PNG 字节。 */
export declare function parseJsonCard(json: unknown): CharacterCard;
/** 归一化入口：接受任意已解析 JSON（V1 平铺 / V2 / V3），pngBytes 为来源 PNG 或 null。 */
export declare function normalizeCard(json: unknown, pngBytes: Uint8Array | null): CharacterCard;
/** 提取问候语配图来源：PNG 卡自身即头像来源，JSON 卡为 null。 */
export declare function extractGreetingImages(card: CharacterCard): Uint8Array | null;
