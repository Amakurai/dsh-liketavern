/** 只允许把已确认属于本剧情的活动楼层带入分支或迁移包。 */
export function assertWalLineageComplete(floors, binding, sessionId) {
    for (const floor of floors) {
        const match = /^(.+)#t([0-9]+)$/.exec(floor);
        const turn = match ? Number(match[2]) : NaN;
        if (!match || !Number.isSafeInteger(turn)
            || (match[1] !== sessionId && !(binding.walLineage ?? []).some(entry => entry.sessionId === match[1] && turn <= entry.throughTurn))) {
            throw new Error('无法确认活动 WAL 楼层的来源，不能安全回退或导出；请恢复原会话的继承记录');
        }
    }
}
export async function assertArchiveWalComplete(wal) {
    await wal.assertWorkspaceWritable();
    for (const floor of await wal.listFloors())
        if (!floor.rolledBack) {
            if (!floor.committed)
                throw new Error('会话包含未完成的楼层，不能迁移');
            await wal.validateFloor(floor.floor);
        }
}
