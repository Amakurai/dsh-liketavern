import { pickRegexScripts } from './card.js';
/** 无法映射到 PromptPreset 的 ST 字段（有意义地出现时各记一条 warning）。 */
const UNMAPPED_FIELDS = [
    { field: 'forbid_overrides', note: '禁止覆盖' },
    { field: 'injection_trigger', note: '注入触发条件' },
    { field: 'extension', note: '扩展标记' },
];
/** 导出时 prompt_order 的 character_id（对齐 SillyTavern Chat Completion dummy）。 */
const EXPORT_CHARACTER_ID = 100001;
/** 选取 prompt_order 时的优先 dummy id：100001（现行）→ 100000（旧默认）。 */
const PREFERRED_CHARACTER_IDS = [EXPORT_CHARACTER_ID, 100000];
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
/** role 以条目自身 role 为准；缺省时 system_prompt=true 才回落 system。 */
function toRole(raw) {
    if (raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system')
        return raw.role;
    if (toBool(raw.system_prompt, false))
        return 'system';
    return 'system';
}
function flattenOrderItems(items) {
    const out = [];
    for (const item of items) {
        if (!isRecord(item))
            continue;
        const identifier = toStr(item.identifier);
        if (identifier !== '')
            out.push({ identifier, enabled: toBool(item.enabled, true) });
        if (Array.isArray(item.items))
            out.push(...flattenOrderItems(item.items));
    }
    return out;
}
/**
 * 选出应对齐 ST Prompt Manager 的那份 order。
 * 有 prompt_order 但解析不出任何项 → 空数组（全关）；字段缺失 → null（全开）。
 */
function pickPromptOrder(promptOrder) {
    if (!Array.isArray(promptOrder) || promptOrder.length === 0)
        return null;
    const blocks = [];
    for (const block of promptOrder) {
        if (!isRecord(block) || !Array.isArray(block.order))
            continue;
        const items = flattenOrderItems(block.order);
        if (items.length === 0)
            continue;
        blocks.push({ id: toNum(block.character_id, Number.NaN), items });
    }
    if (blocks.length === 0)
        return [];
    for (const id of PREFERRED_CHARACTER_IDS) {
        const hit = blocks.find((b) => b.id === id);
        if (hit)
            return hit.items;
    }
    return blocks.reduce((best, cur) => (cur.items.length > best.items.length ? cur : best)).items;
}
function unmappedFieldPresent(rawPrompts, field) {
    return rawPrompts.some((raw) => {
        if (!isRecord(raw) || !(field in raw))
            return false;
        const value = raw[field];
        if (field === 'injection_trigger')
            return Array.isArray(value) && value.length > 0;
        return toBool(value, false);
    });
}
function collectPromptEmbeddedRegex(rawPrompts) {
    const out = [];
    for (const raw of rawPrompts) {
        if (!isRecord(raw))
            continue;
        const content = toStr(raw.content).trim();
        if (!content.startsWith('{') || !content.includes('RegexBinding'))
            continue;
        try {
            const parsed = JSON.parse(content);
            const regexes = parsed.RegexBinding?.regexes;
            if (!Array.isArray(regexes))
                continue;
            for (const item of regexes) {
                if (isRecord(item) && typeof item.findRegex === 'string' && item.findRegex) {
                    out.push(item);
                }
            }
        }
        catch {
            // 条目正文不是 JSON
        }
    }
    return out;
}
function parsePromptEntry(raw, index, warnings) {
    const identifier = toStr(raw.identifier);
    if (identifier === '') {
        warnings.push(`prompts[${index}] 缺少 identifier，已跳过`);
        return null;
    }
    const marker = toBool(raw.marker, false);
    const position = toNum(raw.injection_position, 0) === 1 ? 'in-chat' : 'relative';
    const entry = {
        identifier,
        name: toStr(raw.name) || identifier,
        enabled: true,
        role: toRole(raw),
        position,
        depth: toNum(raw.injection_depth, 4),
        order: toNum(raw.injection_order, 100),
        content: toStr(raw.content),
        marker,
    };
    if (marker)
        entry.markerId = identifier;
    return entry;
}
/** relative 条目用栈序（×10）；in-chat 保留 injection_order。 */
function assignRelativeOrder(entries) {
    entries.forEach((entry, index) => {
        if (entry.position !== 'in-chat')
            entry.order = (index + 1) * 10;
    });
}
/**
 * 解析 ST 预设 JSON。缺 prompts 数组时抛中文错误；
 * 无法映射的字段与条目不中断导入，记入 warnings。
 */
export function parseStPreset(json) {
    if (!isRecord(json))
        throw new Error('预设文件不是有效的 JSON 对象');
    if (!Array.isArray(json.prompts))
        throw new Error('预设文件缺少 prompts 数组，无法导入');
    const rawPrompts = json.prompts;
    const warnings = [];
    const byId = new Map();
    const promptSeq = [];
    rawPrompts.forEach((raw, index) => {
        if (!isRecord(raw)) {
            warnings.push(`prompts[${index}] 不是对象，已跳过`);
            return;
        }
        const parsed = parsePromptEntry(raw, index, warnings);
        if (parsed === null)
            return;
        if (byId.has(parsed.identifier)) {
            warnings.push(`prompts[${index}] 与已有条目 identifier 重复（${parsed.identifier}），已跳过`);
            return;
        }
        byId.set(parsed.identifier, parsed);
        promptSeq.push(parsed.identifier);
    });
    const orderList = Array.isArray(json.prompt_order) ? pickPromptOrder(json.prompt_order) : null;
    const entries = [];
    const seen = new Set();
    if (orderList !== null) {
        for (const item of orderList) {
            const src = byId.get(item.identifier);
            if (!src || seen.has(item.identifier))
                continue;
            seen.add(item.identifier);
            entries.push({ ...src, enabled: item.enabled });
        }
        const leftover = promptSeq.filter((id) => !seen.has(id)).length;
        if (leftover > 0) {
            warnings.push(`有 ${leftover} 条未列入 prompt_order 的库条目，已关闭（可在编辑器中开启）`);
        }
        for (const id of promptSeq) {
            if (seen.has(id))
                continue;
            const src = byId.get(id);
            if (!src)
                continue;
            entries.push({ ...src, enabled: false });
        }
        assignRelativeOrder(entries);
    }
    else {
        for (const id of promptSeq) {
            const src = byId.get(id);
            if (src)
                entries.push(src);
        }
    }
    for (const { field, note } of UNMAPPED_FIELDS) {
        if (unmappedFieldPresent(rawPrompts, field)) {
            warnings.push(`字段 ${field}（${note}）暂不支持，导入时已忽略`);
        }
    }
    const preset = {
        name: toStr(json.name) || '未命名预设',
        identifier: toStr(json.identifier) || toStr(json.name) || 'imported-preset',
        entries,
    };
    const regexScripts = pickRegexScripts(json, json);
    const embedded = regexScripts.length > 0 ? [] : collectPromptEmbeddedRegex(rawPrompts);
    const scripts = regexScripts.length > 0 ? regexScripts : embedded;
    if (scripts.length > 0) {
        preset.regexScripts = scripts;
        warnings.push(`已导入 ${scripts.length} 条预设正则（随脚本开关生效）`);
    }
    return { preset, warnings };
}
/** 导出为 ST 形态：prompts + 单个 prompt_order（character_id 100001）。 */
export function exportStPreset(preset) {
    const prompts = preset.entries.map((e) => ({
        identifier: e.identifier,
        name: e.name,
        role: e.role,
        content: e.content,
        marker: e.marker,
        system_prompt: e.role === 'system',
        injection_position: e.position === 'in-chat' ? 1 : 0,
        injection_depth: e.depth,
        injection_order: e.order,
    }));
    const order = preset.entries.map((e) => ({ identifier: e.identifier, enabled: e.enabled }));
    const exported = {
        name: preset.name,
        identifier: preset.identifier,
        prompts,
        prompt_order: [{ character_id: EXPORT_CHARACTER_ID, order }],
    };
    if (preset.regexScripts && preset.regexScripts.length > 0) {
        exported.extensions = { regex_scripts: preset.regexScripts };
    }
    return exported;
}
