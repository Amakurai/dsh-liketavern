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
export declare function TavernFloorActions(props: FloorActionsProps): any;
