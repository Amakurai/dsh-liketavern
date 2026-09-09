export const HELPER_MAX_BYTES = 1024 * 1024;
export function helperRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/** 不求值 getter/toJSON；拒绝污染键、循环、非有限数和超深数据，再复制普通 JSON。 */
export function helperJson(value, maxBytes = HELPER_MAX_BYTES) {
    let bytes = 0;
    const active = new Set(), encoder = new TextEncoder();
    function walk(item, depth) {
        if (depth > 64)
            throw new Error('酒馆助手数据嵌套超过 64 层');
        let result;
        if (item === null || typeof item === 'boolean') {
            bytes += 5;
            result = item;
        }
        else if (typeof item === 'string') {
            bytes += encoder.encode(JSON.stringify(item)).length;
            result = item;
        }
        else if (typeof item === 'number' && Number.isFinite(item)) {
            bytes += String(item).length;
            result = item;
        }
        else {
            if (!item || typeof item !== 'object' || (!Array.isArray(item) && !helperRecord(item)))
                throw new Error('酒馆助手只接受普通 JSON 数据');
            if (active.has(item) || Object.getOwnPropertySymbols(item).length)
                throw new Error('酒馆助手数据不能包含循环或 Symbol');
            active.add(item);
            bytes += 2;
            const descriptors = Object.getOwnPropertyDescriptors(item);
            if (Array.isArray(item)) {
                if (Object.keys(descriptors).length !== item.length + 1)
                    throw new Error('酒馆助手数组必须连续');
                result = Array.from({ length: item.length }, (_, index) => {
                    const descriptor = descriptors[String(index)];
                    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
                        throw new Error('酒馆助手数组不能包含访问器');
                    bytes++;
                    return walk(descriptor.value, depth + 1);
                });
            }
            else {
                const output = {};
                for (const key of Object.keys(descriptors).sort()) {
                    const descriptor = descriptors[key];
                    if (['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptor) || !descriptor.enumerable)
                        throw new Error('酒馆助手数据包含非法字段');
                    bytes += encoder.encode(JSON.stringify(key)).length + 2;
                    output[key] = walk(descriptor.value, depth + 1);
                }
                result = output;
            }
            active.delete(item);
        }
        if (bytes > maxBytes)
            throw new Error('酒馆助手数据超过预算');
        return result;
    }
    return walk(value, 0);
}
export function helperTable(value) {
    if (!helperRecord(value))
        throw new Error('酒馆助手变量表必须是普通对象');
    return helperJson(value);
}
export function helperScopeKey(key) {
    if (typeof key !== 'string' || key.length > 512)
        throw new Error('酒馆助手变量作用域无效');
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 2 || JSON.stringify(parts) !== key)
        throw new Error('酒馆助手变量作用域无效');
    const [type, id] = parts;
    if (!['global', 'character', 'preset', 'chat', 'message', 'script', 'extension'].includes(type)
        || !(typeof id === 'string' && id.length <= 256 || Number.isSafeInteger(id) && id >= 0)
        || ['global', 'character', 'preset', 'chat'].includes(type) && id !== '')
        throw new Error('酒馆助手变量作用域无效');
    return [type, id];
}
export function helperChanges(value) {
    const parsed = helperJson(value, 3 * HELPER_MAX_BYTES);
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 64)
        throw new Error('酒馆助手单次更新需包含 1–64 个变量表');
    const seen = new Set();
    return parsed.map(item => {
        if (!helperRecord(item) || typeof item.key !== 'string' || !helperRecord(item.before) || !helperRecord(item.value)
            || Object.keys(item).some(key => !['key', 'before', 'value'].includes(key)) || seen.has(item.key))
            throw new Error('酒馆助手变量更新无效或重复');
        helperScopeKey(item.key);
        seen.add(item.key);
        return { key: item.key, before: item.before, value: item.value };
    });
}
