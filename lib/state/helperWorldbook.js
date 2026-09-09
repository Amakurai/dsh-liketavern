/** 酒馆助手条目与原生世界书互转；保留非数字原始 UID 和额外字段，避免编辑后破坏定时器/变化层引用。 */
import { helperJson, helperRecord } from '../core/helperRuntime.js';
import { parseHelperWorldbook, HELPER_WORLDBOOK_MAX_BYTES } from '../core/helperWorldbook.js';
import { parseLorebook, exportLorebook } from './lorebook.js';
const positions = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages', 'outlet'];
const logics = ['and_any', 'not_all', 'not_any', 'and_all'];
const roles = ['system', 'user', 'assistant'];
const extraFields = ['outletName', 'useProbability', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'ignoreBudget', 'group', 'groupWeight', 'groupOverride', 'automationId'];
function sourceRows(input) {
    const rows = Array.isArray(input) ? input : helperRecord(input) ? input.entries : undefined;
    if (Array.isArray(rows))
        return new Map(rows.flatMap((item, index) => helperRecord(item) ? [[String(item.uid ?? item.id ?? index), item]] : []));
    return new Map(helperRecord(rows) ? Object.entries(rows).filter((pair) => helperRecord(pair[1])) : []);
}
export function readHelperWorldbook(input) {
    const json = helperJson(input, HELPER_WORLDBOOK_MAX_BYTES), container = Array.isArray(json) ? json : helperRecord(json) ? json.entries : undefined;
    if (!Array.isArray(container) && !helperRecord(container))
        throw new Error('世界书缺少合法条目结构');
    const values = Object.values(container);
    if (values.length > 2000 || values.some(value => !helperRecord(value)))
        throw new Error('世界书条目损坏或超过 2000 项预算');
    const normalized = parseLorebook(json, { source: 'global', sourceRef: 'helper' }), rows = sourceRows(json);
    const sourceIds = new Set();
    for (const entry of normalized) {
        if (['__proto__', 'prototype', 'constructor'].includes(entry.uid) || sourceIds.has(entry.uid))
            throw new Error('世界书原始 UID 重复或包含保留名称');
        sourceIds.add(entry.uid);
    }
    const canonical = exportLorebook(normalized, '').entries;
    const ids = new Set(), mapped = new Map(), originalIds = new Map();
    for (const entry of normalized) {
        const hint = rows.get(entry.uid)?.dsh_helper_uid, fromText = /^(0|[1-9][0-9]*)$/.test(entry.uid) ? Number(entry.uid) : NaN;
        const value = typeof hint === 'number' ? hint : fromText;
        if (Number.isSafeInteger(value) && value >= 0 && !ids.has(value)) {
            ids.add(value);
            mapped.set(entry.uid, value);
        }
    }
    let next = 0;
    const entries = normalized.map(entry => {
        while (ids.has(next))
            next++;
        const uid = mapped.get(entry.uid) ?? next++;
        ids.add(uid);
        originalIds.set(uid, entry.uid);
        const raw = rows.get(entry.uid) ?? {}, base = canonical[entry.uid], extra = {};
        for (const [key, value] of Object.entries(raw))
            if (!Object.hasOwn(base, key) && !['dsh_helper_uid', 'dsh_helper_extra', 'keys', 'secondary_keys', 'enabled', 'insertion_order', 'extensions', 'id'].includes(key))
                extra[key] = value;
        if (helperRecord(raw.extensions)) {
            extra.extensions = raw.extensions;
            if (raw.extensions.display_index !== undefined)
                extra.displayIndex = raw.extensions.display_index;
        }
        Object.assign(extra, helperRecord(raw.dsh_helper_extra) ? raw.dsh_helper_extra : {});
        for (const key of extraFields)
            extra[key] = base[key];
        return { uid, name: entry.comment, enabled: entry.enabled, content: entry.content, probability: entry.probability,
            strategy: { type: raw.vectorized === true ? 'vectorized' : entry.constant ? 'constant' : 'selective', keys: entry.keys, keys_secondary: { logic: logics[entry.selectiveLogic], keys: entry.selective ? entry.secondaryKeys : [] }, scan_depth: entry.scanDepth ?? 'same_as_global' },
            position: { type: positions[entry.position], role: roles[entry.role], depth: entry.depth, order: entry.order },
            recursion: { prevent_incoming: entry.excludeRecursion, prevent_outgoing: entry.preventRecursion, delay_until: entry.delayUntilRecursion || null },
            effect: { sticky: entry.sticky, cooldown: entry.cooldown, delay: entry.delay }, extra };
    });
    return { entries: parseHelperWorldbook(entries), originalIds };
}
export function writeHelperWorldbook(input, previous = { entries: {} }) {
    const entries = parseHelperWorldbook(input), before = readHelperWorldbook(previous), oldRows = sourceRows(previous), rows = Object.create(null);
    for (const entry of entries) {
        let originalId = before.originalIds.get(entry.uid);
        if (originalId === undefined) {
            originalId = String(entry.uid);
            const reserved = new Set(before.originalIds.values());
            while (reserved.has(originalId) || Object.hasOwn(rows, originalId))
                originalId = 'helper-' + originalId;
        }
        if (Object.hasOwn(rows, originalId))
            throw new Error('世界书原始 UID 冲突');
        if (entry.strategy.type === 'vectorized' && !oldRows.get(originalId)?.vectorized)
            throw new Error('当前世界书引擎尚未提供向量触发；不能新增向量条目');
        const extra = {};
        for (const key of extraFields)
            if (entry.extra[key] !== undefined)
                extra[key] = entry.extra[key];
        rows[originalId] = { ...extra, ...(entry.extra.displayIndex === undefined ? {} : { displayIndex: entry.extra.displayIndex }), uid: originalId, dsh_helper_uid: entry.uid, dsh_helper_extra: entry.extra, key: entry.strategy.keys, keysecondary: entry.strategy.keys_secondary.keys,
            comment: entry.name, disable: !entry.enabled, content: entry.content, constant: entry.strategy.type === 'constant', vectorized: entry.strategy.type === 'vectorized',
            selective: entry.strategy.keys_secondary.keys.length > 0, selectiveLogic: logics.indexOf(entry.strategy.keys_secondary.logic), scanDepth: entry.strategy.scan_depth === 'same_as_global' ? null : entry.strategy.scan_depth,
            position: positions.indexOf(entry.position.type), role: roles.indexOf(entry.position.role), depth: entry.position.depth, order: entry.position.order,
            probability: entry.probability, useProbability: entry.extra.useProbability ?? true, excludeRecursion: entry.recursion.prevent_incoming, preventRecursion: entry.recursion.prevent_outgoing, delayUntilRecursion: entry.recursion.delay_until ?? 0,
            sticky: entry.effect.sticky, cooldown: entry.effect.cooldown, delay: entry.effect.delay };
    }
    const result = { ...(helperRecord(previous) ? previous : {}), entries: rows };
    helperJson(result, HELPER_WORLDBOOK_MAX_BYTES);
    parseLorebook(result, { source: 'global', sourceRef: 'helper' });
    return result;
}
