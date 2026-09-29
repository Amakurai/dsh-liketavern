import { type UseSessions } from './mode.js';
import type { TavernRemote } from './types.js';
import './styles.js';
/** 绑定变更广播（chip 保存绑定后 dispatch，操作条据此显隐）。 */
export declare const BINDING_CHANGED_EVENT = "dsh-tavern:binding-changed";
/** 分支变更广播（fork 操作成功后以源会话 id dispatch，兄弟导航据此重拉）。 */
export declare const BRANCH_CHANGED_EVENT = "dsh-tavern:branch-changed";
export interface FloorActionsProps {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    /** slot owner 传入的 assistant 消息 id。 */
    messageId?: string;
    useSessions?: UseSessions;
}
export declare function TavernFloorActions(props: FloorActionsProps): import("react").JSX.Element | null;
/**
 * 被中断（已停止）楼层的最小操作组。
 * 宿主的 assistant-actions slot 依赖 turn-tail 的持久 messageId，部分中断楼层也具备它。
 * 只有对应消息确实拿不到该 slot 时，才由 chat.node 渲染侧按 turn 号补挂：
 * 重新生成 / 回退 + 同层分支兄弟导航。除此之外不放编辑/续写/代答，保持最小面。
 */
export declare function TavernInterruptedFloorActions(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    turn: number;
}): import("react").JSX.Element;
