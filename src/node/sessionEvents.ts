/** 展示用历史读取：优先在线会话，冷会话只检查不可变日志，不触发恢复写入或启动 agent。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'

/**
 * Session.snapshotEvents() 返回在下次 append 前复用的不可变数组。长聊天首屏会同时渲染
 * 数百个气泡；把“是否已有用户消息”绑定到该快照引用，可避免每个气泡各做一次全表 some。
 * WeakMap 不延长历史快照寿命；append 后无论换新数组还是测试桩原地增长，都不会误命中旧结论。
 */
interface EventSnapshotCache<T> {length:number;last:SessionEvent|undefined;lastSeq:number|undefined;value:T}
const userMessagePresence=new WeakMap<readonly SessionEvent[],EventSnapshotCache<boolean>>()
const eventIndexes=new WeakMap<readonly SessionEvent[],EventSnapshotCache<ReadonlyMap<number,SessionEvent>>>()

function currentSnapshot<T>(events:readonly SessionEvent[],cached:EventSnapshotCache<T>|undefined):cached is EventSnapshotCache<T> {
  const last=events.at(-1)
  return cached?.length===events.length&&cached.last===last&&cached.lastSeq===last?.seq
}

export function displaySessionHasUserMessage(events:readonly SessionEvent[]):boolean {
  const cached=userMessagePresence.get(events)
  if(currentSnapshot(events,cached))return cached.value
  const value=events.some(event=>event.type==='user/message')
  const last=events.at(-1)
  userMessagePresence.set(events,{length:events.length,last,lastSeq:last?.seq,value})
  return value
}

/** 按不可变快照建立一次 seq 索引；兼容测试桩及未来可能返回的非零起点只读切片。 */
export function displaySessionEventAt(events:readonly SessionEvent[],seq:number):SessionEvent|undefined {
  if(!Number.isSafeInteger(seq)||seq<0)return undefined
  let cached=eventIndexes.get(events)
  if(!currentSnapshot(events,cached)){
    const last=events.at(-1),value=new Map(events.map(event=>[event.seq,event]))
    cached={length:events.length,last,lastSeq:last?.seq,value};eventIndexes.set(events,cached)
  }
  return cached.value.get(seq)
}

export async function readDisplaySessionEvents(ctx:Context,sessionId:string):Promise<readonly SessionEvent[]> {
  const live=ctx.sessions.get(sessionId as Session['id'])
  if(live) return live.snapshotEvents()
  const persistence=ctx.get('sessionPersistence')
  if(!persistence) return []
  try {
    const handle=await persistence.open(sessionId as Session['id'],'read')
    try {
      if(handle.id!==sessionId || handle.header.id!==sessionId) throw new Error('展示历史的宿主会话归属不一致')
      const {events}=await handle.read()
      return ctx.sessions.get(sessionId as Session['id'])?.snapshotEvents() ?? events
    } finally {
      await handle.close()
    }
  } catch(error) {
    if(error instanceof SessionPersistenceNotFoundError) return []
    throw error
  }
}
