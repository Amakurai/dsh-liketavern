export function installCardWorldbook(initial, json, settingsCodec) {
    const root = window, source = 'dsh-tavern-card', epoch = crypto.randomUUID();
    let active = true, serial = 0, generation = 0, metadata = initial;
    const cache = new Map(), versions = new Map();
    const pending = new Map();
    const clone = (value) => JSON.parse(JSON.stringify(value));
    function request(action, resultAction, value) {
        if (!active)
            return Promise.reject(new Error('世界书运行时已关闭'));
        if (root.__dshTavernDisplayLocked)
            return Promise.reject(new Error('卡面正在重绘，请等待完成'));
        if (pending.size >= 4)
            return Promise.reject(new Error('世界书请求过多，请等待完成'));
        const id = epoch + ':' + (++serial);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('世界书通信超时，请重新读取确认')); }, 15000);
            pending.set(id, { action: resultAction, resolve, reject, timer });
            parent.postMessage({ source, action, requestId: id, storyId: metadata.storyId, bindingRevision: metadata.bindingRevision, ...value }, '*');
        });
    }
    const receive = (event) => {
        if (event.source !== parent)
            return;
        const value = event.data, current = pending.get(value?.requestId);
        if (!current || value?.source !== source || value.action !== current.action)
            return;
        pending.delete(value.requestId);
        clearTimeout(current.timer);
        if (value.ok === true)
            current.resolve(value);
        else
            current.reject(new Error(typeof value.error === 'string' ? value.error : '世界书操作失败'));
    };
    function name(value) { if (typeof value !== 'string' || !value.trim() || value.length > 256)
        throw new Error('世界书名称无效'); return value; }
    /** 只将标准 RegExp 内部数据转成原生键文本；访问器/函数/Symbol 等由有界 JSON 校验拒绝。 */
    function wire(input) {
        const seen = new Set();
        function walk(value, depth) {
            if (depth > 64)
                throw new Error('世界书数据嵌套过深');
            if (value instanceof RegExp) {
                const flags = [['hasIndices', 'd'], ['global', 'g'], ['ignoreCase', 'i'], ['multiline', 'm'], ['dotAll', 's'], ['unicode', 'u'], ['unicodeSets', 'v'], ['sticky', 'y']]
                    .filter(([key]) => Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get?.call(value)).map(([, flag]) => flag).join('');
                return '/' + Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(value) + '/' + flags;
            }
            if (!value || typeof value !== 'object')
                return value;
            if (Object.getOwnPropertySymbols(value).length || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
                throw new Error('世界书只接受普通 JSON 数据');
            if (seen.has(value))
                throw new Error('世界书数据包含循环');
            seen.add(value);
            const descriptors = Object.getOwnPropertyDescriptors(value);
            if (Array.isArray(value) && (Object.keys(descriptors).length !== value.length + 1 || Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))))
                throw new Error('世界书数组必须连续且不能带额外属性');
            for (const [key, descriptor] of Object.entries(descriptors))
                if (!(Array.isArray(value) && key === 'length') && (!('value' in descriptor) || !descriptor.enumerable))
                    throw new Error('世界书数据包含访问器');
            const result = Array.isArray(value) ? value.map(item => walk(item, depth + 1)) : Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, walk(descriptor.value, depth + 1)]));
            seen.delete(value);
            return result;
        }
        return json(walk(input, 0), 8 * 1024 * 1024);
    }
    function applyContext(next) {
        if (!active || !next || next.storyId !== metadata.storyId)
            throw new Error('世界书剧情绑定已改变');
        if (next.bindingRevision !== metadata.bindingRevision) {
            generation++;
            cache.clear();
        }
        metadata = clone(next);
    }
    let bindingQueue = Promise.resolve();
    function bind(kind, selection) {
        const pending = bindingQueue.then(async () => {
            const response = await request('helperWorldbookBind', 'helperWorldbookBindResult', { kind, selection: json(selection(), 16384) });
            const context = response.context;
            applyContext(context);
            return clone(context);
        });
        bindingQueue = pending.catch(() => undefined);
        return pending;
    }
    async function operation(book, kind, entries, revision, label) {
        name(book);
        const response = await request('helperWorldbookOperation', 'helperWorldbookResult', { name: book, operation: kind, ...(entries === undefined ? {} : { entries: wire(entries) }), ...(revision === undefined ? {} : { revision }), ...(label === undefined ? {} : { label }) });
        if (!active)
            throw new Error('世界书运行时已关闭');
        const result = clone(response.result);
        if (!result || typeof result !== 'object')
            throw new Error('世界书回执无效');
        if (result.context)
            applyContext(result.context);
        if (result.snapshot) {
            cache.set(book, clone(result.snapshot));
            cache.set(result.snapshot.name, clone(result.snapshot));
            if (!metadata.names.includes(result.snapshot.name))
                metadata = { ...metadata, names: [...metadata.names, result.snapshot.name] };
        }
        if (result.deleted) {
            const id = cache.get(book)?.name ?? book;
            cache.delete(book);
            cache.delete(id);
            metadata = { ...metadata, names: metadata.names.filter(name => name !== id), global: metadata.global.filter(name => name !== id), chat: metadata.chat === id ? null : metadata.chat, character: { primary: metadata.character.primary === id ? null : metadata.character.primary, additional: metadata.character.additional.filter(name => name !== id) } };
        }
        if (kind !== 'get')
            versions.set(book, (versions.get(book) ?? 0) + 1);
        return result;
    }
    async function readSnapshot(book) { const result = await operation(book, 'get'); if (!result.snapshot)
        throw new Error(result.missing ? '世界书不存在' : '世界书回执缺少条目'); return result.snapshot; }
    async function getWorldbook(book) { return clone((await readSnapshot(book)).entries); }
    const ensure = async (book) => cache.get(book) ?? await readSnapshot(book);
    async function replaceWorldbook(book, entries) { const current = await ensure(book); await operation(book, 'replace', entries, current.revision); }
    async function updateWorldbookWith(book, updater) {
        if (typeof updater !== 'function')
            throw new Error('世界书更新器必须为函数');
        const current = await readSnapshot(book), before = generation, version = versions.get(book) ?? 0, result = await updater(clone(current.entries));
        if (!active || generation !== before || (versions.get(book) ?? 0) !== version)
            throw new Error('等待期间世界书已改变');
        return clone((await operation(book, 'replace', result, current.revision)).snapshot.entries);
    }
    async function createWorldbookEntries(book, input) {
        if (!Array.isArray(input))
            throw new Error('新条目必须是数组');
        const current = await readSnapshot(book), entries = current.entries, ids = new Set(entries.map(entry => entry.uid));
        let next = 0;
        const data = wire(input);
        if (data.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
            throw new Error('世界书条目必须为对象');
        const added = data.map(item => { while (ids.has(next))
            next++; const uid = next++; ids.add(uid); return { ...item, uid }; });
        const saved = (await operation(book, 'replace', [...entries, ...added], current.revision)).snapshot.entries, newIds = new Set(added.map(entry => entry.uid));
        return { worldbook: clone(saved), new_entries: clone(saved.filter(entry => newIds.has(entry.uid))) };
    }
    async function deleteWorldbookEntries(book, predicate) {
        if (typeof predicate !== 'function')
            throw new Error('世界书删除条件必须为函数');
        const current = await readSnapshot(book), entries = current.entries, deleted = [], kept = [];
        for (const entry of entries) {
            const result = predicate(clone(entry));
            if (typeof result !== 'boolean')
                throw new Error('删除条件必须同步返回布尔值');
            (result ? deleted : kept).push(entry);
        }
        const saved = (await operation(book, 'replace', kept, current.revision)).snapshot.entries;
        return { worldbook: clone(saved), deleted_entries: clone(deleted) };
    }
    const settingsDrafts = new Map();
    let settingsRefreshing = false, settingsSerial = 0, settingsJobs = 0, settingsFailure = null, settingsTail = Promise.resolve();
    function getLorebookSettings() {
        if (!metadata.settings)
            throw new Error('宿主未提供世界书设置，请刷新');
        return clone(Object.assign({ ...metadata.settings, selected_global_lorebooks: metadata.global }, ...settingsDrafts.values()));
    }
    function setLorebookSettings(input) {
        if (root.__dshTavernDisplayLocked)
            throw new Error('卡面正在重绘，请等待完成');
        if (!active)
            throw new Error('世界书运行时已关闭');
        if (settingsRefreshing)
            throw new Error('世界书设置正在刷新，请等待完成');
        if (settingsFailure)
            throw new Error(settingsFailure + '；请刷新后重试');
        if (settingsJobs >= 64)
            throw new Error('世界书设置保存队列已满');
        const patch = settingsCodec.patch(input);
        getLorebookSettings();
        if (!Object.keys(patch).length)
            return;
        const id = ++settingsSerial;
        settingsDrafts.set(id, patch);
        settingsJobs++;
        settingsTail = bind('settings', () => { if (settingsFailure)
            throw new Error(settingsFailure); return patch; }).then(() => { settingsDrafts.delete(id); }, error => {
            settingsFailure = error instanceof Error ? error.message : String(error);
            const toastr = root.toastr;
            if (active)
                toastr?.error?.(settingsFailure);
        }).finally(() => { settingsJobs--; });
    }
    async function flushHelperWorldbookSettings() { await settingsTail; if (settingsFailure)
        throw new Error(settingsFailure); }
    async function refreshHelperWorldbooks(options = {}) {
        if (settingsRefreshing)
            throw new Error('世界书设置正在刷新，请等待完成');
        if (settingsJobs > 0)
            throw new Error('世界书设置仍在保存，请先等待');
        if (settingsDrafts.size && !options.discardUnsaved)
            throw new Error('世界书设置有未保存修改，请备份后明确放弃');
        settingsRefreshing = true;
        try {
            const response = await request('helperWorldbookContextGet', 'helperWorldbookContextResult', {});
            const next = response.context;
            if (!active || !next || next.storyId !== metadata.storyId)
                throw new Error('世界书剧情绑定已改变');
            applyContext(next);
            settingsDrafts.clear();
            settingsFailure = null;
            generation++;
            cache.clear();
            for (const key of versions.keys())
                versions.set(key, versions.get(key) + 1);
            return clone(metadata);
        }
        finally {
            settingsRefreshing = false;
        }
    }
    const api = { getLorebookSettings, setLorebookSettings, flushHelperWorldbookSettings, getHelperWorldbookSettingsStatus: () => ({ pending: settingsJobs, unsaved: settingsDrafts.size, error: settingsFailure }), getWorldbookNames: () => clone(metadata.names), getGlobalWorldbookNames: () => clone(metadata.global),
        getCharWorldbookNames: (character) => { if (character !== 'current' && character !== metadata.characterName)
            throw new Error('只能查询当前角色的世界书绑定'); return clone(metadata.character); },
        getChatWorldbookName: (chat) => { if (chat !== 'current')
            throw new Error('只能查询当前剧情世界书'); return metadata.chat; },
        rebindGlobalWorldbooks: async (input) => { const value = json(input, 16384); await bind('global', () => value); },
        rebindCharWorldbooks: async (character, input, partial = false) => { if (character !== 'current')
            throw new Error('只能修改当前角色世界书'); const value = json(input, 16384); if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('角色世界书绑定无效'); await bind('character', () => partial ? { ...metadata.character, ...value } : value); },
        rebindChatWorldbook: async (chat, input) => { if (chat !== 'current')
            throw new Error('只能修改当前聊天世界书'); const value = json(input, 16384); await bind('chat', () => value); },
        getWorldbook, replaceWorldbook, updateWorldbookWith, createWorldbookEntries, deleteWorldbookEntries, refreshHelperWorldbooks,
        createWorldbook: async (book, entries = []) => Boolean((await operation(book, 'create', entries)).created),
        createOrReplaceWorldbook: async (book, entries = []) => { const current = await operation(book, 'get'); return Boolean((await operation(book, 'upsert', entries, current.snapshot?.revision)).created); },
        deleteWorldbook: async (book) => { const current = await operation(book, 'get'); if (current.missing)
            return false; return Boolean((await operation(book, 'delete', undefined, current.snapshot.revision)).deleted); },
        getOrCreateChatWorldbook: async (chat, label) => { if (chat !== 'current')
            throw new Error('只能创建当前剧情世界书'); if (label !== undefined)
            name(label); const result = await bind('ensure-chat', () => label ?? null); if (!result.chat)
            throw new Error('聊天世界书回执缺少绑定'); return result.chat; },
    };
    Object.assign(root, api);
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, api);
    window.addEventListener('message', receive);
    return () => { active = false; window.removeEventListener('message', receive); for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('世界书运行时已关闭'));
    } pending.clear(); };
}
