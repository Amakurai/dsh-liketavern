export function installCardLegacyChat(json) {
    const root = window, st = root.SillyTavern;
    const previousContext = st.getContext, previousSlash = root.triggerSlash;
    const read = root.getChatMessages;
    const write = (rows, option) => root.setChatMessages(rows, option);
    const clone = (value) => json(value, 12 * 1024 * 1024);
    const equal = (a, b) => JSON.stringify(clone(a)) === JSON.stringify(clone(b));
    const snapshot = () => root.__dshTavernSnapshot;
    const all = () => read('0-' + (snapshot().messages.length - 1), { include_swipes: true }).map(row => ({ ...row, variables: clone(row.swipes_data), swipe_info: clone(row.swipes_info) }));
    let active = true, draft;
    function check(current) {
        if (!active)
            throw new Error('旧消息运行时已关闭');
        const now = snapshot();
        if (!now || current && (now.storyId !== current.storyId || now.historyRevision !== current.historyRevision))
            throw new Error('上下文聊天历史已改变，请备份草稿并重新打开卡面');
    }
    function getDraft() {
        check();
        if (!draft || !draft.busy && equal(draft.rows, draft.confirmed) && (draft.generation !== root.__dshTavernSnapshotGeneration || !equal(draft.confirmed, all()))) {
            const now = snapshot(), rows = clone(all());
            draft = { rows, confirmed: clone(rows), storyId: now.storyId, historyRevision: now.historyRevision, generation: root.__dshTavernSnapshotGeneration, busy: false };
        }
        return draft;
    }
    async function save(current) {
        check(current);
        if (current.busy)
            throw new Error('上下文聊天仍在保存，请等待完成');
        const sent = clone(current.rows);
        if (sent.length !== current.confirmed.length || sent.some((row, index) => row.message_id !== current.confirmed[index]?.message_id))
            throw new Error('上下文暂不支持插入、删除或重排消息');
        const fresh = all(), changed = sent.filter((row, index) => !equal(row, current.confirmed[index]));
        for (const row of changed) {
            const before = current.confirmed.find(item => item.message_id === row.message_id), now = fresh.find(item => item.message_id === row.message_id);
            if (!now || !equal(now, before))
                throw new Error('上下文消息已被修改，保留草稿，请备份后重新读取');
        }
        if (!changed.length)
            return;
        const normalized = changed.map(row => {
            const before = current.confirmed.find(item => item.message_id === row.message_id), next = { ...row };
            for (const [legacy, modern] of [['variables', 'swipes_data'], ['swipe_info', 'swipes_info']]) {
                if (!Object.hasOwn(row, legacy))
                    throw new Error('上下文消息缺少页数据字段');
                if (!equal(row[legacy], before[legacy])) {
                    if (!equal(row[modern], before[modern]) && !equal(row[legacy], row[modern]))
                        throw new Error('上下文页数据别名互相冲突');
                    next[modern] = row[legacy];
                }
                delete next[legacy];
            }
            return next;
        });
        current.busy = true;
        try {
            await write(normalized, { refresh: 'none' });
            if (!active)
                throw new Error('卡面已关闭，请在会话列表检查保存结果');
            if (root.__dshTavernMessageBranch || current.generation === root.__dshTavernSnapshotGeneration)
                return; // 分支回执不替换旧会话草稿；等待导航或手动打开子会话。
            const confirmed = clone(all());
            // 保存期间继续编辑的行保留；未继续编辑的行采用宿主确认值，数组引用保持不变。
            for (let index = 0; index < current.rows.length; index++) {
                const row = current.rows[index], before = sent[index], next = confirmed[index];
                if (!row || !before || !next || row.message_id !== before.message_id || row.message_id !== next.message_id)
                    continue;
                for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
                    if (Object.hasOwn(row, key) !== Object.hasOwn(before, key) || Object.hasOwn(row, key) && !equal(row[key], before[key]))
                        continue;
                    if (Object.hasOwn(next, key))
                        row[key] = clone(next[key]);
                    else
                        delete row[key];
                }
            }
            current.confirmed = confirmed;
            current.generation = root.__dshTavernSnapshotGeneration;
        }
        finally {
            current.busy = false;
        }
    }
    async function setChatMessage(field, messageId = root.getCurrentMessageId(), option = {}) {
        check();
        const settings = clone(option);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['swipe_id', 'refresh'].includes(key)))
            throw new Error('旧消息选项无效');
        const row = { message_id: messageId };
        if (Object.hasOwn(settings, 'swipe_id'))
            row.swipe_id = settings.swipe_id;
        if (typeof field === 'string' && (field !== '' || !Object.hasOwn(settings, 'swipe_id')))
            row.message = field;
        else if (field !== null && field !== undefined && field !== '')
            throw new Error('旧消息正文必须是字符串');
        if (Object.keys(row).length === 1)
            throw new Error('旧消息调用没有指定正文或页下标');
        return write([row], Object.hasOwn(settings, 'refresh') ? { refresh: settings.refresh } : {});
    }
    async function swipe(value) {
        check();
        const id = root.getCurrentMessageId(), row = read(id, { include_swipes: true })[0];
        if (!row || !Array.isArray(row.swipes) || !row.swipes.length || typeof row.swipe_id !== 'number')
            throw new Error('当前消息没有可切换的页');
        const absolute = value !== undefined && /^\d+$/.test(value);
        const index = absolute ? Number(value) : (row.swipe_id + (value === 'left' ? -1 : 1) + row.swipes.length) % row.swipes.length;
        await write([{ message_id: id, swipe_id: index }]);
    }
    async function triggerSlash(command) {
        check();
        if (typeof command !== 'string' || command.length > 4096)
            throw new Error('Slash 命令无效或超限');
        const match = /^\/swipe(?:\s+(\d+|left|right))?\s*$/i.exec(command.trim());
        if (!match)
            return previousSlash(command);
        await swipe(match[1]?.toLowerCase());
        return '';
    }
    st.getContext = () => {
        const current = getDraft(), context = { ...previousContext(), chat: current.rows,
            swipe: async () => { check(current); await swipe(); },
            saveChat: async () => { if (context.chat !== current.rows)
                throw new Error('不能替换上下文聊天数组'); await save(current); } };
        return context;
    };
    root.__dshTavernLegacyChatDirty = () => Boolean(draft && (draft.busy || !equal(draft.rows, draft.confirmed)));
    Object.assign(root, { setChatMessage, triggerSlash });
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, { setChatMessage, triggerSlash });
    return () => { active = false; };
}
