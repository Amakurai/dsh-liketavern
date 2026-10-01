import { isTavernRuntimeSession } from './tavernSession.js';
export function registerPromptInputTracking(ctx, state) {
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const session = ctx.sessions.get(agent.id);
        if (!session || !isTavernRuntimeSession(ctx, session))
            return;
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const hasImage = message.content.some(block => block.type === 'image');
        if (!text.trim() && !hasImage)
            return;
        // claim 在 assemble 前同步通知，而上一 turn/end 可能仍在异步队列里清理。
        // 同队列发布让旧轮收口先完成；pipeline 的 waitForSessionTasks 随后取得这一轮完整输入。
        void state.enqueueSessionTask(agent.id, async () => {
            if (state.currentTurns.get(agent.id) !== turn)
                return;
            if (state.pendingTemplateInputs.get(agent.id)?.some(input => input.id === message.id))
                return;
            state.pendingInputs.set(agent.id, [...(state.pendingInputs.get(agent.id) ?? []), text]);
            state.pendingTemplateInputs.set(agent.id, [...(state.pendingTemplateInputs.get(agent.id) ?? []), {
                    id: message.id, text, ...(hasImage ? { hasImage: true } : {}), chat: message.source.kind === 'user',
                }]);
        }).catch(error => ctx.logger.warn(`dsh-tavern: 认领本轮输入失败：${String(error)}`));
    });
}
