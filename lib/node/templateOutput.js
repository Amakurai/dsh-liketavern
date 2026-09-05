import { hasEjs } from '../core/template.js';
import { loadTemplateState, saveTemplateState, templateTextHash } from '../state/template.js';
import { templateGenerationContext } from '../state/templateGeneration.js';
import { closeTemplateGenerationState } from '../state/templateContinuation.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { isolated } from './isolated.js';
import { mergeTemplateMessageVariables, visibleTemplateMessageVariables } from '../core/templateMessageVariables.js';
export async function completeTemplateOutput(state, session) {
    const events = session.snapshotEvents();
    const ending = [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end');
    if (ending?.type !== 'turn/end' || ending.data.reason.kind !== 'completed')
        return;
    const turn = ending.data.turn;
    const binding = await state.loadBinding(session.id);
    if (!binding)
        return;
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId);
    await withWorkspaceLock(ws.fs.root, async () => {
        const stored = await loadTemplateState(ws.fs);
        const generation = stored.generation;
        const open = state.openFloors.get(session.id);
        const plan = state.turnPlans.get(session.id);
        if (state.currentTurns.has(session.id) && state.currentTurns.get(session.id) !== turn)
            return;
        if (open && (open.cardId !== binding.cardId || open.storyId !== binding.storyId))
            return;
        if (plan && (plan.turn !== turn || plan.cardId !== binding.cardId || plan.storyId !== binding.storyId))
            return;
        const ownGeneration = generation?.sessionId === session.id && generation.turn === turn;
        if (ownGeneration && (generation.cardId !== binding.cardId || generation.storyId !== binding.storyId))
            throw new Error('模板回复恢复的剧情归属不一致');
        if (ownGeneration && generation.status !== 'prepared')
            return;
        const context = plan?.result.templateContext ?? (ownGeneration && generation.status === 'prepared' ? templateGenerationContext(generation) : undefined);
        const replay = plan?.result.templateReplay ?? (ownGeneration && generation.status === 'prepared' ? generation.replay : undefined);
        const floor = open?.floor ?? (ownGeneration ? generation.floor : undefined);
        if (!context || !floor)
            return;
        if (floor !== `${session.id}#t${turn}`)
            throw new Error('模板回复恢复楼层与宿主结束帧不一致');
        await ws.wal.validateFloor(floor);
        const history = context.history.map(message => ({ ...message }));
        const historyIdentities = context.historyIdentities?.map(identity => ({ ...identity }));
        const candidates = [];
        for (const event of events) {
            if (event.type !== 'assistant/message' || event.data.turn !== turn || event.data.interrupted || event.seq >= ending.seq)
                continue;
            const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (!text.trim())
                continue;
            const metadata = { index: history.length, role: 'assistant', name: context.char, swipeId: 0, hostMessageId: event.seq };
            history.push({ role: 'assistant', content: text, name: context.char });
            historyIdentities?.push({ messageId: event.data.message.id, hostMessageId: event.seq, swipeId: 0 });
            candidates.push({ id: String(event.seq), text, metadata, step: event.data.step, seq: event.seq });
        }
        const before = context.entries.filter(entry => entry.enabled && !entry.templateOnlyPreload && /^\[RENDER:BEFORE\]/i.test(entry.comment));
        const after = context.entries.filter(entry => entry.enabled && !entry.templateOnlyPreload && /^\[RENDER:AFTER\]/i.test(entry.comment));
        const pending = [];
        for (const candidate of candidates) {
            const chunks = events.filter(event => event.type === 'assistant/chunk' && event.data.turn === turn && event.data.step === candidate.step);
            const finish = chunks.at(-1);
            if (chunks.filter(event => event.type === 'assistant/chunk' && event.data.chunk.type === 'finish').length !== 1)
                continue;
            if (finish?.type !== 'assistant/chunk' || finish.data.chunk.type !== 'finish' || finish.data.chunk.reason.kind !== 'stop' || finish.seq >= candidate.seq)
                continue;
            if (!historyIdentities && !hasEjs(candidate.text) && !before.length && !after.length && !context.regexRules?.length && !context.hasMessageRegex)
                continue;
            if (stored.outputs[candidate.id]?.hash === templateTextHash(candidate.text))
                continue;
            if (stored.outputs[candidate.id])
                throw new Error('已处理的模板回复发生改写，请回滚该楼层后继续');
            pending.push(candidate);
        }
        if (!pending.length)
            return;
        const result = await isolated('template', { texts: pending.map(candidate => candidate.text), decorateOutput: true, replay, templateContinuation: stored.continuation,
            context: { ...context, history, historyIdentities, messageVariables: historyIdentities ? visibleTemplateMessageVariables(stored.messageVariables, historyIdentities) : undefined,
                renderMessages: pending.map(candidate => candidate.metadata), variables: stored.variables, phase: 'render' } });
        if (result.texts.length !== pending.length || result.parts.length !== pending.length)
            throw new Error('模板回复结果与宿主消息数量不一致');
        stored.variables = result.variables;
        if (result.templateContinuation)
            stored.continuation = result.templateContinuation;
        if (historyIdentities)
            stored.messageVariables = mergeTemplateMessageVariables(stored.messageVariables, result.messageVariables, historyIdentities);
        pending.forEach((candidate, index) => { stored.outputs[candidate.id] = { hash: templateTextHash(candidate.text), text: result.texts[index], parts: result.parts[index] }; });
        if (ownGeneration)
            closeTemplateGenerationState(stored, 'completed');
        const latest = await state.loadBinding(session.id);
        if (latest?.cardId !== binding.cardId || latest.storyId !== binding.storyId)
            throw new Error('模板回复提交前剧情绑定已变化');
        await saveTemplateState(ws.fs.withFloor(floor), stored);
    });
}
