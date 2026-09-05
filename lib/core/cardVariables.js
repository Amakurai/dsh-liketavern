/** 用户在宿主对话框中粘贴备份后验证，再注入新的 iframe；没有卡片到主窗口的存储桥。 */
export function restoreCardVariableBackup(srcDoc, text) {
    if (new TextEncoder().encode(text).length > 1024 * 1024)
        throw new Error('Card backup exceeds 1 MiB');
    const parsed = JSON.parse(text, (key, value) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
            throw new Error('Invalid variable key');
        return value;
    });
    const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.scopes))
        throw new Error('Invalid backup');
    for (const [key, value] of Object.entries(parsed.scopes)) {
        const parts = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 2 || !record(value))
            throw new Error('Invalid scope');
        const [type, id] = parts;
        if (!['chat', 'global', 'character', 'message', 'script', 'extension'].includes(type)
            || (typeof id !== 'string' && typeof id !== 'number')
            || (['chat', 'global', 'character'].includes(type) && id !== '')
            || JSON.stringify(parts) !== key)
            throw new Error('Invalid scope');
    }
    const seed = JSON.stringify({ scopes: parsed.scopes }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const marker = '<script data-dsh-tavern-bridge>';
    if (!srcDoc.includes(marker))
        throw new Error('Missing card bridge');
    return srcDoc.replace(marker, `<script>window.__dshTavernVariables=${seed};</script>${marker}`);
}
/** 自包含函数会被序列化注入沙箱，不引用宿主状态，不发送主窗口消息。 */
export function installCardVariables(labels, styles = '') {
    const root = window;
    const holder = (root.__dshTavernVariables ??= { scopes: {} });
    let variablesUsed = Object.keys(holder.scopes).length > 0;
    const maxBytes = 1024 * 1024;
    function record(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function clone(value) {
        if (!record(value))
            throw new Error('Variables must be an object');
        const json = JSON.stringify(value);
        if (new TextEncoder().encode(json).length > maxBytes)
            throw new Error('Card variables exceed 1 MiB');
        const parsed = JSON.parse(json, (key, v) => {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype')
                throw new Error('Invalid variable key');
            return v;
        });
        if (!record(parsed))
            throw new Error('Variables must serialize to an object');
        return parsed;
    }
    function scope(option) {
        const opts = option === undefined ? { type: 'chat' } : option;
        if (!record(opts))
            throw new Error('Invalid variable scope');
        const type = opts.type;
        if (typeof type !== 'string' || !['chat', 'character', 'global', 'message', 'script', 'extension'].includes(type))
            throw new Error('Unsupported variable scope');
        const id = type === 'message' ? (opts.message_id ?? 'current')
            : type === 'script' ? (opts.script_id ?? 'current')
                : type === 'extension' ? opts.extension_id : '';
        if (typeof id !== 'string' && typeof id !== 'number')
            throw new Error('Invalid variable scope id');
        if (typeof id === 'number' && !Number.isFinite(id))
            throw new Error('Invalid variable scope id');
        return JSON.stringify([type, id]);
    }
    function getVariables(option) {
        const value = clone(holder.scopes[scope(option)] ?? {});
        requestBackup();
        return value;
    }
    function replaceVariables(value, option) {
        const next = clone(value);
        const scopes = clone({ ...holder.scopes, [scope(option)]: next });
        clone({ version: 1, scopes }); // 写入时保留备份封装预算，保证已接受的数据能导出并恢复。
        holder.scopes = scopes;
        requestBackup();
        return clone(next);
    }
    function merge(target, source, onlyMissing) {
        for (const key of Object.keys(source)) {
            const left = target[key], right = source[key];
            if (record(left) && record(right))
                target[key] = merge(left, right, onlyMissing);
            else if (!onlyMissing || !Object.prototype.hasOwnProperty.call(target, key))
                target[key] = right;
        }
        return target;
    }
    function insertOrAssignVariables(value, option) {
        return replaceVariables(merge(getVariables(option), clone(value), false), option);
    }
    function insertVariables(value, option) {
        return replaceVariables(merge(getVariables(option), clone(value), true), option);
    }
    const api = { getVariables, replaceVariables, insertOrAssignVariables, insertVariables };
    Object.assign(root, api);
    root.TavernHelper = Object.assign(record(root.TavernHelper) ? root.TavernHelper : {}, api);
    function requestBackup() {
        variablesUsed = true;
        if (document.readyState !== 'loading')
            mountBackup();
    }
    function mountBackup() {
        if (!variablesUsed || !document.body || document.getElementById('dsh-tavern-variable-backup'))
            return;
        const details = document.createElement('details');
        details.id = 'dsh-tavern-variable-backup';
        if (styles) {
            const style = document.createElement('style');
            style.textContent = styles;
            document.head.appendChild(style);
        }
        const summary = document.createElement('summary');
        summary.textContent = labels.title;
        const note = document.createElement('p');
        note.textContent = labels.note;
        const textarea = document.createElement('textarea');
        textarea.readOnly = true;
        textarea.setAttribute('aria-label', labels.text);
        const backup = document.createElement('button');
        backup.type = 'button';
        backup.textContent = labels.backup;
        backup.onclick = () => {
            textarea.value = JSON.stringify({ version: 1, scopes: holder.scopes });
            textarea.focus();
            textarea.select();
        };
        details.append(summary, note, backup, textarea);
        document.body.prepend(details);
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', mountBackup, { once: true });
    else
        mountBackup();
}
