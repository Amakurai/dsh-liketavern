/** 剧情消息的完整页集合：有界普通 JSON 校验，并将当前正文和变量投影到选中页。 */
import { helperJson } from './helperRuntime.js';
export function parseHelperSwipes(input, json = helperJson) {
    const value = json(input, 1024 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['active', 'pages'].includes(key)) || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 64 || !Number.isSafeInteger(value.active) || value.active < 0 || value.active >= value.pages.length)
        throw new Error('消息页集合无效：需要 1–64 页及有效选中下标');
    for (const page of value.pages) {
        if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => !['message', 'data', 'extra'].includes(key)) || typeof page.message !== 'string' || !page.message.trim() || new TextEncoder().encode(page.message).length > 256 * 1024)
            throw new Error('消息页正文为空或超过 256 KiB');
        for (const key of ['data', 'extra'])
            if (!page[key] || typeof page[key] !== 'object' || Array.isArray(page[key]))
                throw new Error('消息页变量和元数据必须是普通 JSON 对象');
    }
    return value;
}
export function effectiveHelperSwipes(page, stored) {
    if (!stored)
        return { active: 0, pages: [page] };
    return { ...stored, pages: stored.pages.map((item, index) => index === stored.active ? page : item) };
}
