/** 会话迁移共用 WAL 预检：不导出或发布恢复中、未完成或记录损坏的剧情。 */
import { Wal } from '../state/wal.js';
import type { SessionBinding } from './bindings.js';
/** 只允许把已确认属于本剧情的活动楼层带入分支或迁移包。 */
export declare function assertWalLineageComplete(floors: readonly string[], binding: Pick<SessionBinding, 'walLineage'>, sessionId: string): void;
export declare function assertArchiveWalComplete(wal: Wal): Promise<void>;
