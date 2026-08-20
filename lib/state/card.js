/**
 * SillyTavern 角色卡解析。
 * 支持 PNG 内嵌 tEXt / zTXt / iTXt（关键字 chara / ccv3）与纯 JSON 卡，统一归一化为 CharacterCard。
 * 零第三方依赖：PNG chunk 遍历手写实现；读取不校验 CRC，写出时补 CRC 以便其它工具能打开。
 */
import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
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
function parseDepthPrompt(ext) {
    const raw = ext.depth_prompt;
    if (!isRecord(raw))
        return null;
    const prompt = toStr(raw.prompt);
    if (!prompt.trim())
        return null;
    const depth = toNum(raw.depth, 4);
    const roleRaw = raw.role;
    let role = 'system';
    if (roleRaw === 'user' || roleRaw === 1 || roleRaw === '1')
        role = 'user';
    else if (roleRaw === 'assistant' || roleRaw === 2 || roleRaw === '2')
        role = 'assistant';
    return { prompt, depth: Math.max(0, Math.round(depth)), role };
}
/** 工作区 card.json 是归一化卡；旧文件可能只有 extensions.depth_prompt。 */
export function hydrateStoredCard(record) {
    const card = { ...record, pngBytes: null };
    if (!card.depthPrompt) {
        const ext = isRecord(card.extensions) ? card.extensions : {};
        card.depthPrompt = parseDepthPrompt(ext);
    }
    return card;
}
function toNum(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return fallback;
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
        depthPrompt: parseDepthPrompt(extensions),
        pngBytes,
        raw: json,
    };
}
/**
 * 解析 PNG 角色卡：遍历 chunk 找 tEXt / zTXt / iTXt（关键字 chara 或 ccv3，同时存在时优先 ccv3），
 * 其 text 为 Base64 编码的 UTF-8 JSON。读取不校验 CRC，遇 IEND 停止。
 */
export function parsePngCard(bytes) {
    if (bytes.length < PNG_SIGNATURE.length ||
        !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
        throw new CardParseError('不是有效的 PNG 文件：文件签名不匹配');
    }
    let offset = PNG_SIGNATURE.length;
    let charaText = null;
    let ccv3Text = null;
    const take = (keyword, text) => {
        if (text === null || text === '')
            return;
        if (keyword === 'ccv3' && ccv3Text === null)
            ccv3Text = text;
        else if (keyword === 'chara' && charaText === null)
            charaText = text;
    };
    while (offset + 8 <= bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('latin1');
        const dataStart = offset + 8;
        if (length > bytes.length - dataStart - 4) {
            throw new CardParseError(`PNG 块 ${type} 长度畸形或文件被截断`);
        }
        const data = bytes.subarray(dataStart, dataStart + length);
        if (type === 'tEXt') {
            const parsed = parsePngTextChunk(data, 'tEXt');
            if (parsed)
                take(parsed.keyword, parsed.text);
        }
        else if (type === 'zTXt') {
            const parsed = parsePngTextChunk(data, 'zTXt');
            if (parsed)
                take(parsed.keyword, parsed.text);
        }
        else if (type === 'iTXt') {
            const parsed = parsePngTextChunk(data, 'iTXt');
            if (parsed)
                take(parsed.keyword, parsed.text);
        }
        if (type === 'IEND')
            break;
        offset = dataStart + length + 4; // 跳过 data 与 CRC
    }
    const text = ccv3Text ?? charaText;
    if (text === null) {
        throw new CardParseError('PNG 中未找到角色卡数据（tEXt/zTXt/iTXt 关键字 chara/ccv3）');
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
function parsePngTextChunk(data, type) {
    const sep = data.indexOf(0x00);
    if (sep < 0)
        return null;
    const keyword = Buffer.from(data.subarray(0, sep)).toString('latin1');
    if (keyword !== 'chara' && keyword !== 'ccv3')
        return null;
    try {
        if (type === 'tEXt') {
            return { keyword, text: Buffer.from(data.subarray(sep + 1)).toString('latin1') };
        }
        if (type === 'zTXt') {
            // keyword \0 compression_method compressed
            if (sep + 2 > data.length)
                return null;
            const method = data[sep + 1];
            if (method !== 0)
                return null;
            const inflated = inflateSync(Buffer.from(data.subarray(sep + 2)));
            return { keyword, text: inflated.toString('latin1') };
        }
        // iTXt: keyword \0 compression_flag \0 compression_method \0 language \0 translated \0 text
        let cursor = sep + 1;
        if (cursor + 2 > data.length)
            return null;
        const compressed = data[cursor] === 1;
        const method = data[cursor + 1];
        cursor += 2;
        const langEnd = data.indexOf(0x00, cursor);
        if (langEnd < 0)
            return null;
        cursor = langEnd + 1;
        const transEnd = data.indexOf(0x00, cursor);
        if (transEnd < 0)
            return null;
        const payload = data.subarray(transEnd + 1);
        if (compressed) {
            if (method !== 0)
                return null;
            const inflated = inflateSync(Buffer.from(payload));
            return { keyword, text: inflated.toString('utf8') };
        }
        return { keyword, text: Buffer.from(payload).toString('utf8') };
    }
    catch {
        return null;
    }
}
/** 1×1 透明 PNG，无原图时用来嵌卡。 */
const BLANK_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const b of bytes) {
        crc ^= b;
        for (let i = 0; i < 8; i++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++)
        header[4 + i] = type.charCodeAt(i);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(header.subarray(4, 8), 0);
    crcInput.set(data, 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(crcInput));
    const out = new Uint8Array(12 + data.length);
    out.set(header, 0);
    out.set(data, 8);
    out.set(crc, 8 + data.length);
    return out;
}
function isCardKeywordChunk(type, data) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt')
        return false;
    const sep = data.indexOf(0x00);
    if (sep < 0)
        return false;
    const keyword = Buffer.from(data.subarray(0, sep)).toString('latin1');
    return keyword === 'chara' || keyword === 'ccv3';
}
function textChunkBytes(keyword, b64) {
    return pngChunk('tEXt', Buffer.from(`${keyword}\0${b64}`, 'latin1'));
}
/** 把角色卡 JSON 嵌进 PNG（去掉旧 chara/ccv3 块，在 IEND 前写入 tEXt）。无原图则用 1×1 占位图。 */
export function embedCardInPng(pngBytes, json, spec) {
    const source = pngBytes && pngBytes.length >= PNG_SIGNATURE.length ? pngBytes : BLANK_PNG;
    if (!PNG_SIGNATURE.every((b, i) => source[i] === b)) {
        throw new CardParseError('不是有效的 PNG 文件：文件签名不匹配');
    }
    const b64 = Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    const extras = [textChunkBytes('chara', b64)];
    if (spec === 'chara_card_v3')
        extras.push(textChunkBytes('ccv3', b64));
    const kept = [source.subarray(0, PNG_SIGNATURE.length)];
    let offset = PNG_SIGNATURE.length;
    while (offset + 8 <= source.length) {
        const length = new DataView(source.buffer, source.byteOffset + offset, 4).getUint32(0);
        const type = Buffer.from(source.subarray(offset + 4, offset + 8)).toString('latin1');
        const dataStart = offset + 8;
        if (length > source.length - dataStart - 4)
            break;
        const data = source.subarray(dataStart, dataStart + length);
        const chunkEnd = dataStart + length + 4;
        if (type === 'IEND') {
            for (const extra of extras)
                kept.push(extra);
            kept.push(source.subarray(offset, chunkEnd));
            break;
        }
        if (!isCardKeywordChunk(type, data))
            kept.push(source.subarray(offset, chunkEnd));
        offset = chunkEnd;
    }
    const out = new Uint8Array(kept.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of kept) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
/** 导出 SillyTavern 角色卡 JSON（V2 data 包装；V3 保持 spec）。 */
export function cardToStJson(card) {
    const extensions = { ...card.extensions };
    if (card.depthPrompt) {
        extensions.depth_prompt = {
            prompt: card.depthPrompt.prompt,
            depth: card.depthPrompt.depth,
            role: card.depthPrompt.role,
        };
    }
    else {
        delete extensions.depth_prompt;
    }
    const data = {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.firstMes,
        alternate_greetings: card.alternateGreetings,
        mes_example: card.mesExample,
        system_prompt: card.systemPrompt,
        post_history_instructions: card.postHistoryInstructions,
        creator_notes: card.creatorNotes,
        creator: card.creator,
        character_version: card.characterVersion,
        tags: card.tags,
        extensions,
    };
    if (card.characterBook && card.characterBook.entries.length > 0) {
        data.character_book = card.characterBook.raw ?? {
            name: card.characterBook.name ?? card.name,
            entries: card.characterBook.entries,
        };
    }
    if (card.regexScripts.length > 0)
        data.regex_scripts = card.regexScripts;
    const spec = card.spec === 'chara_card_v1' || card.spec === 'unknown' ? 'chara_card_v2' : card.spec;
    return {
        spec,
        spec_version: spec === 'chara_card_v3' ? '3.0' : '2.0',
        data,
    };
}
/** 从编辑字段合成一张卡（保留内嵌书、正则、头像字节与 spec）。 */
export function applyCharacterPatch(card, patch) {
    const next = { ...card, ...patch };
    const extensions = { ...next.extensions };
    if (next.depthPrompt) {
        extensions.depth_prompt = {
            prompt: next.depthPrompt.prompt,
            depth: next.depthPrompt.depth,
            role: next.depthPrompt.role,
        };
    }
    else {
        delete extensions.depth_prompt;
    }
    next.extensions = extensions;
    next.raw = cardToStJson(next);
    return next;
}
export function createBlankCard(name) {
    const trimmed = name.trim() || '新角色';
    return normalizeCardInternal({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: trimmed,
            description: '',
            personality: '',
            scenario: '',
            first_mes: `你好，我是${trimmed}。`,
            alternate_greetings: [],
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: '',
            creator: '',
            character_version: '1',
            tags: [],
            extensions: {},
        },
    }, null, null);
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
