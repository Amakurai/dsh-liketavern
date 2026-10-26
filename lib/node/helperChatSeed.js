/** 消息编辑分支的 seed：保留日志序号和后续正文，以可忽略标记替代过时压缩与已改正文的流式片段。 */
import { Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { isHostInjectedUserMessage, isSyntheticUserText } from '../core/dshPrompt.js';
function marker(event, reason) { return { type: 'tavern/message-edit-marker', seq: event.seq, time: event.time, ignorable: true, data: { originalType: event.type, reason } }; }
function editedContent(blocks, text) {
    let placed = false;
    const edited = blocks.flatMap(block => { if (block.type !== 'text')
        return [block]; if (placed)
        return []; placed = true; return [{ type: 'text', text }]; });
    // 工具调用或推理独占的回复原本没有 text 块，正文编辑仍须实际写入，而不能只换消息身份。
    return placed ? edited : [...edited, { type: 'text', text }];
}
function isEditableVisibleMessage(event) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message')
        return false;
    if ('surfaceOp' in event && event.surfaceOp !== undefined && event.surfaceOp !== 'append')
        return false;
    if (event.type === 'user/message') {
        if (isHostInjectedUserMessage(event.data))
            return false;
        const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (isSyntheticUserText(text))
            return false;
    }
    return true;
}
function hasVisibleAssistantText(event) {
    return event.type === 'assistant/message' && event.surfaceOp === 'append' && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0);
}
function hasActiveStepAfter(events, afterSeq, stale, removed) {
    for (const event of events) {
        if (event.seq <= afterSeq || stale.has(event.seq) || removed.has(event.seq))
            continue;
        if (['system/message', 'user/message', 'developer/message', 'request/header', 'assistant/message', 'assistant/attempt'].includes(String(event.type)))
            return true;
    }
    return false;
}
function staleCompactionSeqs(events, first, removed) {
    const stale = new Set(), staleCommandIds = new Set();
    const addStale = (seq) => {
        if (stale.has(seq))
            return false;
        stale.add(seq);
        return true;
    };
    const addCommandId = (id) => {
        if (typeof id !== 'string' || staleCommandIds.has(id))
            return false;
        staleCommandIds.add(id);
        return true;
    };
    let changed = false;
    do {
        changed = false;
        const pairedPruneResults = new Set();
        const checkpointedShadowedSystems = [];
        const surface = [];
        let open, surfaceSeen = false, initialProtectedHead, protectedHead;
        const markOpenStale = (item) => {
            for (const seq of item.seqs)
                if (addStale(seq))
                    changed = true;
            if (addCommandId(item.commandId))
                changed = true;
        };
        const collectShadowedSystems = (seqs) => {
            if (!Array.isArray(seqs))
                return [];
            const liveSurface = new Set(surface), out = [];
            for (const seq of seqs)
                if (typeof seq === 'number' && seq !== initialProtectedHead && seq !== protectedHead && liveSurface.has(seq)) {
                    const target = events[seq];
                    if (target?.type === 'system/message' && target.surfaceOp === 'append')
                        out.push(seq);
                }
            return out;
        };
        const replaceSurface = (startSeq, endSeq, replacementSeq, sourceEventSeqs, expectedShadowed) => {
            if (typeof startSeq !== 'number' || typeof endSeq !== 'number')
                return false;
            const startIdx = surface.indexOf(startSeq), endIdx = surface.indexOf(endSeq);
            if (startIdx < 0 || endIdx < 0 || startIdx > endIdx)
                return false;
            const shadowed = surface.slice(startIdx, endIdx + 1);
            if (expectedShadowed !== undefined && (!Array.isArray(expectedShadowed) || shadowed.length !== expectedShadowed.length || shadowed.some((seq, idx) => seq !== expectedShadowed[idx])))
                return false;
            if (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length === 0)
                return false;
            const sources = new Set();
            for (const source of sourceEventSeqs) {
                if (typeof source !== 'number' || source >= replacementSeq || stale.has(source) || removed.has(source))
                    return false;
                sources.add(source);
            }
            if (sources.size !== sourceEventSeqs.length || shadowed.some(seq => !sources.has(seq)))
                return false;
            surface.splice(startIdx, endIdx - startIdx + 1, replacementSeq);
            return true;
        };
        for (const [index, event] of events.entries()) {
            const type = String(event.type);
            const isSurface = 'surfaceOp' in event && event.surfaceOp !== undefined;
            if (isSurface && !surfaceSeen && !removed.has(event.seq) && !stale.has(event.seq)) {
                surfaceSeen = true;
                if (event.type === 'system/message' && event.surfaceOp === 'append') {
                    initialProtectedHead = event.seq;
                    protectedHead = event.seq;
                }
            }
            const isReplacement = 'surfaceOp' in event && Boolean(event.surfaceOp) && event.surfaceOp !== 'append';
            const isCheckpoint = event.type === 'user/message' && isReplacement && event.data.source.kind === 'compact-checkpoint';
            if (open?.awaitingCheckpoint && !isCheckpoint) {
                markOpenStale(open);
                open = undefined;
            }
            if (open && (type === 'turn/start' || type === 'turn/end')) {
                open.crossedTurn = true;
                continue;
            }
            if (type === 'command/run') {
                const data = event.data;
                if (data.name === 'compact' && typeof data.commandId === 'string' && (event.seq >= first || staleCommandIds.has(data.commandId))) {
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(data.commandId))
                        changed = true;
                }
                continue;
            }
            if (type === 'command/done') {
                const data = event.data;
                const commandId = typeof data.commandId === 'string' ? data.commandId : undefined;
                const brokenSource = typeof data.sourceEventSeq === 'number' && (stale.has(data.sourceEventSeq) || removed.has(data.sourceEventSeq));
                if (commandId && staleCommandIds.has(commandId) || brokenSource) {
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(commandId))
                        changed = true;
                }
                continue;
            }
            if (type === 'compaction/start') {
                if (open)
                    markOpenStale(open);
                const data = event.data;
                const commandId = typeof data.sourceCommandId === 'string' ? data.sourceCommandId : undefined;
                open = { seqs: [event.seq], id: data.compactionId, commandId, turn: data.turn, summarized: false, checkpointed: false, awaitingCheckpoint: false, crossedTurn: false };
                if (event.seq >= first || stale.has(event.seq) || commandId && staleCommandIds.has(commandId))
                    markOpenStale(open);
                continue;
            }
            if (type === 'compaction/summary') {
                const data = event.data;
                const commandId = typeof data.sourceCommandId === 'string' ? data.sourceCommandId : undefined;
                if (open && !open.crossedTurn && !open.summarized && !open.checkpointed && data.compactionId === open.id && commandId === open.commandId && data.shadowedRange && typeof data.shadowedRange.start === 'number' && typeof data.shadowedRange.end === 'number') {
                    open.seqs.push(event.seq);
                    open.summarized = true;
                    open.shadowedRange = data.shadowedRange;
                    open.shadowedSeqs = data.shadowedSeqs;
                    open.awaitingCheckpoint = true;
                    if (event.seq >= first || stale.has(event.seq) || open.commandId && staleCommandIds.has(open.commandId))
                        markOpenStale(open);
                }
                else {
                    if (open) {
                        markOpenStale(open);
                        open = undefined;
                    }
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(commandId))
                        changed = true;
                }
                continue;
            }
            if (isCheckpoint) {
                const source = event.data.source;
                const commandId = typeof source.sourceCommandId === 'string' ? source.sourceCommandId : undefined;
                const surfaceOp = event.surfaceOp;
                const matchesRange = Boolean(open?.shadowedRange && surfaceOp.op === 'replace' && surfaceOp.startSeq === open.shadowedRange.start && surfaceOp.endSeq === open.shadowedRange.end);
                if (open && !open.crossedTurn && open.summarized && !open.checkpointed && source.compactionId === open.id && commandId === open.commandId && matchesRange) {
                    open.seqs.push(event.seq);
                    open.checkpointed = true;
                    open.awaitingCheckpoint = false;
                    const shadowedSystems = collectShadowedSystems(open.shadowedSeqs);
                    const tainted = event.seq >= first || stale.has(event.seq) || open.seqs.some(seq => stale.has(seq)) || Boolean(open.commandId && staleCommandIds.has(open.commandId));
                    const validReplace = !tainted && surfaceOp.startSeq !== protectedHead && replaceSurface(surfaceOp.startSeq, surfaceOp.endSeq, event.seq, event.sourceEventSeqs, open.shadowedSeqs);
                    if (!validReplace) {
                        if (shadowedSystems.length)
                            checkpointedShadowedSystems.push({ checkpointSeq: event.seq, systemSeqs: shadowedSystems });
                        markOpenStale(open);
                    }
                }
                else {
                    if (open) {
                        markOpenStale(open);
                        open = undefined;
                    }
                    const shadowedSystems = collectShadowedSystems(event.sourceEventSeqs);
                    if (shadowedSystems.length)
                        checkpointedShadowedSystems.push({ checkpointSeq: event.seq, systemSeqs: shadowedSystems });
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(commandId))
                        changed = true;
                }
                continue;
            }
            if (type === 'compaction/end' || type === 'session/end-seed') {
                if (open) {
                    const data = event.data;
                    const commandId = type === 'compaction/end' && typeof data.sourceCommandId === 'string' ? data.sourceCommandId : undefined;
                    const failed = type === 'compaction/end' && data.error !== undefined;
                    const mismatched = type === 'compaction/end' && (open.crossedTurn || data.compactionId !== open.id || commandId !== open.commandId || data.turn !== open.turn);
                    const incomplete = failed ? (open.summarized || open.checkpointed) : (!open.summarized || !open.checkpointed);
                    if (event.seq >= first || stale.has(event.seq) || mismatched || incomplete || open.seqs.some(seq => stale.has(seq)) || open.commandId && staleCommandIds.has(open.commandId)) {
                        markOpenStale(open);
                        if (type === 'compaction/end') {
                            if (addStale(event.seq))
                                changed = true;
                            if (addCommandId(commandId))
                                changed = true;
                        }
                    }
                    open = undefined;
                }
                else if (type === 'compaction/end') {
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(event.data.sourceCommandId))
                        changed = true;
                }
                continue;
            }
            if (type === 'compaction/prune') {
                const next = events[index + 1];
                const range = event.data.shadowedRange;
                const nextOp = next && 'surfaceOp' in next && typeof next.surfaceOp === 'object' && next.surfaceOp !== null ? next.surfaceOp : undefined;
                const paired = Boolean(event.seq < first && !stale.has(event.seq) && next?.type === 'tool/result' && nextOp?.op === 'replace' && typeof range?.start === 'number' && range.start === nextOp.startSeq && range.end === nextOp.endSeq && range.start !== protectedHead && surface.includes(range.start) && !stale.has(range.start) && !removed.has(range.start) && next.seq < first && !stale.has(next.seq) && !removed.has(next.seq));
                if (paired && next)
                    pairedPruneResults.add(next.seq);
                else if (addStale(event.seq))
                    changed = true;
                continue;
            }
            if (event.type === 'tool/result' && isReplacement) {
                const op = event.surfaceOp;
                if (!pairedPruneResults.has(event.seq) || !replaceSurface(op.startSeq, op.endSeq, event.seq, event.sourceEventSeqs)) {
                    if (addStale(event.seq))
                        changed = true;
                }
                continue;
            }
            if (type === 'image/offload') {
                // Session.create 在无额外 message projection 时不支持重放 image/offload；图片卸载不改变表层节点配对，统一转为可忽略标记。
                if (addStale(event.seq))
                    changed = true;
                continue;
            }
            if (event.type === 'system/message' && isReplacement) {
                const targetSeq = typeof event.surfaceOp === 'object' && event.surfaceOp !== null && event.surfaceOp.op === 'replace' && event.surfaceOp.startSeq === event.surfaceOp.endSeq ? event.surfaceOp.startSeq : undefined;
                if (targetSeq === undefined || events[targetSeq]?.type !== 'system/message' || stale.has(targetSeq) || removed.has(targetSeq) || !replaceSurface(targetSeq, targetSeq, event.seq, event.sourceEventSeqs, [targetSeq])) {
                    if (addStale(event.seq))
                        changed = true;
                }
                else if (targetSeq === protectedHead) {
                    protectedHead = event.seq;
                }
                continue;
            }
            if (isReplacement || event.seq >= first && type.startsWith('compaction/')) {
                if (addStale(event.seq))
                    changed = true;
                continue;
            }
            if (isSurface && event.surfaceOp === 'append' && !removed.has(event.seq) && !stale.has(event.seq)) {
                surface.push(event.seq);
            }
        }
        if (open)
            markOpenStale(open);
        for (const { checkpointSeq, systemSeqs } of checkpointedShadowedSystems) {
            if (hasActiveStepAfter(events, checkpointSeq, stale, removed)) {
                for (const seq of systemSeqs)
                    if (addStale(seq))
                        changed = true;
            }
        }
        for (const event of events)
            if (String(event.type) === 'command/done') {
                const data = event.data;
                const commandId = typeof data.commandId === 'string' ? data.commandId : undefined;
                if (typeof data.sourceEventSeq === 'number' && (stale.has(data.sourceEventSeq) || removed.has(data.sourceEventSeq))) {
                    if (addStale(event.seq))
                        changed = true;
                    if (addCommandId(commandId))
                        changed = true;
                }
            }
        if (staleCommandIds.size) {
            for (const event of events) {
                const type = String(event.type);
                if (type === 'command/run' || type === 'command/done') {
                    const id = event.data.commandId;
                    if (typeof id === 'string' && staleCommandIds.has(id) && addStale(event.seq))
                        changed = true;
                }
                else if (type.startsWith('compaction/')) {
                    const id = event.data.sourceCommandId;
                    if (typeof id === 'string' && staleCommandIds.has(id) && addStale(event.seq))
                        changed = true;
                }
                else if (event.type === 'user/message') {
                    const id = event.data.source.sourceCommandId;
                    if (typeof id === 'string' && staleCommandIds.has(id) && addStale(event.seq))
                        changed = true;
                }
            }
        }
    } while (changed);
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
    if ([...edits.keys()].some(seq => !eventSeqs.has(seq)))
        throw new Error('编辑目标不在日志中');
    const removed = new Set(deleted), deleteSteps = new Set(), deleteCallIds = new Set(), steps = new Set(), deletedAssistantTurns = new Set();
    for (const event of events) {
        if (deleted.has(event.seq)) {
            if (edits.has(event.seq) || !isEditableVisibleMessage(event))
                throw new Error('删除目标不是独立可见消息');
            if (event.type === 'assistant/message') {
                deletedAssistantTurns.add(event.data.turn);
                deleteSteps.add(event.data.turn + ':' + event.data.step);
                for (const block of event.data.message.content)
                    if (block.type === 'tool-call')
                        deleteCallIds.add(block.id);
            }
        }
        else if (edits.has(event.seq) && !isEditableVisibleMessage(event)) {
            throw new Error('目标不是可见消息');
        }
    }
    for (const turn of deletedAssistantTurns) {
        const hasRemainingVisible = events.some(event => event.type === 'assistant/message' && event.data.turn === turn && !deleted.has(event.seq) && hasVisibleAssistantText(event));
        if (hasRemainingVisible)
            continue;
        for (const event of events) {
            if (event.type !== 'assistant/message' || event.data.turn !== turn || deleted.has(event.seq))
                continue;
            removed.add(event.seq);
            deleteSteps.add(event.data.turn + ':' + event.data.step);
            for (const block of event.data.message.content)
                if (block.type === 'tool-call')
                    deleteCallIds.add(block.id);
        }
    }
    for (const event of events) {
        if (!['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type))
            continue;
        const data = event.data;
        if (!deleteSteps.has(data.turn + ':' + data.step))
            continue;
        if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !removed.has(event.seq))
            throw new Error('删除目标与另一条 assistant 消息共用步骤');
        if (event.type === 'tool/call' && typeof data.callId === 'string')
            deleteCallIds.add(data.callId);
        removed.add(event.seq);
    }
    if (deleteCallIds.size) {
        for (const event of events) {
            const type = String(event.type);
            if (type !== 'tool/ptc-dispatch-start' && type !== 'tool/ptc-dispatch')
                continue;
            const data = event.data;
            if (typeof data.rootCallId === 'string' && deleteCallIds.has(data.rootCallId) || typeof data.parentCallId === 'string' && deleteCallIds.has(data.parentCallId))
                removed.add(event.seq);
        }
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
