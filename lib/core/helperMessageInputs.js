/** 消息读写往返适配：合并完整页集合与旧别名，验证只读字段并拒绝矛盾的新值。 */
import { helperJson } from './helperRuntime.js';
import { parseHelperSwipes } from './helperSwipes.js';
export function normalizeHelperMessageInputs(input, lookup, json = helperJson, codec = parseHelperSwipes) {
    const rows = json(input, 1024 * 1024);
    if (!Array.isArray(rows) || rows.length > 64)
        throw new Error('单次消息编辑最多 64 条');
    const equal = (a, b) => JSON.stringify(json(a)) === JSON.stringify(json(b));
    const seen = new Set(), result = [];
    for (const item of rows) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new Error('消息编辑必须是普通对象');
        const row = item;
        if (Object.keys(row).some(key => !['message_id', 'message', 'data', 'extra', 'name', 'role', 'is_hidden', 'mes', 'is_user', 'is_system', 'swipe_id', 'swipes', 'swipes_data', 'swipes_info'].includes(key)))
            throw new Error('消息编辑只接受已知消息字段');
        if (typeof row.message_id !== 'number' || !Number.isSafeInteger(row.message_id))
            throw new Error('消息序号无效');
        const target = lookup(row.message_id);
        if (!target || typeof target.message_id !== 'number' || seen.has(target.message_id))
            throw new Error('消息序号越界或重复指向同一条消息');
        seen.add(target.message_id);
        for (const key of ['name', 'role', 'is_hidden', 'is_user', 'is_system'])
            if (Object.hasOwn(row, key) && !equal(row[key], target[key]))
                throw new Error('当前尚不支持修改消息属性：' + key);
        const oldTexts = target.swipes, oldData = target.swipes_data, oldExtra = target.swipes_info;
        const base = codec({ active: target.swipe_id, pages: oldTexts.map((message, index) => ({ message, data: oldData[index] ?? {}, extra: oldExtra[index] ?? {} })) }, json);
        const texts = Object.hasOwn(row, 'swipes') ? row.swipes : oldTexts;
        if (!Array.isArray(texts) || !texts.length || texts.length > 64)
            throw new Error('消息页集合需要 1–64 页');
        for (const key of ['swipes_data', 'swipes_info'])
            if (Object.hasOwn(row, key) && (!Array.isArray(row[key]) || row[key].length > texts.length))
                throw new Error('消息页数据长度超过正文页数');
        const active = Object.hasOwn(row, 'swipe_id') ? row.swipe_id : Math.min(base.active, texts.length - 1);
        const next = codec({ active, pages: texts.map((message, index) => ({ message,
                data: Object.hasOwn(row, 'swipes_data') ? (index < row.swipes_data.length ? row.swipes_data[index] : {}) : base.pages[index]?.data ?? {},
                extra: Object.hasOwn(row, 'swipes_info') ? (index < row.swipes_info.length ? row.swipes_info[index] : {}) : base.pages[index]?.extra ?? {} })) }, json);
        const edit = { message_id: row.message_id }, selected = next.pages[next.active];
        for (const [field, arrayKey, aliases] of [['message', 'swipes', ['message', 'mes']], ['data', 'swipes_data', ['data']], ['extra', 'swipes_info', ['extra']]]) {
            const direct = aliases.filter(key => Object.hasOwn(row, key)).map(key => row[key]);
            const returnedObject = ['name', 'role', 'is_hidden'].every(key => Object.hasOwn(row, key));
            const changes = direct.filter(value => next.active !== base.active && !returnedObject || !equal(value, target[field]));
            if (Object.hasOwn(row, arrayKey) && (!base.pages[next.active] || !equal(selected[field], base.pages[next.active][field])))
                changes.push(selected[field]);
            if (changes.some(value => !equal(value, changes[0])))
                throw new Error('消息字段与别名或 swipe 页的修改互相冲突：' + field);
            if (changes.length) {
                if (field === 'message')
                    selected.message = changes[0];
                else
                    selected[field] = changes[0];
            }
            if (direct.length || Object.hasOwn(row, arrayKey) || next.active !== base.active) {
                if (field === 'message')
                    edit.message = selected.message;
                else
                    edit[field] = selected[field];
            }
        }
        codec(next, json);
        const pageInput = ['swipe_id', 'swipes', 'swipes_data', 'swipes_info', 'message', 'mes', 'data', 'extra'].some(key => Object.hasOwn(row, key));
        if (pageInput && (base.pages.length > 1 || next.pages.length > 1 || base.pages.length !== next.pages.length)) {
            edit.pages = next;
            edit.message = selected.message;
            edit.data = selected.data;
            edit.extra = selected.extra;
        }
        if (Object.keys(edit).length > 1)
            result.push(edit);
    }
    return result;
}
