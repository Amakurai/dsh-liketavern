/**
 * 人设解析：会话绑定未指定时，用默认页或「库里只剩一条」接上，避免 {{user}} 落成 User。
 * Persona 数据形状也归这里（纯数据，core 层）；存储在 node/state，remote 契约引用本文件。
 */
/** 无人设时 {{user}} 的展示名（对齐 SillyTavern 缺省 User）。 */
export const DEFAULT_USER_NAME = 'User';
/**
 * 绑定指定 > 默认页 > 库里只剩一条。
 * 绑定为空且库里有多条、默认也未选时返回 null（调用方回退展示名 User）。
 */
export function pickPersona(bound, fallback, all) {
    if (bound)
        return bound;
    if (fallback)
        return fallback;
    return all.length === 1 ? all[0] : null;
}
