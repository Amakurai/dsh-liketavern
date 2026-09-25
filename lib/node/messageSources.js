/** 旧剧情中的 plugin 来源仍是合法持久数据，续写检查必须兼容，不能绕过未处理片段。 */
export function isTavernNotice(source) {
    if (!source || typeof source !== 'object')
        return false;
    const value = source;
    return value.form === 'notice' && (value.kind === 'dsh-tavern'
        || value.kind === 'plugin' && value.plugin === 'dsh-tavern');
}
