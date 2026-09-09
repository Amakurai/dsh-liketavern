/** 固定剧情的消息批量编辑：数据原子保存，正文在独立分支回滚后绑定显式数据，不自动发信。 */
import { assertHelperMvuWritable } from './helperMvu.js';
import { join } from 'node:path';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { Wal } from '../state/wal.js';
import { helperJson, helperTable } from '../core/helperRuntime.js';
import { loadHelperState, saveHelperState } from '../state/helper.js';
import { isSyntheticUserText } from '../core/dshPrompt.js';
import { parseHelperMessageEdits } from '../core/helperChatEdits.js';
import { getHelperSnapshot, helperHistoryOf, helperHistoryRevision, withHelperStoryWrite } from './helperRuntime.js';
import { forkEditedHistory } from './floors.js';
import { editedHistorySeed } from './helperChatSeed.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
export async function editHelperMessages(ctx, state, sessionId, messageId, request) {
    const edits = parseHelperMessageEdits(request.edits), initial = await state.loadBinding(sessionId);
    if (!initial?.storyId || initial.storyId !== request.storyId)
        throw new Error('消息编辑剧情绑定已改变');
    const ws = await state.storyWorkspace(initial.cardId, initial.storyId);
    return withWorkspaceLock(ws.fs.root, () => withWorkspaceLock(state.paths.sessions, async () => {
        const binding = await state.loadBinding(sessionId), source = ctx.sessions.get(sessionId);
        if (!source)
            throw new Error('消息编辑需要当前会话在线');
        if (!binding || binding.cardId !== initial.cardId || binding.storyId !== request.storyId)
            throw new Error('消息编辑剧情绑定已改变');
        if (!state.config.interactiveCards || binding.interactiveCards === false)
            throw new Error('交互卡已关闭');
        await assertHelperMvuWritable(state, sessionId);
        const snapshot = await getHelperSnapshot(ctx, state, sessionId, messageId);
        if (!snapshot.writable)
            throw new Error('生成期间不能编辑聊天消息');
        if (snapshot.historyRevision !== request.historyRevision)
            throw new Error('聊天历史已改变，请刷新后重试');
        const events = source.snapshotEvents(), history = helperHistoryOf(events, { char: '', user: '' }), changed = new Map(), deleted = new Set(), deletedIdentities = new Set(), seen = new Set();
        if (helperHistoryRevision(history) !== snapshot.historyRevision)
            throw new Error('读取快照期间聊天历史已改变');
        const verify = async () => {
            const current = await state.loadBinding(sessionId);
            if (current?.storyId !== binding.storyId || current?.cardId !== binding.cardId || source.snapshotEvents().length !== events.length || state.openFloors.has(sessionId))
                throw new Error('消息编辑期间会话已改变');
        };
        const expected = parseHelperMessageEdits(request.before ?? []), saved = await loadHelperState(ws.fs);
        const equal = (a, b) => JSON.stringify(helperJson(a)) === JSON.stringify(helperJson(b));
        const metadata = [];
        const consumed = new Set();
        for (const edit of edits) {
            const index = edit.message_id < 0 ? history.length + edit.message_id : edit.message_id, target = history[index];
            if (!target || seen.has(index))
                throw new Error('消息序号越界或重复指向同一条消息');
            if (edit.delete) {
                seen.add(index);
                deleted.add(target.seq);
                deletedIdentities.add(target.identity);
                continue;
            }
            const currentBook = snapshot.messages[index].swipe ?? { active: 0, pages: [{ message: target.message, data: snapshot.messages[index].data, extra: snapshot.messages[index].extra }] };
            const selected = edit.pages?.pages[edit.pages.active];
            if (selected)
                for (const key of ['message', 'data', 'extra'])
                    if (edit[key] !== undefined && !equal(edit[key], selected[key]))
                        throw new Error('选中页与消息字段不一致');
            const text = selected?.message ?? edit.message;
            if (text !== undefined && target.role === 'user' && isSyntheticUserText(text))
                throw new Error('用户正文不能改为宿主保留的合成指令');
            seen.add(index);
            if (text !== undefined && (target.message !== text || edit.pages && edit.pages.active !== currentBook.active))
                changed.set(target.seq, text);
            if (edit.data !== undefined || edit.extra !== undefined || edit.pages !== undefined) {
                const old = expected.find(row => row.message_id === edit.message_id);
                if (!old || old.message !== undefined || Object.hasOwn(old, 'data') !== Object.hasOwn(edit, 'data') || Object.hasOwn(old, 'extra') !== Object.hasOwn(edit, 'extra') || Object.hasOwn(old, 'pages') !== Object.hasOwn(edit, 'pages'))
                    throw new Error('消息数据编辑缺少原值，请刷新后重试');
                consumed.add(old.message_id);
                if (edit.pages && !equal(currentBook, old.pages) && !equal(currentBook, edit.pages))
                    throw new Error('消息页已被另一卡面修改，请刷新后重试');
                for (const field of ['data', 'extra']) {
                    if (edit[field] === undefined)
                        continue;
                    const current = field === 'data' ? saved.scopes[JSON.stringify(['message', target.identity])] ?? {} : saved.extras[target.identity] ?? {};
                    if (!equal(current, old[field]) && !equal(current, edit[field]))
                        throw new Error('消息数据已被另一卡面修改，请刷新后重试');
                }
                metadata.push({ seq: target.seq, ...(selected ? { data: selected.data, extra: selected.extra, pages: edit.pages } : {}), ...(edit.data !== undefined ? { data: edit.data } : {}), ...(edit.extra !== undefined ? { extra: edit.extra } : {}) });
            }
        }
        if (consumed.size !== expected.length)
            throw new Error('消息编辑原值与目标不匹配');
        const apply = (base, targets) => {
            // 分支传入的是草稿 WAL 回滚后的状态；保留其 MVU 回执，不能重新复制来源剧情的已撤销楼层。
            const next = { ...base, scopes: { ...base.scopes }, extras: { ...base.extras }, swipes: { ...base.swipes } };
            for (const identity of deletedIdentities) {
                delete next.scopes[JSON.stringify(['message', identity])];
                delete next.extras[identity];
                delete next.swipes[identity];
            }
            for (const row of metadata) {
                const identity = targets.find(target => target.seq === row.seq)?.identity;
                if (!identity)
                    throw new Error('编辑后消息身份不存在');
                if (row.data !== undefined)
                    next.scopes[JSON.stringify(['message', identity])] = row.data;
                if (row.extra !== undefined)
                    next.extras[identity] = row.extra;
                if (row.pages !== undefined)
                    next.swipes[identity] = row.pages;
            }
            helperTable(next.scopes);
            helperTable(next.extras);
            helperTable(next.swipes);
            return next;
        };
        if (!changed.size && !deleted.size) {
            if (!metadata.length)
                return { branch: null };
            const next = apply(saved, history);
            await withHelperStoryWrite(ctx, state, sessionId, messageId, request.storyId, async (fs, begin) => {
                if (equal(saved.scopes, next.scopes) && equal(saved.extras, next.extras) && equal(saved.swipes ?? {}, next.swipes ?? {}))
                    return;
                await begin();
                await verify();
                await saveHelperState(fs, next);
            });
            return { branch: null, snapshot: await getHelperSnapshot(ctx, state, sessionId, messageId) };
        }
        const first = Math.min(...changed.keys(), ...deleted);
        let fromTurn = 0;
        for (const event of events) {
            if (event.seq > first)
                break;
            if (event.type === 'turn/start')
                fromTurn = event.data.turn;
            if (event.seq === first && event.type === 'assistant/message')
                fromTurn = event.data.turn;
        }
        const seed = editedHistorySeed(events, changed, deleted);
        const nextHistory = helperHistoryOf(seed, { char: '', user: '' }); // 发布前检查新历史与消息身份。
        const prepare = async (fs, childId) => {
            if (!metadata.length && !deleted.size)
                return;
            const base = await loadHelperState(fs), next = apply(base, nextHistory);
            if (equal(base.scopes, next.scopes) && equal(base.extras, next.extras) && equal(base.swipes ?? {}, next.swipes ?? {}))
                return;
            const boundary = [...events].reverse().find(event => event.type === 'turn/end'), turn = boundary?.type === 'turn/end' ? boundary.data.turn : 0;
            const floor = childId + '#t' + turn, wal = new Wal(join(fs.root, 'state', 'wal'));
            await wal.beginFloor(floor);
            await saveHelperState(new WorkspaceFs(fs.root, wal).withFloor(floor), next);
            await wal.commitFloor(floor);
        };
        return { branch: await forkEditedHistory({ ctx, state }, sessionId, binding.storyId, seed, fromTurn, verify, prepare, deleted.size && !changed.size ? '删除聊天消息' : '编辑聊天消息') };
    }));
}
