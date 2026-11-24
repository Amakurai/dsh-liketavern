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
export async function editHelperMessages(ctx, state, sessionId, messageId, request, beforeWrite) {
    const edits = parseHelperMessageEdits(request.edits), initial = await state.loadStoryBinding(sessionId);
    if (!initial?.storyId || initial.storyId !== request.storyId)
        throw new Error('消息编辑剧情绑定已改变');
    const ws = await state.storyWorkspace(initial.cardId, initial.storyId);
    return withWorkspaceLock(ws.fs.root, () => withWorkspaceLock(state.paths.sessions, async () => {
        const binding = await state.loadStoryBinding(sessionId, { waitForAdoption: false }), source = ctx.sessions.get(sessionId);
        if (!source)
            throw new Error('消息编辑需要当前会话在线');
        if (!binding || binding.cardId !== initial.cardId || binding.storyId !== request.storyId)
            throw new Error('消息编辑剧情绑定已改变');
        if (!state.config.interactiveCards || binding.interactiveCards === false)
            throw new Error('交互卡已关闭');
        await assertHelperMvuWritable(state, sessionId, { waitForAdoption: false });
        const snapshot = await getHelperSnapshot(ctx, state, sessionId, messageId, { waitForAdoption: false });
        if (!snapshot.writable)
            throw new Error('生成期间不能编辑聊天消息');
        if (snapshot.historyRevision !== request.historyRevision)
            throw new Error('聊天历史已改变，请刷新后重试');
        const events = source.snapshotEvents(), history = helperHistoryOf(events, { char: '', user: '' }), changed = new Map(), deleted = new Set(), deletedIdentities = new Set(), deletedEntries = [], seen = new Set();
        const turnBySeq = new Map();
        for (let i = 0, currentTurn = 0; i < events.length; i++) {
            const event = events[i];
            if (event.type === 'turn/start')
                currentTurn = event.data.turn;
            else if (event.type === 'assistant/message')
                turnBySeq.set(event.seq, event.data.turn);
            else if (event.type === 'user/message')
                turnBySeq.set(event.seq, currentTurn);
        }
        if (helperHistoryRevision(history) !== snapshot.historyRevision)
            throw new Error('读取快照期间聊天历史已改变');
        const verify = async () => {
            const current = await state.loadStoryBinding(sessionId, { waitForAdoption: false });
            if (current?.storyId !== binding.storyId || current?.cardId !== binding.cardId || source.snapshotEvents().length !== events.length || state.openFloors.has(sessionId))
                throw new Error('消息编辑期间会话已改变');
            beforeWrite?.(current);
        };
        const expected = parseHelperMessageEdits(request.before ?? []), saved = await loadHelperState(ws.fs);
        const expectedById = new Map(expected.map(row => [row.message_id, row]));
        beforeWrite?.(binding);
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
                deletedEntries.push({ seq: target.seq, identity: target.identity });
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
            const pageSwitched = edit.pages !== undefined && edit.pages.active !== currentBook.active && (edit.pages.pages.length === currentBook.pages.length || !equal(selected, currentBook.pages[currentBook.active]));
            seen.add(index);
            if (text !== undefined && (target.message !== text || pageSwitched)) {
                changed.set(target.seq, text);
                deletedIdentities.add(target.identity);
                deletedEntries.push({ seq: target.seq, identity: target.identity });
            }
            if (edit.data !== undefined || edit.extra !== undefined || edit.pages !== undefined) {
                const old = expectedById.get(edit.message_id);
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
        const apply = (base, targets, deletions = deletedIdentities, rows = metadata) => {
            // 分支传入的是草稿 WAL 回滚后的状态；保留其 MVU 回执，不能重新复制来源剧情的已撤销楼层。
            const next = { ...base, scopes: { ...base.scopes }, extras: { ...base.extras }, swipes: { ...base.swipes } };
            const identityBySeq = new Map(targets.map(target => [target.seq, target.identity]));
            for (const identity of deletions) {
                delete next.scopes[JSON.stringify(['message', identity])];
                delete next.extras[identity];
                delete next.swipes[identity];
            }
            for (const row of rows) {
                const identity = identityBySeq.get(row.seq);
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
                await verify();
                await begin();
                await saveHelperState(fs, next);
            }, beforeWrite, { waitForAdoption: false });
            return { branch: null, snapshot: await getHelperSnapshot(ctx, state, sessionId, messageId, { waitForAdoption: false }) };
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
            if (!metadata.length && !deletedIdentities.size)
                return;
            const wal = new Wal(join(fs.root, 'state', 'wal'));
            // 分层落盘的最低楼层不得早于草稿中仍活跃的最高楼层，否则回滚旧层时后置修改会触发 WAL 依赖冲突。
            let retainedMaxTurn = 0;
            for (const item of await wal.listFloors()) {
                if (item.rolledBack)
                    continue;
                const match = /#t([0-9]+)$/.exec(item.floor);
                const floorTurn = match ? Number(match[1]) : NaN;
                if (Number.isSafeInteger(floorTurn) && floorTurn > retainedMaxTurn)
                    retainedMaxTurn = floorTurn;
            }
            const byTurn = new Map();
            const bucket = (turn) => { let entry = byTurn.get(turn); if (!entry) {
                entry = { deletions: [], rows: [] };
                byTurn.set(turn, entry);
            } return entry; };
            for (const entry of deletedEntries)
                bucket(Math.max(turnBySeq.get(entry.seq) ?? 0, retainedMaxTurn)).deletions.push(entry.identity);
            for (const row of metadata)
                bucket(Math.max(turnBySeq.get(row.seq) ?? 0, retainedMaxTurn)).rows.push(row);
            let current = await loadHelperState(fs);
            for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
                const entry = byTurn.get(turn);
                const next = apply(current, nextHistory, entry.deletions, entry.rows);
                if (equal(current.scopes, next.scopes) && equal(current.extras, next.extras) && equal(current.swipes ?? {}, next.swipes ?? {}))
                    continue;
                const floor = childId + '#t' + turn;
                await wal.beginFloor(floor);
                await saveHelperState(new WorkspaceFs(fs.root, wal).withFloor(floor), next);
                await wal.commitFloor(floor);
                current = next;
            }
        };
        return { branch: await forkEditedHistory({ ctx, state }, sessionId, binding.storyId, seed, fromTurn, verify, prepare, deleted.size && !changed.size ? '删除聊天消息' : '编辑聊天消息', () => beforeWrite?.(binding)) };
    }));
}
