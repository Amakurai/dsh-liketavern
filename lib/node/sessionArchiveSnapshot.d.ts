import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { type SessionArchive } from './sessionArchiveFormat.js';
import type { TavernState } from './state.js';
import type { WalLineageEntry } from './bindings.js';
import { type HostForkIdentitySource } from './hostForkIdentity.js';
import type { TavernPaths } from './paths.js';
export declare class BoundedSessionParentMap extends Map<string, SessionId> {
    private readonly maxEntries;
    constructor(maxEntries?: number);
    set(key: string, value: SessionId): this;
}
export declare const forkedSessionParents: BoundedSessionParentMap;
export declare function installSessionForkTracking(): void;
/** 合并会话头、同进程追踪和已校验的插件来源；明确解绑后的记录不能再次推断继承。 */
export declare function resolveLegacyForkParent(paths: TavernPaths | undefined, child: HostForkIdentitySource): Promise<Session['id'] | undefined>;
/** 旧分支未保存 WAL 世系时，从真实祖先的持久化继承边界重建；缺失祖先不能猜测。 */
export declare function deriveLegacyLineage(persistence: SessionPersistence, root: SessionArchive['session'], paths?: TavernPaths): Promise<WalLineageEntry[]>;
/** 导出期间拒绝正在生成或未完成的轮次；返回的是校验过的、无兄弟剧情的完整快照。 */
export declare function snapshotSessionArchive(ctx: Context, state: TavernState, sessionId: string): Promise<SessionArchive>;
