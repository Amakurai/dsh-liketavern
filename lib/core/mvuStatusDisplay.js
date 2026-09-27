export const MVU_STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';
/** 单条展示不知道消息深度，只给不限深度的规则补位；与 applyRegexToMessages 一致，负数（ST 的 -1）与 minDepth 0 均为不限。 */
function unlimitedDepth(rule) {
    return (rule.minDepth === null || rule.minDepth <= 0) && (rule.maxDepth === null || rule.maxDepth < 0);
}
export function needsMvuStatusPlaceholder(text, rules) {
    if (text.includes('StatusPlaceHolderImpl'))
        return false;
    return rules.some(rule => rule.source === 'card' && rule.enabled && rule.find === MVU_STATUS_PLACEHOLDER && Boolean(rule.replace.trim()) && rule.scopes.includes('output') && rule.timing.includes('render') && (!rule.roles?.length || rule.roles.includes('assistant')) && unlimitedDepth(rule));
}
