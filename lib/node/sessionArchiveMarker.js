/** 会话迁移的持久化恢复标记：导入未完成时阻止对应会话运行，直到同一归档重试完成。 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
export function sessionArchiveMarkerPath(paths, sessionId) {
    return join(paths.root, 'session-imports', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}
export async function assertSessionImportComplete(paths, sessionId) {
    const path = sessionArchiveMarkerPath(paths, sessionId);
    try {
        await lstat(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    throw new Error('此会话导入尚未完成，请使用原迁移文件重试');
}
