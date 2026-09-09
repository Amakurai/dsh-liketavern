export function installCardLorebook(modern, codec) {
    const legacy = (entries) => entries.map(codec.toLegacy);
    const api = { getLorebooks: () => modern.getWorldbookNames(), createLorebook: (book) => modern.createWorldbook(book), deleteLorebook: (book) => modern.deleteWorldbook(book),
        getCharLorebooks: (options = {}) => {
            if (!options || typeof options !== 'object' || Array.isArray(options) || !['all', 'primary', 'additional'].includes(options.type ?? 'all'))
                throw new Error('旧角色世界书查询选项无效');
            const current = modern.getCharWorldbookNames(options.name ?? 'current');
            return { primary: options.type === 'additional' ? null : current.primary, additional: options.type === 'primary' ? [] : current.additional };
        },
        setCurrentCharLorebooks: (input) => modern.rebindCharWorldbooks('current', input, true),
        setChatLorebook: (input) => modern.rebindChatWorldbook('current', input),
        getCurrentCharPrimaryLorebook: () => modern.getCharWorldbookNames('current').primary,
        getChatLorebook: () => modern.getChatWorldbookName('current'), getOrCreateChatLorebook: (name) => modern.getOrCreateChatWorldbook('current', name),
        getLorebookEntries: async (book, options = {}) => {
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new Error('旧世界书查询选项无效');
            return codec.filter(legacy(await modern.getWorldbook(book)), options.filter);
        },
        replaceLorebookEntries: async (book, input) => { await modern.updateWorldbookWith(book, before => codec.replace(input, before)); },
        updateLorebookEntriesWith: async (book, updater) => {
            if (typeof updater !== 'function')
                throw new Error('旧世界书更新器必须是函数');
            return legacy(await modern.updateWorldbookWith(book, async (before) => codec.replace(await updater(legacy(before)), before)));
        },
        setLorebookEntries: async (book, input) => legacy(await modern.updateWorldbookWith(book, before => codec.patch(input, before))),
        createLorebookEntries: async (book, input) => {
            const result = await modern.createWorldbookEntries(book, codec.replace(input));
            return { entries: legacy(result.worldbook), new_uids: result.new_entries.map(entry => entry.uid) };
        },
        deleteLorebookEntries: async (book, input) => {
            const ids = new Set(codec.ids(input)), result = await modern.deleteWorldbookEntries(book, entry => ids.has(entry.uid));
            return { entries: legacy(result.worldbook), delete_occurred: result.deleted_entries.length > 0 };
        },
    };
    Object.assign(window, api);
    const root = window;
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, api);
}
