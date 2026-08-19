/**
 * 打开楼层 fork 产生的子会话。
 * 官方 session.fork 在 RPC 返回时就会把子会话 upsert 进列表；我们走自定义
 * agents.create，必须先 refresh 列表再 open，否则 select 会抛 unknown session，
 * 或主窗对尚未登记的会话拉历史得到 Failed to fetch。
 */
export interface SessionsPort {
  open(id: string): void
  refresh?: () => Promise<void>
}

export async function openChildSession(sessions: SessionsPort, childId: string): Promise<void> {
  if (typeof sessions.refresh === 'function') {
    try {
      await sessions.refresh()
    } catch {
      // mux 可能已经写入列表；刷新失败仍尝试打开
    }
  }
  try {
    sessions.open(childId)
  } catch {
    if (typeof sessions.refresh === 'function') {
      try {
        await sessions.refresh()
      } catch {
        // 第二次打开把错误抛给调用方
      }
    }
    sessions.open(childId)
  }
}
