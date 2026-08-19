/**
 * SillyTavern 角色卡解析。
 * 支持 PNG 内嵌 tEXt 块（关键字 chara / ccv3）与纯 JSON 卡，统一归一化为 CharacterCard。
 * 零第三方依赖：PNG chunk 遍历手写实现，不校验 CRC；zTXt/iTXt 压缩块不支持。
 */
import { Buffer } from 'node:buffer';
/** 角色卡解析失败时抛出，消息使用中文。 */
export class CardParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CardParseError';
    }
}
/** PNG 文件签名（8 字节固定魔数）。 */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 字段容错转 string：数字/布尔转字符串，对象 JSON.stringify，null/undefined → ''。 */
function toStr(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (value === null || value === undefined)
        return '';
    try {
        return JSON.stringify(value);
    }
    catch {
        return '';
    }
}
/** 字段容错转 string[]：非数组一律 []，元素逐个走 toStr。 */
function toStrArr(value) {
    return Array.isArray(value) ? value.map(toStr) : [];
}
/** 归一化时已消费的 data 字段；其余字段（含 V3 新增）落入 extensions。 */
const KNOWN_DATA_KEYS = new Set([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'alternate_greetings',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'creator_notes',
    'creator',
    'character_version',
    'tags',
    'character_book',
    'regex_scripts',
    'extensions',
]);
/** spec 判定：json.spec 优先，其次 PNG chunk 关键字 hint，再按 data 包装/顶层平铺推断。 */
function detectSpec(obj, hint) {
    const spec = obj.spec;
    if (spec === 'chara_card_v2' || spec === 'chara_card_v3' || spec === 'chara_card_v1')
        return spec;
    if (hint !== null)
        return hint;
    if (isRecord(obj.data))
        return 'chara_card_v2';
    return 'chara_card_v1';
}
/**
 * character_book → LorebookFile。
 * 兼容：对象（entries 为数组或 map）、顶层即为条目数组、JSON 字符串。
 */
export function normalizeBook(value) {
    if (value === null || value === undefined || value === '')
        return null;
    if (typeof value === 'string') {
        try {
            return normalizeBook(JSON.parse(value));
        }
        catch {
            return null;
        }
    }
    if (Array.isArray(value)) {
        if (value.length === 0)
            return null;
        return { entries: value, raw: { entries: value } };
    }
    if (!isRecord(value))
        return null;
    const rawEntries = value.entries;
    let entries;
    if (Array.isArray(rawEntries))
        entries = rawEntries;
    else if (isRecord(rawEntries))
        entries = Object.values(rawEntries);
    else
        entries = [];
    // 空壳（无条目且无书名）视为没有内嵌书，避免 UI 误报
    if (entries.length === 0 && typeof value.name !== 'string')
        return null;
    const book = { entries, raw: value };
    if (typeof value.name === 'string')
        book.name = value.name;
    return book;
}
/** 从 data / 顶层 / extensions 挑出 regex_scripts（V3 卡常放在 extensions 里）。 */
export function pickRegexScripts(json, data) {
    const dataExt = isRecord(data.extensions) ? data.extensions : null;
    const jsonExt = isRecord(json.extensions) ? json.extensions : null;
    const candidates = [
        data.regex_scripts,
        json.regex_scripts,
        dataExt?.regex_scripts,
        dataExt?.regexScripts,
        jsonExt?.regex_scripts,
        jsonExt?.regexScripts,
    ];
    for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0)
            return c;
    }
    return [];
}
/** 已落盘的归一化卡也可能 regexScripts 为空，从 raw / extensions 补回。 */
export function regexScriptsOf(card) {
    if (Array.isArray(card.regexScripts) && card.regexScripts.length > 0)
        return card.regexScripts;
    const raw = isRecord(card.raw) ? card.raw : {};
    const data = isRecord(raw.data) ? raw.data : {};
    const fromRaw = pickRegexScripts(raw, data);
    if (fromRaw.length > 0)
        return fromRaw;
    const ext = isRecord(card.extensions) ? card.extensions : {};
    return pickRegexScripts({ extensions: ext }, ext);
}
/** 从 V1/V2/V3 JSON 各常见落点挑出内嵌世界书（data / 顶层 / lorebook / extensions）。 */
function pickCharacterBook(json, data) {
    const ext = isRecord(data.extensions) ? data.extensions : isRecord(json.extensions) ? json.extensions : null;
    const candidates = [
        data.character_book,
        json.character_book,
        data.lorebook,
        json.lorebook,
        data.characterBook,
        json.characterBook,
        ext?.character_book,
        ext?.characterBook,
        ext?.world,
    ];
    for (const c of candidates) {
        const book = normalizeBook(c);
        if (book && book.entries.length > 0)
            return book;
    }
    return null;
}
function normalizeCardInternal(json, pngBytes, specHint) {
    if (!isRecord(json))
        throw new CardParseError('角色卡 JSON 不是对象');
    const spec = detectSpec(json, specHint);
    // V2/V3 取 data；data 缺失时回退顶层平铺（部分卡只有顶层字段）。V1 恒为顶层平铺。
    const data = spec !== 'chara_card_v1' && isRecord(json.data) ? json.data : json;
    const name = toStr(data.name);
    if (name === '')
        throw new CardParseError('角色卡缺少 name');
    // 未识别的其余字段（V3 新增字段、自定义字段）一律进 extensions。
    const extensions = {};
    if (isRecord(data.extensions))
        Object.assign(extensions, data.extensions);
    for (const [key, value] of Object.entries(data)) {
        if (!KNOWN_DATA_KEYS.has(key))
            extensions[key] = value;
    }
    return {
        spec,
        name,
        description: toStr(data.description),
        personality: toStr(data.personality),
        scenario: toStr(data.scenario),
        firstMes: toStr(data.first_mes),
        alternateGreetings: toStrArr(data.alternate_greetings),
        mesExample: toStr(data.mes_example),
        systemPrompt: toStr(data.system_prompt),
        postHistoryInstructions: toStr(data.post_history_instructions),
        creatorNotes: toStr(data.creator_notes),
        creator: toStr(data.creator),
        characterVersion: toStr(data.character_version),
        tags: toStrArr(data.tags),
        characterBook: pickCharacterBook(json, data),
        regexScripts: pickRegexScripts(json, data),
        extensions,
        pngBytes,
        raw: json,
    };
}
/**
 * 解析 PNG 角色卡：遍历 chunk 找 tEXt（关键字 chara 或 ccv3，同时存在时优先 ccv3），
 * 其 text 为 Base64 编码的 UTF-8 JSON。不校验 CRC，遇 IEND 停止。
 */
export function parsePngCard(bytes) {
    if (bytes.length < PNG_SIGNATURE.length ||
        !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
        throw new CardParseError('不是有效的 PNG 文件：文件签名不匹配');
    }
    let offset = PNG_SIGNATURE.length;
    let charaText = null;
    let ccv3Text = null;
    while (offset + 8 <= bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('latin1');
        const dataStart = offset + 8;
        if (length > bytes.length - dataStart - 4) {
            throw new CardParseError(`PNG 块 ${type} 长度畸形或文件被截断`);
        }
        if (type === 'tEXt') {
            // data = keyword(Latin-1) + 0x00 + text；无分隔符的畸形块跳过。
            const data = bytes.subarray(dataStart, dataStart + length);
            const sep = data.indexOf(0x00);
            if (sep >= 0) {
                const keyword = Buffer.from(data.subarray(0, sep)).toString('latin1');
                const text = Buffer.from(data.subarray(sep + 1)).toString('latin1');
                if (keyword === 'ccv3' && ccv3Text === null)
                    ccv3Text = text;
                else if (keyword === 'chara' && charaText === null)
                    charaText = text;
            }
        }
        if (type === 'IEND')
            break;
        offset = dataStart + length + 4; // 跳过 data 与 CRC
    }
    const text = ccv3Text ?? charaText;
    if (text === null) {
        throw new CardParseError('PNG 中未找到角色卡数据（tEXt 关键字 chara/ccv3）；zTXt/iTXt 压缩块暂不支持');
    }
    let json;
    try {
        json = JSON.parse(Buffer.from(text, 'base64').toString('utf-8'));
    }
    catch {
        throw new CardParseError('角色卡数据 Base64/JSON 解码失败');
    }
    return normalizeCardInternal(json, bytes, ccv3Text !== null ? 'chara_card_v3' : null);
}
/** 解析 JSON 角色卡（.json 导入），无 PNG 字节。 */
export function parseJsonCard(json) {
    return normalizeCardInternal(json, null, null);
}
/** 归一化入口：接受任意已解析 JSON（V1 平铺 / V2 / V3），pngBytes 为来源 PNG 或 null。 */
export function normalizeCard(json, pngBytes) {
    return normalizeCardInternal(json, pngBytes, null);
}
/** 提取问候语配图来源：PNG 卡自身即头像来源，JSON 卡为 null。 */
export function extractGreetingImages(card) {
    return card.pngBytes;
}
