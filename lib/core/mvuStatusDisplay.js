export const MVU_STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';
export function needsMvuStatusPlaceholder(text, rules) {
    if (text.includes('StatusPlaceHolderImpl'))
        return false;
    return rules.some(rule => rule.source === 'card' && rule.enabled && rule.find === MVU_STATUS_PLACEHOLDER && Boolean(rule.replace.trim()) && rule.scopes.includes('output') && rule.timing.includes('render') && (!rule.roles?.length || rule.roles.includes('assistant')) && rule.minDepth === null && rule.maxDepth === null);
}
