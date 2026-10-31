import { retireGreetingOnlyBlankSession, syncIdleAgentLastTurn } from './floors.js';
import { isTavernRuntimeSession } from './tavernSession.js';
export function createGreetingRetirement(ctx) {
    const awaitingAgent = new WeakSet();
    const retire = (session) => {
        try {
            // 通知结束前会话可能已被撤销，不能对脱离注册表的旧对象补写。
            if (ctx.sessions.get(session.id) !== session || !isTavernRuntimeSession(ctx, session))
                return;
            if (retireGreetingOnlyBlankSession(session, ctx)) {
                // 新宿主可能先公告 Session，再注册已按旧日志构造的 Agent。
                if (!ctx.agents.get(session.id))
                    awaitingAgent.add(session);
                ctx.logger.info(`dsh-tavern: 已为旧开场白会话补充轮次标记 ${session.id}；原有不完整历史不会因此修复`);
            }
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: 解除写脏空白会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return {
        /** 新宿主在同步 session/created 监听期间禁止追加；微任务会在公告返回后执行。 */
        schedule(session) { queueMicrotask(() => retire(session)); },
        /** 分支接管完成时已跨过创建公告，可以立即补偿。 */
        afterAdoption: retire,
        /** 创建期间 Agent 尚未入册时，在它开始接收输入之前补齐捕获的 lastTurn。 */
        agentCreated(agent) {
            if (!awaitingAgent.delete(agent.session))
                return;
            if (ctx.sessions.get(agent.id) !== agent.session || ctx.agents.get(agent.id) !== agent)
                return;
            syncIdleAgentLastTurn(ctx, agent.id);
        },
    };
}
