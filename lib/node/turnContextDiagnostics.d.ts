import type { Session } from '@deepseek-ai/dsh-session';
export interface StaleTurnContext {
    /** 最新快照之前仍在 surface 上、含 tavern:turn 段的快照数。 */
    snapshots: number;
    /** 这些快照中 tavern:turn 段的估算 token 合计。 */
    tokens: number;
}
export declare function measureStaleTurnContext(session: Pick<Session, 'surface' | 'eventAt'>): StaleTurnContext;
