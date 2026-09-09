/** 用户在宿主对话框中粘贴备份后验证，再注入新的 iframe；真实会话恢复后的变量仍须通过剧情提交协议。 */
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
        if (!['chat', 'global', 'character', 'preset', 'message', 'script', 'extension'].includes(type)
            || (typeof id !== 'string' && typeof id !== 'number')
            || (['chat', 'global', 'character', 'preset'].includes(type) && id !== '')
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
export function installCardVariables(labels, styles = '', messageId, messageCount, showTools = false) {
    const root = window;
    if (styles && !document.getElementById('dsh-tavern-card-tools-style')) {
        const style = document.createElement('style');
        style.id = 'dsh-tavern-card-tools-style';
        style.textContent = styles;
        document.head.appendChild(style);
    }
    const holder = (root.__dshTavernVariables ??= { scopes: {} });
    const generation = (holder.generation ?? 0) + 1;
    holder.generation = generation;
    if (messageId !== undefined) {
        const legacyKey = JSON.stringify(['message', 'current']), currentKey = JSON.stringify(['message', messageId]);
        if (holder.scopes[legacyKey]) {
            holder.scopes[currentKey] ??= holder.scopes[legacyKey];
            delete holder.scopes[legacyKey];
        }
    }
    let variablesUsed = Object.keys(holder.scopes).length > 0;
    const maxBytes = 1024 * 1024;
    const schemas = new Map();
    let editorMounted = false;
    let editorDirty = () => false;
    root.__dshTavernVariableEditorDirty = () => holder.generation === generation && editorDirty();
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
        const snapshot = root.__dshTavernSnapshot;
        const currentId = snapshot?.currentMessageId ?? messageId, count = snapshot?.messages.length ?? messageCount;
        const opts = option === undefined ? { type: 'chat' } : option;
        if (!record(opts))
            throw new Error('Invalid variable scope');
        const type = opts.type;
        if (typeof type !== 'string' || !['chat', 'character', 'global', 'preset', 'message', 'script', 'extension'].includes(type))
            throw new Error('Unsupported variable scope');
        let id = type === 'message' ? (opts.message_id ?? 'current')
            : type === 'script' ? (opts.script_id ?? root.__dshTavernScriptId ?? 'current')
                : type === 'extension' ? opts.extension_id : '';
        if (type === 'message' && count !== undefined) {
            if (opts.message_id === undefined || id === 'latest')
                id = count - 1;
            else if (id === 'current')
                id = currentId ?? count - 1;
            else if (typeof id === 'number' && id < 0)
                id = count + id;
            if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= count)
                throw new Error('Message variable index out of range');
        }
        else if (type === 'message' && (id === 'latest' || id === 'current' || id === -1))
            id = messageId ?? 'current';
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
        if (root.__dshTavernDisplayLocked)
            throw new Error('卡面正在重绘，请等待完成');
        const next = clone(value);
        const scopes = clone({ ...holder.scopes, [scope(option)]: next });
        clone({ version: 1, scopes }); // 写入时保留备份封装预算，保证已接受的数据能导出并恢复。
        holder.scopes = scopes;
        const changed = root.__dshTavernVariableChanged;
        if (typeof changed === 'function')
            changed();
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
    function updateVariablesWith(updater, option) {
        if (typeof updater !== 'function')
            throw new Error('Variable updater must be a function');
        const key = scope(option), before = JSON.stringify(holder.scopes[key] ?? {});
        const snapshotGeneration = root.__dshTavernSnapshotGeneration;
        const value = updater(getVariables(option));
        const commit = (next) => {
            if (holder.generation !== generation)
                throw new Error('Card variable runtime has been disposed');
            if (root.__dshTavernSnapshotGeneration !== snapshotGeneration)
                throw new Error('Story snapshot changed while updater was running');
            // 异步回调挂起时不覆盖后续的用户写入，失败时完整保留原值。
            if (JSON.stringify(holder.scopes[key] ?? {}) !== before)
                throw new Error('Card variables changed while updater was running');
            return replaceVariables(next, option);
        };
        return value && typeof value.then === 'function' ? Promise.resolve(value).then(commit) : commit(value);
    }
    function deleteVariable(path, option) {
        if (typeof path !== 'string' || path.length > 4096)
            throw new Error('Invalid variable path');
        const lodash = root._;
        const parts = lodash.toPath(path);
        if (!parts.length || parts.length > 64 || parts.some(key => ['__proto__', 'constructor', 'prototype'].includes(key)))
            throw new Error('Invalid variable path');
        const value = getVariables(option);
        let parent = value;
        for (const key of parts.slice(0, -1)) {
            if ((!record(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, key)) {
                parent = null;
                break;
            }
            parent = parent[key];
        }
        const key = parts[parts.length - 1];
        const occurred = (record(parent) || Array.isArray(parent)) && Object.hasOwn(parent, key);
        if (occurred)
            delete parent[key];
        return { variables: occurred ? replaceVariables(value, option) : value, delete_occurred: occurred };
    }
    function getAllVariables() {
        const currentId = root.__dshTavernSnapshot?.currentMessageId ?? messageId;
        const result = {};
        for (const type of ['global', 'character', 'chat'])
            merge(result, getVariables({ type }), false);
        // 按当前快照顺序合入到本卡面为止的消息变量。
        const messages = Object.entries(holder.scopes).map(([key, value]) => ({ parts: JSON.parse(key), value }))
            .filter(({ parts: [type, id] }) => type === 'message' && (id === 'current' || typeof id === 'number' && (currentId === undefined || id <= currentId)))
            .sort((a, b) => Number(a.parts[1]) - Number(b.parts[1]));
        for (const message of messages)
            merge(result, clone(message.value), false);
        return clone(result);
    }
    function registerVariableSchema(schema, option) {
        if (holder.generation !== generation)
            throw new Error('Card variable runtime has been disposed');
        if (!record(schema) || typeof schema.safeParseAsync !== 'function')
            throw new Error('Variable schema must provide safeParseAsync');
        if (!record(option) || typeof option.type !== 'string' || !['global', 'preset', 'character', 'chat', 'message'].includes(option.type)
            || Object.keys(option).some(key => key !== 'type'))
            throw new Error('Invalid variable schema scope');
        schemas.set(String(option.type), schema);
        requestBackup();
    }
    const api = { getVariables, replaceVariables, insertOrAssignVariables, insertVariables, updateVariablesWith, deleteVariable, getAllVariables, registerVariableSchema };
    Object.assign(root, api);
    root.TavernHelper = Object.assign(record(root.TavernHelper) ? root.TavernHelper : {}, api);
    function requestBackup() {
        variablesUsed = true;
        if (document.readyState !== 'loading')
            mountBackup();
    }
    function mountBackup() {
        if (!showTools || !variablesUsed || !document.body)
            return;
        const existing = document.getElementById('dsh-tavern-variable-backup');
        if (existing) {
            mountEditor(existing);
            return;
        }
        const details = document.createElement('details');
        details.id = 'dsh-tavern-variable-backup';
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
        mountEditor(details);
    }
    /** Schema 与转换闭包始终留在本沙箱；只有显式编辑器保存才经过此校验，程序变量 API 不受约束。 */
    function mountEditor(container) {
        if (editorMounted)
            return;
        editorMounted = true;
        document.getElementById('dsh-tavern-variable-editor')?.remove();
        const panel = document.createElement('fieldset');
        panel.id = 'dsh-tavern-variable-editor';
        const legend = document.createElement('legend');
        legend.textContent = labels.editor ?? 'Edit variables';
        const scopeBox = document.createElement('fieldset'), scopeTitle = document.createElement('legend');
        scopeTitle.textContent = labels.scope ?? 'Scope';
        scopeBox.append(scopeTitle);
        let selection = 'chat';
        const scopeInputs = [];
        for (const [value, text] of [['global', labels.scopeGlobal ?? 'Global'], ['preset', labels.scopePreset ?? 'Preset'],
            ['character', labels.scopeCharacter ?? 'Character'], ['chat', labels.scopeChat ?? 'Chat'], ['message', labels.scopeMessage ?? 'Message']]) {
            const label = document.createElement('label'), option = document.createElement('input');
            option.type = 'radio';
            option.name = 'dsh-tavern-variable-scope';
            option.value = value;
            option.checked = value === selection;
            label.textContent = text;
            option.setAttribute('aria-label', text);
            label.append(option);
            scopeBox.append(label);
            scopeInputs.push({ input: option, value: value });
        }
        const targetLabel = document.createElement('label');
        targetLabel.textContent = labels.messageId ?? 'Message ID or latest';
        const target = document.createElement('input');
        target.type = 'text';
        target.value = 'latest';
        target.setAttribute('aria-label', labels.messageId ?? 'Message ID or latest');
        targetLabel.append(target);
        const input = document.createElement('textarea');
        input.maxLength = maxBytes;
        input.setAttribute('aria-label', labels.editorText ?? 'Variables JSON');
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        const button = (text) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; return node; };
        const load = button(labels.load ?? 'Load JSON'), validate = button(labels.validate ?? 'Validate'), save = button(labels.save ?? 'Save'), discard = button(labels.discard ?? 'Discard draft');
        panel.append(legend, scopeBox, targetLabel, load, input, validate, save, discard, status);
        container.append(panel);
        let draft, busy = false, failed = false;
        const conflict = () => new Error(labels.conflict ?? 'Variables or history changed. Keep this draft and reload before saving.');
        const dirty = () => failed || draft !== undefined && input.value !== draft.initialText;
        editorDirty = () => busy || dirty();
        const controls = () => {
            load.disabled = busy || dirty();
            discard.disabled = busy || !dirty();
            target.disabled = busy || dirty();
            for (const radio of scopeInputs) {
                radio.input.disabled = busy || dirty();
                radio.input.checked = radio.value === selection;
            }
            targetLabel.hidden = selection !== 'message';
            validate.disabled = save.disabled = busy || !draft;
            input.disabled = !draft;
        };
        const noteFailure = (error) => {
            const message = error instanceof Error ? error.message : record(error) && typeof error.message === 'string' ? error.message : String(error);
            status.textContent = (labels.failed ?? 'Not saved') + ': ' + message.slice(0, 2000);
            status.setAttribute('role', 'alert');
        };
        const selectedOption = () => {
            const option = { type: selection };
            if (selection === 'message') {
                const value = target.value.trim();
                option.message_id = value === 'latest' || value === 'current' ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
            }
            return option;
        };
        const loadDraft = () => {
            try {
                if (holder.generation !== generation || root.__dshTavernDisplayLocked)
                    throw conflict();
                const key = scope(selectedOption()), [type, id] = JSON.parse(key);
                const option = { type, ...(type === 'message' ? { message_id: id } : {}) };
                const value = clone(holder.scopes[key] ?? {}), text = JSON.stringify(value, null, 2);
                draft = { key, option, before: JSON.stringify(value), initialText: text, snapshotGeneration: root.__dshTavernSnapshotGeneration };
                input.value = text;
                failed = false;
                status.textContent = '';
                status.setAttribute('role', 'status');
            }
            catch (error) {
                noteFailure(error);
            }
            controls();
        };
        load.onclick = () => { if (!busy && !dirty())
            loadDraft(); };
        discard.onclick = () => { if (!busy)
            loadDraft(); };
        const changeScope = () => { draft = undefined; input.value = ''; status.textContent = ''; controls(); };
        for (const radio of scopeInputs)
            radio.input.onchange = () => {
                if (!busy && !dirty()) {
                    selection = radio.value;
                    changeScope();
                }
                else
                    controls();
            };
        target.onchange = () => { if (!busy && !dirty())
            changeScope(); };
        input.oninput = () => { controls(); if (dirty())
            status.textContent = labels.unsaved ?? 'Draft not saved'; };
        /** 转换结果必须仍是有界纯 JSON；拒绝静默丢失 function/undefined、循环和非 JSON 类实例。 */
        const jsonTable = (value) => {
            const seen = new Set();
            let bytes = 0;
            const walk = (item, depth) => {
                if (depth > 64)
                    throw new Error('Variable JSON exceeds 64 levels');
                let result;
                if (item === null || typeof item === 'boolean') {
                    bytes += 5;
                    result = item;
                }
                else if (typeof item === 'number' && Number.isFinite(item)) {
                    bytes += String(item).length;
                    result = item;
                }
                else if (typeof item === 'string') {
                    bytes += new TextEncoder().encode(JSON.stringify(item)).length;
                    result = item;
                }
                else {
                    if (!item || typeof item !== 'object')
                        throw new Error('Variable schema must return JSON data');
                    const prototype = Object.getPrototypeOf(item);
                    if (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype)
                        throw new Error('Variable schema must return plain JSON objects');
                    if (seen.has(item) || Object.getOwnPropertySymbols(item).length)
                        throw new Error('Invalid variable JSON');
                    seen.add(item);
                    bytes += 2;
                    const entries = Object.getOwnPropertyDescriptors(item);
                    if (Array.isArray(item)) {
                        if (Object.keys(entries).length !== item.length + 1)
                            throw new Error('Variable arrays must be continuous');
                        result = Array.from({ length: item.length }, (_, index) => {
                            const entry = entries[String(index)];
                            if (!entry || !('value' in entry) || !entry.enumerable)
                                throw new Error('Invalid variable array');
                            bytes++;
                            return walk(entry.value, depth + 1);
                        });
                    }
                    else {
                        const output = {};
                        for (const [key, entry] of Object.entries(entries)) {
                            if (['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in entry) || !entry.enumerable)
                                throw new Error('Invalid variable field');
                            bytes += new TextEncoder().encode(JSON.stringify(key)).length + 2;
                            output[key] = walk(entry.value, depth + 1);
                        }
                        result = output;
                    }
                    seen.delete(item);
                }
                if (bytes > maxBytes)
                    throw new Error('Card variables exceed 1 MiB');
                return result;
            };
            const result = walk(value, 0);
            if (!record(result))
                throw new Error('Variables must be an object');
            return result;
        };
        const check = (loaded, text, schema) => {
            if (holder.generation !== generation || draft !== loaded || root.__dshTavernDisplayLocked
                || root.__dshTavernSnapshotGeneration !== loaded.snapshotGeneration || input.value !== text
                || JSON.stringify(holder.scopes[loaded.key] ?? {}) !== loaded.before || schemas.get(String(loaded.option.type)) !== schema)
                throw conflict();
        };
        const run = async (saving) => {
            if (busy || !draft)
                return;
            busy = true;
            controls();
            const loaded = draft, text = input.value, schema = schemas.get(String(loaded.option.type));
            try {
                check(loaded, text, schema);
                if (new TextEncoder().encode(text).length > maxBytes)
                    throw new Error('Card variables exceed 1 MiB');
                let value = jsonTable(JSON.parse(text));
                if (schema) {
                    const outcome = await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error(labels.timeout ?? 'Variable validation timed out')), 15000);
                        Promise.resolve().then(() => schema.safeParseAsync(value)).then(resolve, reject).finally(() => clearTimeout(timer));
                    });
                    if (!record(outcome) || typeof outcome.success !== 'boolean')
                        throw new Error('Invalid variable schema result');
                    if (!outcome.success)
                        throw outcome.error ?? new Error('Variable schema validation failed');
                    value = jsonTable(outcome.data);
                }
                check(loaded, text, schema);
                if (!saving) {
                    failed = false;
                    status.textContent = labels.valid ?? 'Valid';
                    status.setAttribute('role', 'status');
                    return;
                }
                replaceVariables(value, loaded.option);
                loaded.before = JSON.stringify(value);
                status.textContent = labels.saving ?? 'Saving';
                const flush = root.flushHelperVariables;
                if (typeof flush === 'function')
                    await flush();
                if (holder.generation !== generation || draft !== loaded || root.__dshTavernSnapshotGeneration !== loaded.snapshotGeneration
                    || JSON.stringify(holder.scopes[loaded.key] ?? {}) !== loaded.before)
                    throw conflict();
                loaded.initialText = JSON.stringify(value, null, 2);
                if (input.value === text)
                    input.value = loaded.initialText;
                failed = false;
                status.textContent = dirty() ? labels.unsaved ?? 'Draft not saved'
                    : typeof flush === 'function' ? labels.saved ?? 'Saved' : labels.localSaved ?? 'Saved in this frame; export a backup before closing';
                status.setAttribute('role', 'status');
            }
            catch (error) {
                failed = true;
                noteFailure(error);
            }
            finally {
                busy = false;
                controls();
            }
        };
        validate.onclick = () => { void run(false); };
        save.onclick = () => { void run(true); };
        controls();
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', mountBackup, { once: true });
    else
        mountBackup();
}
