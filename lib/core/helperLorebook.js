export function createHelperLorebookCodec(json) {
    const record = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
    const fields = ['uid', 'display_index', 'comment', 'enabled', 'type', 'position', 'depth', 'order', 'probability', 'keys', 'logic', 'filters', 'scan_depth', 'case_sensitive', 'match_whole_words', 'use_group_scoring', 'automation_id', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion', 'content', 'group', 'group_prioritized', 'group_weight', 'sticky', 'cooldown', 'delay'];
    const clone = (value) => JSON.parse(JSON.stringify(value));
    function list(input) {
        const values = json(input, 8 * 1024 * 1024);
        if (!Array.isArray(values) || values.length > 2000 || values.some(value => !record(value)))
            throw new Error('旧世界书条目必须是至多 2000 项的对象数组');
        for (const value of values)
            for (const key of Object.keys(value))
                if (!fields.includes(key))
                    throw new Error('未知旧世界书字段：' + key);
        return values;
    }
    function uid(value) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('旧世界书 UID 必须为非负安全整数'); return value; }
    function toLegacy(entry, index = 0) {
        const extra = entry.extra, inherit = (value) => typeof value === 'boolean' ? value : 'same_as_global';
        return { uid: entry.uid, display_index: typeof extra.displayIndex === 'number' ? extra.displayIndex : index, comment: entry.name, enabled: entry.enabled, type: entry.strategy.type,
            position: entry.position.type === 'at_depth' ? 'at_depth_as_' + entry.position.role : entry.position.type, depth: entry.position.type === 'at_depth' ? entry.position.depth : null, order: entry.position.order, probability: entry.probability,
            keys: clone(entry.strategy.keys), logic: entry.strategy.keys_secondary.logic, filters: clone(entry.strategy.keys_secondary.keys), scan_depth: entry.strategy.scan_depth,
            case_sensitive: inherit(extra.caseSensitive), match_whole_words: inherit(extra.matchWholeWords), use_group_scoring: inherit(extra.useGroupScoring), automation_id: typeof extra.automationId === 'string' && extra.automationId ? extra.automationId : null,
            exclude_recursion: entry.recursion.prevent_incoming, prevent_recursion: entry.recursion.prevent_outgoing, delay_until_recursion: entry.recursion.delay_until ?? false, content: entry.content,
            group: typeof extra.group === 'string' ? extra.group : '', group_prioritized: extra.groupOverride === true, group_weight: typeof extra.groupWeight === 'number' ? extra.groupWeight : 100,
            sticky: entry.effect.sticky, cooldown: entry.effect.cooldown, delay: entry.effect.delay };
    }
    function convert(input, base, partial = false) {
        const value = partial && base ? { ...toLegacy(base), ...input } : input;
        const text = (key, fallback = '', max = 100000) => { const v = value[key]; if (v === undefined)
            return fallback; if (typeof v !== 'string' || v.length > max)
            throw new Error('旧世界书文本字段无效：' + key); return v; };
        const number = (key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => { const v = value[key]; if (v === undefined)
            return fallback; if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
            throw new Error('旧世界书数值字段无效：' + key); return v; };
        const bool = (key, fallback = false) => { const v = value[key]; if (v === undefined)
            return fallback; if (typeof v !== 'boolean')
            throw new Error('旧世界书开关无效：' + key); return v; };
        const inherit = (key) => { const v = value[key]; if (v === undefined || v === 'same_as_global')
            return null; if (typeof v !== 'boolean')
            throw new Error('旧世界书继承开关无效：' + key); return v; };
        const nullable = (key) => value[key] == null ? null : number(key, 0);
        const enumValue = (key, choices, fallback) => { const v = text(key, fallback); if (!choices.includes(v))
            throw new Error('旧世界书枚举无效：' + key); return v; };
        const keys = (key) => { const v = value[key] ?? []; if (!Array.isArray(v) || v.length > 2000 || v.some(item => typeof item !== 'string' || item.length > 500))
            throw new Error('旧世界书关键字无效：' + key); return v; };
        const position = enumValue('position', ['before_character_definition', 'after_character_definition', 'before_example_messages', 'after_example_messages', 'before_author_note', 'after_author_note', 'at_depth_as_system', 'at_depth_as_assistant', 'at_depth_as_user', 'outlet'], 'before_character_definition');
        const atDepth = position.startsWith('at_depth_as_'), delay = value.delay_until_recursion;
        const recurrence = delay === true ? 1 : delay === false || delay === undefined ? null : number('delay_until_recursion', 0);
        const scan = value.scan_depth === undefined || value.scan_depth === 'same_as_global' ? 'same_as_global' : number('scan_depth', 0);
        if (value.automation_id !== undefined && value.automation_id !== null && typeof value.automation_id !== 'string')
            throw new Error('旧世界书 automation_id 无效');
        const extra = { ...base?.extra, displayIndex: number('display_index', 0), caseSensitive: inherit('case_sensitive'), matchWholeWords: inherit('match_whole_words'), useGroupScoring: inherit('use_group_scoring'),
            automationId: value.automation_id == null ? '' : text('automation_id', '', 4096), group: text('group', '', 4096), groupOverride: bool('group_prioritized'), groupWeight: number('group_weight', 100) };
        return { ...(value.uid === undefined ? {} : { uid: uid(value.uid) }), name: text('comment', '', 4096), enabled: bool('enabled', true), content: text('content'), probability: number('probability', 100, 0, 100),
            strategy: { type: enumValue('type', ['constant', 'selective', 'vectorized'], 'selective'), keys: keys('keys'), keys_secondary: { logic: enumValue('logic', ['and_any', 'and_all', 'not_any', 'not_all'], 'and_any'), keys: keys('filters') }, scan_depth: scan },
            position: { type: atDepth ? 'at_depth' : position, role: atDepth ? position.slice('at_depth_as_'.length) : base?.position.role ?? 'system', depth: value.depth == null ? base?.position.depth ?? 4 : number('depth', 4), order: number('order', 100, -Number.MAX_SAFE_INTEGER) },
            recursion: { prevent_incoming: bool('exclude_recursion'), prevent_outgoing: bool('prevent_recursion'), delay_until: recurrence }, effect: { sticky: nullable('sticky'), cooldown: nullable('cooldown'), delay: nullable('delay') }, extra };
    }
    function replace(input, before = []) {
        const byId = new Map(before.map(entry => [entry.uid, entry]));
        return list(input).map(value => convert(value, typeof value.uid === 'number' ? byId.get(value.uid) : undefined));
    }
    function patch(input, before) {
        const values = list(input), existing = new Set(before.map(entry => entry.uid)), byId = new Map();
        for (const value of values) {
            const id = uid(value.uid);
            if (byId.has(id))
                throw new Error('旧世界书更新 UID 重复');
            if (!existing.has(id))
                throw new Error('旧世界书更新 UID 不存在');
            byId.set(id, value);
        }
        return before.map(entry => byId.has(entry.uid) ? convert(byId.get(entry.uid), entry, true) : clone(entry));
    }
    function ids(input) {
        const values = json(input, 8 * 1024 * 1024);
        if (!Array.isArray(values) || values.length > 2000)
            throw new Error('旧世界书删除 UID 列表无效');
        return values.map(uid);
    }
    function filter(entries, input) {
        if (input === undefined || input === 'none')
            return entries;
        const wanted = list([input])[0];
        const same = (left, right) => Array.isArray(left) ? Array.isArray(right) && left.length === right.length && left.every((v, index) => same(v, right[index])) : left === right;
        return entries.filter(entry => Object.entries(wanted).every(([key, value]) => same(value, entry[key])));
    }
    return { toLegacy, replace, patch, uid, list, ids, filter };
}
