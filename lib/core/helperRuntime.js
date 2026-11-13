/** 由共享公共部分派生单个气泡快照：messages/scopes 共用引用，字段顺序与逐条快照一致。 */
export function helperSnapshotAt(base, currentMessageId) {
    return { storyId: base.storyId, historyRevision: base.historyRevision, currentMessageId, writable: base.writable, scopes: base.scopes, messages: base.messages };
}
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
    const active = new Set();
    // 函数体通过 .toString() 注入 iframe；JSON UTF-8 字符串字节统计必须保持自包含、不引用外部符号。
    function utf8JsonStringBytes(text) {
        let len = 2;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code < 0x80) {
                if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d)
                    len += 2;
                else if (code < 0x20)
                    len += 6;
                else
                    len += 1;
            }
            else if (code < 0x800) {
                len += 2;
            }
            else if (code >= 0xd800 && code <= 0xdbff) {
                const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
                if (next >= 0xdc00 && next <= 0xdfff) {
                    len += 4;
                    i++;
                }
                else
                    len += 6;
            }
            else if (code >= 0xdc00 && code <= 0xdfff) {
                len += 6;
            }
            else {
                len += 3;
            }
        }
        return len;
    }
    function isPlainHelperObj(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return false;
        const prototype = Object.getPrototypeOf(item);
        return prototype === Object.prototype || prototype === null;
    }
    function walk(item, depth) {
        if (depth > 64)
            throw new Error('酒馆助手数据嵌套超过 64 层');
        let result;
        if (item === null || typeof item === 'boolean') {
            bytes += 5;
            result = item;
        }
        else if (typeof item === 'string') {
            bytes += utf8JsonStringBytes(item);
            result = item;
        }
        else if (typeof item === 'number' && Number.isFinite(item)) {
            bytes += String(item).length;
            result = item;
        }
        else {
            if (!item || typeof item !== 'object' || (!Array.isArray(item) && !isPlainHelperObj(item)))
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
                    bytes += utf8JsonStringBytes(key) + 2;
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
