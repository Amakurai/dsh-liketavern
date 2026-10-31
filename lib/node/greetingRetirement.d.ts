/** 旧开场白会话的创建期补偿：等待宿主创建通知结束，并在 Agent 发布后对齐楼层计数。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
export declare function createGreetingRetirement(ctx: Context): {
    /** 新宿主在同步 session/created 监听期间禁止追加；微任务会在公告返回后执行。 */
    schedule(session: Session): void;
    /** 分支接管完成时已跨过创建公告，可以立即补偿。 */
    afterAdoption: (session: Session) => void;
    /** 创建期间 Agent 尚未入册时，在它开始接收输入之前补齐捕获的 lastTurn。 */
    agentCreated(agent: Agent): void;
};
