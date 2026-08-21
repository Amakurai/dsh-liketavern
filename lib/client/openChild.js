export async function openChildSession(sessions, childId, title) {
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
    if (title && typeof sessions.scope === 'function' && typeof sessions.sessionOf === 'function') {
        try {
            const face = sessions.sessionOf(sessions.scope(childId));
            await face?.rename(title);
        }
        catch {
            // 改名失败不影响分支本身
        }
    }
}
