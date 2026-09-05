export const emptyTemplateScopes = () => ({ global: {}, local: {}, message: {} });
export const hasEjs = (text) => text.includes('<%');
export function validateTemplateJson(value, depth = 0) {
    if (depth > 48)
        throw new Error('模板变量嵌套超过 48 层');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (typeof value !== 'object' || !value)
        throw new Error('模板变量必须是 JSON 值');
    for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw new Error('模板变量含禁止的原型路径');
        validateTemplateJson(item, depth + 1);
    }
}
export function parseTemplateScopes(value) {
    validateTemplateJson(value);
    if (!value || Array.isArray(value) || typeof value !== 'object')
        throw new Error('模板变量状态损坏');
    for (const scope of ['global', 'local', 'message']) {
        const item = value[scope];
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new Error(`模板变量作用域损坏：${scope}`);
    }
    if (JSON.stringify(value).length > 1024 * 1024)
        throw new Error('模板变量超过 1 MiB 上限');
    return value;
}
