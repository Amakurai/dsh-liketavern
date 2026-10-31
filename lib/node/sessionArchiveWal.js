export async function assertArchiveWalComplete(wal) {
    await wal.assertWorkspaceWritable();
    for (const floor of await wal.listFloors())
        if (!floor.rolledBack) {
            if (!floor.committed)
                throw new Error('会话包含未完成的楼层，不能迁移');
            await wal.validateFloor(floor.floor);
        }
}
