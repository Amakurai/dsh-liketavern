import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { type SessionArchive } from './sessionArchiveFormat.js';
import type { TavernState } from './state.js';
import type { WalLineageEntry } from './bindings.js';
/** 旧分支未保存 WAL 世系时，从真实祖先的持久化继承边界重建；缺失祖先不能猜测。 */
export declare function deriveLegacyLineage(persistence: SessionPersistence, root: SessionArchive['session']): Promise<WalLineageEntry[]>;
/** 导出期间拒绝正在生成或未完成的轮次；返回的是校验过的、无兄弟剧情的完整快照。 */
export declare function snapshotSessionArchive(ctx: Context, state: TavernState, sessionId: string): Promise<SessionArchive>;
