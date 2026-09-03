import '@deepseek-ai/dsh-typert-registry';
import { TAVERN_NS, TavernConfigSchema, resolveConfig } from './node/config.js';
import { ensureGreeting, retireGreetingOnlyBlankSession } from './node/floors.js';
import { tavernPaths } from './node/paths.js';
import { installTavernPreset } from './node/presetInstall.js';
import { createTavernService } from './node/service.js';
import { TavernState } from './node/state.js';
import { isTavernRuntimeSession } from './node/tavernSession.js';
import { TYPERT_HOST } from './remote.js';
export const name = 'dsh-liketavern';
export const inject = ['settings', 'sessions', 'agents', 'typert', 'workspaceRegistry', 'agentPresets'];
/** 从消息内容块中提取纯文本（非 text 块忽略）。 */
function messageText(content) {
    return content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}
async function onTurnStart(state, sessionId, turn) {
    // turn 号先于绑定记录：turn 中途才绑卡的会话（turn/start 时无绑定，下方提前返回）
    // 也要让 pipeline 拿到真实 turn 号走「每 turn 评估一次」缓存——否则 live 且 turn=-1
    // 时 cacheable=false，每步全量重评并 saveTimers，sticky/cooldown 每步 tick 一次。
    // 注意这种会话本轮没有 beginFloor，首次评估的 saveTimers 落在楼层之外（无 WAL 可回滚）。
    state.currentTurns.set(sessionId, turn);
    state.currentSteps.set(sessionId, 1);
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        return;
    const ws = await state.workspace(binding.cardId);
    await ws.fs.beginFloor(`${sessionId}#t${turn}`);
    // 记下楼层开在哪张卡上：turn/end 必须按这张卡提交，不能重新读绑定。
    state.openFloors.set(sessionId, binding.cardId);
}
async function onTurnEnd(state, sessionId) {
    // 不变式：谁 beginFloor 谁 commitFloor。用户中途换绑/解绑时当前绑定已经指向别的卡，
    // 按当前绑定提交会把开层那张卡的 floor 永远留在 `${sessionId}#tN`：之后设置面板编辑、
    // runMaintenance 等非会话写入都会被误记进这个悬空楼层（违反 AGENTS.md「非会话写入不记 WAL」），
    // 且同名楼层再 beginFloor 会抛「已存在且未提交」。
    const cardId = state.openFloors.get(sessionId);
    state.openFloors.delete(sessionId);
    state.currentTurns.delete(sessionId);
    state.currentSteps.delete(sessionId);
    state.stepNoticeMarks.delete(sessionId);
    state.wiCache.delete(sessionId);
    state.pendingInputs.delete(sessionId);
    if (!cardId)
        return;
    const ws = await state.workspace(cardId);
    try {
        await ws.fs.commitFloor();
    }
    finally {
        // 提交失败也要摘掉楼层上下文，否则同样留下悬空 floor。
        ws.fs.setFloor(null);
    }
}
export async function apply(ctx) {
    const scope = ctx.settings.register(TAVERN_NS, TavernConfigSchema, { applies: 'live' });
    const state = new TavernState(tavernPaths(), () => resolveConfig(scope.get()));
    await state.init();
    try {
        const result = await installTavernPreset();
        if (result.written.length > 0)
            ctx.logger.info(`dsh-tavern: agent 预设已安装（${result.written.join(', ')}）`);
    }
    catch (error) {
        ctx.logger.warn(`dsh-tavern: agent 预设安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
    createTavernService(ctx, state, scope);
    ctx.effect(() => ctx.typert.register(TYPERT_HOST), 'dsh-tavern.typert');
    const retireStuckBlank = (session) => {
        try {
            if (!isTavernRuntimeSession(ctx, session))
                return;
            if (retireGreetingOnlyBlankSession(session, ctx)) {
                ctx.logger.info(`dsh-tavern: 已解除被开场白写脏的空白会话 ${session.id}`);
            }
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: 解除写脏空白会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    for (const session of ctx.sessions.list())
        retireStuckBlank(session);
    ctx.on('session/created', retireStuckBlank);
    // 楼层 WAL 与每 turn 检索缓存：只碰 Tavern 模式会话，普通 dsh 助手不受影响。
    ctx.on('session/event', (session, event) => {
        if (!isTavernRuntimeSession(ctx, session))
            return;
        if (event.type === 'turn/start') {
            const { turn } = event.data;
            void state
                .enqueueSessionTask(session.id, () => onTurnStart(state, session.id, turn))
                .catch((error) => ctx.logger.warn(`dsh-tavern: beginFloor 失败：${String(error)}`));
        }
        else if (event.type === 'step/start') {
            const { step } = event.data;
            if (state.currentTurns.has(session.id))
                state.currentSteps.set(session.id, step);
        }
        else if (event.type === 'turn/end') {
            void state
                .enqueueSessionTask(session.id, () => onTurnEnd(state, session.id))
                .catch((error) => ctx.logger.warn(`dsh-tavern: commitFloor 失败：${String(error)}`));
        }
    });
    // 提前捕获尚未入日志的用户输入（供 WI 当轮扫描）。
    // 同时在第一条真正发出时才写入开场白，避免空白会话被写脏后无法换模式 / 无法新对话。
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const session = ctx.sessions.get(agent.id);
        if (!session || !isTavernRuntimeSession(ctx, session))
            return;
        const text = messageText(message.content);
        if (text.trim()) {
            const list = state.pendingInputs.get(agent.id) ?? [];
            list.push(text);
            state.pendingInputs.set(agent.id, list);
        }
        void state
            .enqueueSessionTask(agent.id, () => ensureGreeting({ ctx, state }, agent.id))
            .catch((error) => ctx.logger.warn(`dsh-tavern: 写入开场白失败：${String(error)}`));
    });
}
