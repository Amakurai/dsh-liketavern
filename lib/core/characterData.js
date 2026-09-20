const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** 已被 CharacterCard 显式建模、由调用方以当前值覆盖的 ST data 字段。 */
const MODELED_DATA_KEYS = new Set([
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
/** 已被内嵌世界书归一化消费的历史别名；不能在删除世界书后从 raw 复活。 */
const CONSUMED_DATA_ALIASES = new Set(['lorebook', 'characterBook']);
const ENVELOPE_KEYS = new Set(['spec', 'spec_version', 'data']);
/** 与卡解析器一致：别名只在真能归一化为非空世界书时才具有业务语义。 */
export function isNonEmptyCharacterBook(value) {
    let current = value;
    // JSON 字符串是旧卡常见别名；用循环限制嵌套，避免恶意多重字符串耗尽栈。
    for (let depth = 0; typeof current === 'string' && depth < 32; depth++) {
        if (!current)
            return false;
        try {
            current = JSON.parse(current);
        }
        catch {
            return false;
        }
    }
    if (typeof current === 'string')
        return false;
    if (Array.isArray(current))
        return current.length > 0;
    if (!record(current))
        return false;
    return Array.isArray(current.entries) ? current.entries.length > 0
        : record(current.entries) && Object.keys(current.entries).length > 0;
}
/**
 * 归一化时判定字段是否已消费；无效 lorebook/characterBook 只是厂商自定义字段，
 * 必须像其它未知 V3 字段一样镜像并保留原位置。
 */
export function isKnownCharacterDataKey(key, value) {
    return MODELED_DATA_KEYS.has(key) || CONSUMED_DATA_ALIASES.has(key) && isNonEmptyCharacterBook(value);
}
/**
 * CCv3 nickname 只改变提示词里的角色身份（包括 {{char}}）；
 * 资产列表、标题和绑定仍展示稳定的 card.name。
 */
export function characterPromptName(card) {
    if (card.spec !== 'chara_card_v3')
        return card.name;
    // extensions.nickname 也可能真的是厂商扩展；只有 raw data 根字段才是 CCv3 nickname。
    const nickname = characterDataExtras(card).fields.nickname;
    return typeof nickname === 'string' && nickname !== '' ? nickname : card.name;
}
/**
 * 从原始卡片记住未建模字段的原位置，再用当前 extensions 中的镜像值覆盖。
 * raw 只负责判定来源，不能作为普通 nested 扩展的值回退，否则用户删掉的旧脚本会复活；
 * 唯一例外是 direct/nested 同名冲突，此时扁平镜像只能表达 direct，raw 才是 nested 的唯一副本。
 */
export function characterDataExtras(card) {
    const raw = record(card.raw) ? card.raw : {};
    const rawData = record(raw.data) ? raw.data : raw;
    const rawExtensions = record(rawData.extensions) ? rawData.extensions : {};
    const fields = {};
    const directKeys = new Set();
    for (const key of Object.keys(rawData)) {
        if (isKnownCharacterDataKey(key, rawData[key]) || ENVELOPE_KEYS.has(key))
            continue;
        directKeys.add(key);
        // 归一化必然把此类字段镜像进 extensions；当前镜像消失表示后续编辑已删除，
        // 不能 fallback raw 复活（典型场景是脚本库升级后删除 TavernHelper_scripts）。
        if (Object.hasOwn(card.extensions, key))
            fields[key] = card.extensions[key];
    }
    const extensions = {};
    for (const key of directKeys) {
        // 解析时 direct 会覆盖同名 nested 镜像；保留 raw nested，避免往返静默丢掉另一份数据。
        if (Object.hasOwn(rawExtensions, key))
            extensions[key] = rawExtensions[key];
    }
    for (const [key, value] of Object.entries(card.extensions)) {
        if (directKeys.has(key))
            continue;
        extensions[key] = value;
    }
    return { fields, extensions };
}
