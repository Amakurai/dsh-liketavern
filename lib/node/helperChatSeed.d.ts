/** 消息编辑分支的 seed：保留日志序号和后续正文，以可忽略标记替代过时压缩与已改正文的流式片段。 */
import { type SessionEvent } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'tavern/message-edit-marker': {
            originalType: string;
            reason: 'stale-compaction' | 'edited-stream' | 'deleted-message';
        };
    }
}
export declare function editedHistorySeed(events: readonly SessionEvent[], edits: ReadonlyMap<number, string>, deleted?: ReadonlySet<number>): SessionEvent[];
