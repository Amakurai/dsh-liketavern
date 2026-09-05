/** 展示用历史读取：优先在线会话，冷会话只检查不可变日志，不触发恢复写入或启动 agent。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'

export async function readDisplaySessionEvents(ctx:Context,sessionId:string):Promise<readonly SessionEvent[]> {
  const live=ctx.sessions.get(sessionId as Session['id'])
  if(live) return live.snapshotEvents()
  const persistence=ctx.get('sessionPersistence')
  if(!persistence) return []
  try {
    const inspection=await persistence.inspect(sessionId as Session['id'])
    if(inspection.meta.id!==sessionId) throw new Error('展示历史的宿主会话归属不一致')
    return ctx.sessions.get(sessionId as Session['id'])?.snapshotEvents() ?? inspection.events
  } catch(error) {
    if(error instanceof SessionPersistenceNotFoundError) return []
    throw error
  }
}
