export async function openChildSession(sessions, childId) {
    if (typeof sessions.refresh === 'function') {
        try {
            await sessions.refresh();
        }
        catch {
            // mux 可能已经写入列表；刷新失败仍尝试打开
        }
    }
    try {
        sessions.open(childId);
    }
    catch {
        if (typeof sessions.refresh === 'function') {
            try {
                await sessions.refresh();
            }
            catch {
                // 第二次打开把错误抛给调用方
            }
        }
        sessions.open(childId);
    }
}
