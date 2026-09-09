/**
 * 世界书 JSON ⇄ 归一化 WorldInfoEntry。
 *
 * 兼容三种输入外形：
 * 1. SillyTavern 原生 World Info 文件：{entries: {"0": {...}}}（对象 map，map 键即 uid）。
 * 2. {entries: [...]}（数组；条目按字段特征逐个判定为原生 WI 或 character_book 形态）。
 * 3. 角色卡 character_book 的条目数组（顶层即数组，或 entries 为数组且条目带 keys/extensions 等特征）。
 *
 * 字段容错：字符串数字转 number、非 boolean 转 boolean；非法 position/selectiveLogic/role 回落默认；
 * 条目级 null（caseSensitive/matchWholeWords/scanDepth/sticky/cooldown/delay）保留 null = 跟随全局。
 *
 * 导入硬上限（第三方资产不可信，合法 JSON 也可能是体量炸弹）：条目数 / 单条正文 / 单键长度
 * 超限，或键容器、content 字段类型非法（会在下游 .map()/.includes() 处才炸的错型），
 * 一律在归一化时抛中文错误拒绝导入——统一拒绝口径，不做静默截断（截断会悄悄改写设定）。
 */
import { MAX_WI_KEY_CHARS } from '../core/worldbook.js';
/** 单文件条目数上限：社区大书在千级，2000 已留足余量。预设（presetStore）同口径复用。 */
export const MAX_LOREBOOK_ENTRIES = 2000;
/**
 * 单条正文字符数上限：≈2.5 万 token，超出任何合理条目。
 * 预设（presetStore）单条 prompt 正文同口径复用。
 */
export const MAX_LOREBOOK_CONTENT_CHARS = 100_000;
// ---------------------------------------------------------------------------
// 容错转换
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function toStr(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return '';
}
/** 字符串数组：非数组 → []，元素容错转字符串并丢弃空串。 */
function toStrArr(value) {
    if (!Array.isArray(value))
        return [];
    return value.map(toStr).filter((s) => s !== '');
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
/** 可空数字：null/undefined → null；旧格式布尔容错（true → 1，false → null）。 */
function toNumOrNull(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'boolean')
        return value ? 1 : null;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return null;
}
function toBool(value, fallback) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return value !== 0;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === '1')
            return true;
        if (s === 'false' || s === '0' || s === '')
            return false;
    }
    if (value === null || value === undefined)
        return fallback;
    return Boolean(value);
}
/** 可空布尔：null/undefined → null（跟随全局）。 */
function toBoolOrNull(value) {
    if (value === null || value === undefined)
        return null;
    return toBool(value, false);
}
/** position：0-7 整数，非法回落默认。 */
function toPosition(value, fallback = 0) {
    const n = toNum(value, Number.NaN);
    return Number.isInteger(n) && n >= 0 && n <= 7 ? n : fallback;
}
/** role：0-2，非法回落 0（system）。 */
function toRole(value) {
    const n = toNum(value, Number.NaN);
    return n === 0 || n === 1 || n === 2 ? n : 0;
}
/** selectiveLogic：0-3，非法回落 0（AndAny）。 */
function toSelectiveLogic(value) {
    const n = toNum(value, Number.NaN);
    return n === 0 || n === 1 || n === 2 || n === 3 ? n : 0;
}
/** 旧格式 delayUntilRecursion 可能是布尔：true → 1，false → 0。 */
function toDelayUntilRecursion(value) {
    if (typeof value === 'boolean')
        return value ? 1 : 0;
    return toNum(value, 0);
}
// ---------------------------------------------------------------------------
// 条目解析
// ---------------------------------------------------------------------------
function makeKey(uid, opts) {
    return `${opts.source}:${opts.sourceRef}:${uid}`;
}
/** 原生 World Info 条目（camelCase 字段）。 */
function parseNativeEntry(raw, uid, opts) {
    return {
        key: makeKey(uid, opts),
        uid,
        source: opts.source,
        sourceRef: opts.sourceRef,
        keys: toStrArr(raw.key),
        secondaryKeys: toStrArr(raw.keysecondary),
        selective: toBool(raw.selective, true),
        selectiveLogic: toSelectiveLogic(raw.selectiveLogic),
        comment: toStr(raw.comment),
        content: toStr(raw.content),
        constant: toBool(raw.constant, false),
        enabled: !toBool(raw.disable, false),
        order: toNum(raw.order, 100),
        position: toPosition(raw.position),
        depth: toNum(raw.depth, 4),
        role: toRole(raw.role),
        outletName: toStr(raw.outletName),
        probability: toNum(raw.probability, 100),
        useProbability: toBool(raw.useProbability, true),
        caseSensitive: toBoolOrNull(raw.caseSensitive),
        matchWholeWords: toBoolOrNull(raw.matchWholeWords),
        useGroupScoring: toBoolOrNull(raw.useGroupScoring),
        scanDepth: toNumOrNull(raw.scanDepth),
        excludeRecursion: toBool(raw.excludeRecursion, false),
        preventRecursion: toBool(raw.preventRecursion, false),
        delayUntilRecursion: toDelayUntilRecursion(raw.delayUntilRecursion),
        sticky: toNumOrNull(raw.sticky),
        cooldown: toNumOrNull(raw.cooldown),
        delay: toNumOrNull(raw.delay),
        ignoreBudget: toBool(raw.ignoreBudget, false),
        group: toStr(raw.group),
        groupWeight: toNum(raw.groupWeight, 100),
        groupOverride: toBool(raw.groupOverride, false),
        automationId: toStr(raw.automationId),
    };
}
/** character_book 条目的 position：extensions.position 数值优先于顶层字符串。 */
function parseBookPosition(raw, ext) {
    const fromExt = toNum(ext.position, Number.NaN);
    if (Number.isInteger(fromExt) && fromExt >= 0 && fromExt <= 7)
        return fromExt;
    if (raw.position === 'before_char')
        return 0;
    if (raw.position === 'after_char')
        return 1;
    return toPosition(raw.position);
}
/**
 * 角色卡 character_book 条目（顶层 snake_case + extensions 覆盖）。
 * 顶层 priority 为卡格式遗留字段，SillyTavern 与本插件均不消费，导入时忽略。
 */
function parseCharacterBookEntry(raw, uid, opts) {
    const ext = isRecord(raw.extensions) ? raw.extensions : {};
    return {
        key: makeKey(uid, opts),
        uid,
        source: opts.source,
        sourceRef: opts.sourceRef,
        keys: toStrArr(raw.keys),
        secondaryKeys: toStrArr(raw.secondary_keys),
        selective: toBool(raw.selective, false),
        selectiveLogic: toSelectiveLogic(ext.selectiveLogic),
        comment: toStr(raw.comment),
        content: toStr(raw.content),
        constant: toBool(raw.constant, false),
        enabled: toBool(raw.enabled, true),
        order: toNum(raw.insertion_order, 100),
        position: parseBookPosition(raw, ext),
        depth: toNum(ext.depth, 4),
        role: toRole(ext.role),
        outletName: toStr(ext.outlet_name),
        probability: toNum(ext.probability, 100),
        useProbability: toBool(ext.useProbability, true),
        caseSensitive: toBoolOrNull(ext.case_sensitive !== undefined ? ext.case_sensitive : raw.case_sensitive),
        matchWholeWords: toBoolOrNull(ext.match_whole_words),
        useGroupScoring: toBoolOrNull(ext.use_group_scoring !== undefined ? ext.use_group_scoring : ext.useGroupScoring),
        scanDepth: toNumOrNull(ext.scan_depth),
        excludeRecursion: toBool(ext.exclude_recursion, false),
        preventRecursion: toBool(ext.prevent_recursion, false),
        delayUntilRecursion: toDelayUntilRecursion(ext.delay_until_recursion),
        sticky: toNumOrNull(ext.sticky),
        cooldown: toNumOrNull(ext.cooldown),
        delay: toNumOrNull(ext.delay),
        ignoreBudget: toBool(ext.ignore_budget, false),
        group: toStr(ext.group),
        groupWeight: toNum(ext.group_weight !== undefined ? ext.group_weight : ext.groupWeight, 100),
        groupOverride: toBool(ext.group_override !== undefined ? ext.group_override : ext.groupOverride, false),
        automationId: toStr(ext.automation_id),
    };
}
/** 条目形态判定：带 keys 数组 / extensions 对象 / snake_case 特征字段者视为 character_book 条目。 */
function isCharacterBookEntry(raw) {
    return (Array.isArray(raw.keys) ||
        isRecord(raw.extensions) ||
        'insertion_order' in raw ||
        'secondary_keys' in raw ||
        typeof raw.position === 'string');
}
function parseEntry(raw, uid, opts) {
    const entry = isCharacterBookEntry(raw) ? parseCharacterBookEntry(raw, uid, opts) : parseNativeEntry(raw, uid, opts);
    assertEntryWithinLimits(raw, entry);
    return entry;
}
/**
 * 单条硬校验（统一拒绝口径，归一化时抛错，不放到落盘后由下游 .map()/.includes() 踩雷）：
 * - 键容器（key/keys/keysecondary/secondary_keys）出现但不是数组 → 拒绝（不做「也许是单键」的猜测）；
 * - content 出现但是对象/数组 → 拒绝（toStr 静默塌缩成 '' 会悄悄丢掉设定）；
 * - 单键超 MAX_WI_KEY_CHARS / 正文超 MAX_LOREBOOK_CONTENT_CHARS → 拒绝。
 */
function assertEntryWithinLimits(raw, entry) {
    for (const field of ['key', 'keys', 'keysecondary', 'secondary_keys']) {
        const value = raw[field];
        if (value !== undefined && value !== null && !Array.isArray(value)) {
            throw new Error(`世界书条目 ${entry.uid} 的 ${field} 不是数组，拒绝导入`);
        }
    }
    const content = raw.content;
    if (content !== undefined && content !== null && typeof content === 'object') {
        throw new Error(`世界书条目 ${entry.uid} 的 content 不是字符串，拒绝导入`);
    }
    for (const key of [...entry.keys, ...entry.secondaryKeys]) {
        if (key.length > MAX_WI_KEY_CHARS) {
            throw new Error(`世界书条目 ${entry.uid} 的触发键超过 ${MAX_WI_KEY_CHARS} 字符上限，拒绝导入`);
        }
    }
    if (entry.content.length > MAX_LOREBOOK_CONTENT_CHARS) {
        throw new Error(`世界书条目 ${entry.uid} 的正文超过 ${MAX_LOREBOOK_CONTENT_CHARS} 字符上限，拒绝导入`);
    }
}
/** uid 解析：map 形态以 map 键为准；数组形态取 uid/id 字段，缺失用数组下标。 */
function entryUid(raw, fallback) {
    return toStr(raw.uid ?? raw.id) || fallback;
}
function parseEntryArray(entries, opts) {
    if (entries.length > MAX_LOREBOOK_ENTRIES) {
        throw new Error(`世界书条目数 ${entries.length} 超过上限 ${MAX_LOREBOOK_ENTRIES}，拒绝导入`);
    }
    const out = [];
    entries.forEach((value, index) => {
        // 非对象条目静默跳过（兼容已在工作区落盘的旧导入文件，不让坏条目毁掉整本书）
        if (!isRecord(value))
            return;
        out.push(parseEntry(value, entryUid(value, String(index)), opts));
    });
    return out;
}
/**
 * 解析世界书 JSON 为归一化条目数组。
 * 非对象/缺 entries 时抛中文错误；条目数/正文/键超限或键容器、content 错型同样抛错拒绝导入。
 */
export function parseLorebook(json, opts) {
    if (Array.isArray(json))
        return parseEntryArray(json, opts);
    if (!isRecord(json))
        throw new Error('世界书 JSON 不是对象或条目数组');
    const rawEntries = json.entries;
    if (Array.isArray(rawEntries))
        return parseEntryArray(rawEntries, opts);
    if (isRecord(rawEntries)) {
        const pairs = Object.entries(rawEntries);
        if (pairs.length > MAX_LOREBOOK_ENTRIES) {
            throw new Error(`世界书条目数 ${pairs.length} 超过上限 ${MAX_LOREBOOK_ENTRIES}，拒绝导入`);
        }
        const out = [];
        for (const [mapKey, value] of pairs) {
            if (!isRecord(value))
                continue;
            out.push(parseEntry(value, mapKey, opts));
        }
        return out;
    }
    throw new Error('世界书 JSON 缺少 entries（对象 map 或数组）');
}
// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
/**
 * 导出为 SillyTavern 原生形态 {entries: {<uid>: {...}}}（camelCase 字段对齐原生 WI JSON）。
 * name 不写入文件（ST 原生世界书 JSON 无此字段），保留在签名中供调用方传递命名上下文。
 */
export function exportLorebook(entries, name) {
    void name; // ST 原生世界书 JSON 无 name 字段，不写入
    const map = {};
    for (const e of entries) {
        map[e.uid] = {
            uid: e.uid,
            key: e.keys,
            keysecondary: e.secondaryKeys,
            comment: e.comment,
            content: e.content,
            constant: e.constant,
            disable: !e.enabled,
            order: e.order,
            position: e.position,
            depth: e.depth,
            role: e.role,
            outletName: e.outletName,
            probability: e.probability,
            useProbability: e.useProbability,
            selective: e.selective,
            selectiveLogic: e.selectiveLogic,
            scanDepth: e.scanDepth,
            caseSensitive: e.caseSensitive,
            matchWholeWords: e.matchWholeWords,
            useGroupScoring: e.useGroupScoring ?? null,
            excludeRecursion: e.excludeRecursion,
            preventRecursion: e.preventRecursion,
            delayUntilRecursion: e.delayUntilRecursion,
            sticky: e.sticky,
            cooldown: e.cooldown,
            delay: e.delay,
            ignoreBudget: e.ignoreBudget,
            group: e.group,
            groupWeight: e.groupWeight,
            groupOverride: e.groupOverride,
            automationId: e.automationId,
        };
    }
    return { entries: map };
}
// ---------------------------------------------------------------------------
// 变化层固化
// ---------------------------------------------------------------------------
/**
 * 固化导出用：把生效中的 delta 合并进原书条目，返回新数组（不改入参）。
 * - update → 替换 ref 条目 content
 * - invalidate → 标记 ref 条目 enabled=false
 * - add → 追加新条目（source 'global'，uid `delta-<id>`，position 默认 AfterCharDefs）
 * revoked 与已过期（expires <= 当前时间）的 delta 忽略；ref 未命中的 update/invalidate 同样忽略。
 */
export function mergeDeltasForExport(originals, deltas) {
    const now = Date.now();
    const result = originals.map((e) => ({ ...e, keys: [...e.keys], secondaryKeys: [...e.secondaryKeys] }));
    const byUid = new Map(result.map((e) => [e.uid, e]));
    for (const delta of deltas) {
        if (delta.revoked)
            continue;
        if (delta.expires !== null) {
            const expiresAt = Date.parse(delta.expires);
            if (!Number.isNaN(expiresAt) && expiresAt <= now)
                continue;
        }
        if (delta.type === 'add') {
            const uid = `delta-${delta.id}`;
            const entry = {
                key: `global:delta:${uid}`,
                uid,
                source: 'global',
                sourceRef: 'delta',
                keys: [...delta.keys],
                secondaryKeys: [],
                selective: false,
                selectiveLogic: 0,
                comment: `世界状态变化 ${delta.id}`,
                content: delta.content,
                constant: false,
                enabled: true,
                order: delta.order,
                position: 1, // AfterCharDefs（plan 3.12.4：变化层默认位置）
                depth: 4,
                role: 0,
                outletName: '',
                probability: 100,
                useProbability: true,
                caseSensitive: null,
                matchWholeWords: null,
                scanDepth: null,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: 0,
                sticky: null,
                cooldown: null,
                delay: null,
                ignoreBudget: false,
                group: '',
                groupWeight: 100,
                groupOverride: false,
                automationId: '',
            };
            result.push(entry);
            byUid.set(uid, entry);
            continue;
        }
        if (delta.ref === null)
            continue;
        const target = byUid.get(delta.ref);
        if (!target)
            continue;
        if (delta.type === 'update')
            target.content = delta.content;
        else
            target.enabled = false;
    }
    return result;
}
