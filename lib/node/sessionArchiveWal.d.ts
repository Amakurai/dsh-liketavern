/** 会话迁移共用 WAL 预检：不导出或发布恢复中、未完成或记录损坏的剧情。 */
import { Wal } from '../state/wal.js';
export declare function assertArchiveWalComplete(wal: Wal): Promise<void>;
