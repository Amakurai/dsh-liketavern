/** 会话迁移共用 WAL 预检：不导出或发布恢复中、未完成或记录损坏的剧情。 */
import { Wal } from '../state/wal.js'

export async function assertArchiveWalComplete(wal: Wal): Promise<void> {
  await wal.assertWorkspaceWritable()
  for (const floor of await wal.listFloors()) if (!floor.rolledBack) {
    if (!floor.committed) throw new Error('会话包含未完成的楼层，不能迁移')
    await wal.validateFloor(floor.floor)
  }
}
