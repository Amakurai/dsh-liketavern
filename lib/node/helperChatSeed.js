/** 消息编辑分支的 seed：保留日志序号和后续正文，以可忽略标记替代过时压缩与已改正文的流式片段。 */
import { Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
function marker(event, reason) { return { type: 'tavern/message-edit-marker', seq: event.seq, time: event.time, ignorable: true, data: { originalType: event.type, reason } }; }
function editedContent(blocks, text) {
    let placed = false;
    const edited = blocks.flatMap(block => { if (block.type !== 'text')
        return [block]; if (placed)
        return []; placed = true; return [{ type: 'text', text }]; });
    // 工具调用或推理独占的回复原本没有 text 块，正文编辑仍须实际写入，而不能只换消息身份。
    return placed ? edited : [...edited, { type: 'text', text }];
}
function staleCompactionSeqs(events, first, removed) {
    const stale = new Set();
    let open, summarized = false;
    for (const [index, event] of events.entries()) {
        const type = String(event.type);
        const isReplacement = 'surfaceOp' in event && Boolean(event.surfaceOp) && event.surfaceOp !== 'append';
        const isCheckpoint = event.type === 'user/message' && isReplacement && event.data.source.kind === 'compact-checkpoint';
        if (type === 'compaction/start') {
            if (open)
                for (const seq of open)
                    stale.add(seq);
            open = [event.seq];
            summarized = false;
            if (event.seq >= first)
                stale.add(event.seq);
            continue;
        }
        if (type === 'compaction/summary') {
            if (open) {
                open.push(event.seq);
                summarized = true;
                if (event.seq >= first)
                    stale.add(event.seq);
            }
            else
                stale.add(event.seq);
            continue;
        }
        if (isCheckpoint) {
            if (open) {
                open.push(event.seq);
                if (event.seq >= first)
                    stale.add(event.seq);
            }
            else
                stale.add(event.seq);
            continue;
        }
        if (type === 'compaction/end' || type === 'session/end-seed') {
            if (open) {
                const failed = type === 'compaction/end' && event.data.error !== undefined;
                if (event.seq >= first || type === 'compaction/end' && !failed && !summarized || open.some(seq => stale.has(seq))) {
                    for (const seq of open)
                        stale.add(seq);
                    if (type === 'compaction/end')
                        stale.add(event.seq);
                }
                open = undefined;
                summarized = false;
            }
            else if (type === 'compaction/end')
                stale.add(event.seq);
            continue;
        }
        if (type === 'compaction/prune') {
            const next = events[index + 1];
            const paired = next?.type === 'tool/result' && 'surfaceOp' in next && Boolean(next.surfaceOp) && next.surfaceOp !== 'append' && next.seq < first && !removed.has(next.seq);
            if (event.seq >= first || !paired)
                stale.add(event.seq);
            continue;
        }
        if (event.seq >= first && (type.startsWith('compaction/') || type === 'image/offload' || isReplacement))
            stale.add(event.seq);
    }
    if (open)
        for (const seq of open)
            stale.add(seq);
    return stale;
}
function citesRemovedMessage(event, removed) {
    const type = String(event.type);
    if (type !== 'session/title' && type !== 'session/title-llm-request')
        return false;
    const seqs = event.data.messageSeqs;
    return Array.isArray(seqs) && seqs.some(seq => typeof seq === 'number' && removed.has(seq));
}
export function editedHistorySeed(events, edits, deleted = new Set()) {
    if (!edits.size && !deleted.size)
        return [...events];
    const eventSeqs = new Set(events.map(event => event.seq));
    if ([...deleted].some(seq => !eventSeqs.has(seq)))
        throw new Error('删除目标不在日志中');
    const removed = new Set(deleted), deleteSteps = new Set(), steps = new Set();
    for (const event of events)
        if (deleted.has(event.seq)) {
            if (edits.has(event.seq) || !['user/message', 'assistant/message'].includes(event.type) || 'surfaceOp' in event && event.surfaceOp !== undefined && event.surfaceOp !== 'append')
                throw new Error('删除目标不是独立可见消息');
            if (event.type === 'assistant/message')
                deleteSteps.add(event.data.turn + ':' + event.data.step);
        }
    for (const event of events) {
        if (!['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type))
            continue;
        const data = event.data;
        if (!deleteSteps.has(data.turn + ':' + data.step))
            continue;
        if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !deleted.has(event.seq))
            throw new Error('删除目标与另一条 assistant 消息共用步骤');
        removed.add(event.seq);
    }
    const first = Math.min(...edits.keys(), ...removed), staleCompactions = staleCompactionSeqs(events, first, removed);
    for (const event of events)
        if (edits.has(event.seq) && event.type === 'assistant/message')
            steps.add(event.data.turn + ':' + event.data.step);
    const seed = events.map(event => {
        if (removed.has(event.seq) || citesRemovedMessage(event, removed))
            return marker(event, 'deleted-message');
        if (staleCompactions.has(event.seq))
            return marker(event, 'stale-compaction');
        if (event.type === 'assistant/attempt' && steps.has(event.data.turn + ':' + event.data.step))
            return marker(event, 'edited-stream');
        const text = edits.get(event.seq);
        if (text === undefined)
            return event;
        if (event.type === 'user/message') {
            const message = createUserMessage({ source: event.data.source, content: editedContent(event.data.content, text) });
            const { sourceEventSeqs: _sources, ...rest } = event;
            return { ...rest, data: message };
        }
        if (event.type === 'assistant/message') {
            if (typeof event.data.message.source.provider !== 'string' || typeof event.data.message.source.model !== 'string')
                throw new Error('历史 assistant 消息缺少宿主模型来源');
            const message = createAssistantMessage({ source: { provider: event.data.message.source.provider, model: event.data.message.source.model }, content: editedContent(event.data.message.content, text) });
            const { sourceEventSeqs: _sources, ...rest } = event, { interrupted: _interrupted, ...data } = event.data;
            return { ...rest, data: { ...data, message, stream: [] } };
        }
        throw new Error('目标不是可见消息');
    });
    // 与实际宿主使用同一个 seed 校验器，拒绝坏引用/不连续日志后才允许复制剧情和发布。
    Session.create('session-tavern-edit-validation', seed);
    return seed;
}
