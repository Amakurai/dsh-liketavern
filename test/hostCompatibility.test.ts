/** 新宿主契约回归：真实 Session 的消息内嵌流、编辑去除旧流，以及真实 JSONL 冷读的只读与资源释放边界。 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, expect, it, vi } from 'vitest'
import { hasNormalAssistantStop } from '../src/node/assistantStream.js'
import { displaySessionEventAt, displaySessionHasUserMessage, readDisplaySessionEvents } from '../src/node/sessionEvents.js'
import { withEditedAssistantMessage } from '../src/node/floors.js'

const stop: AssistantStreamRecord = { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } }
const text: AssistantStreamRecord = { type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['原始回复'] }
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function reply(stream: AssistantStreamRecord[], interrupted = false) {
  const session = Session.create(SessionId('session-host-contract'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/attempt', { turn: 1, step: 1, stream: [stop] })
  const event = session.append('assistant/message', { turn: 1, step: 1, stream,
    message: createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '原始回复' }] }),
    ...(interrupted ? { interrupted: true as const } : {}),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, event }
}

it('正常收口只检查消息自己的流，不借用同一步失败尝试的 stop；异常与不完整流拒绝', () => {
  expect(hasNormalAssistantStop(reply([text, stop]).event)).toBe(true)
  for (const stream of [[], [text], [stop, stop], [stop, text],
    [{ type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] as AssistantStreamRecord[]]) {
    expect(hasNormalAssistantStop(reply(stream).event)).toBe(false)
  }
  expect(hasNormalAssistantStop(reply([text, stop], true).event)).toBe(false)
})

it('楼层编辑清空嵌入流并生成新消息身份，来源日志保持不变且分支能通过真实 Session 校验', () => {
  const { session, event } = reply([text, stop])
  const seed = withEditedAssistantMessage(session.snapshotEvents(), event.data.message.id, '修订回复')!
  const branch = Session.create(SessionId('session-edited-contract'), seed)
  const changed = branch.snapshotEvents().find(item => item.type === 'assistant/message')!
  expect(changed).toHaveProperty('data.stream', [])
  expect(changed).toHaveProperty('data.message.content', [{ type: 'text', text: '修订回复' }])
  expect(changed.type === 'assistant/message' && changed.data.message.id).not.toBe(event.data.message.id)
  expect(event.data.stream).toEqual([text, stop])
})

/** 兼容部分宿主测试桩复用数组后原地 append；摘要与 seq 索引都必须观察到增长。 */
it('展示事件摘要在同一数组原地增长后失效',()=>{
  const mutable=[...reply([text,stop]).session.snapshotEvents()]
  expect(displaySessionHasUserMessage(mutable)).toBe(false)
  expect(displaySessionEventAt(mutable,3)?.type).toBe('assistant/message')
  const appended={type:'user/message',seq:mutable.length,time:Date.now(),surfaceOp:'append',
    data:createUserMessage({content:[{type:'text',text:'继续'}],source:{kind:'user'}})} as unknown as SessionEvent
  mutable.push(appended)
  expect(displaySessionHasUserMessage(mutable)).toBe(true)
  expect(displaySessionEventAt(mutable,appended.seq)).toBe(appended)
})

async function artifacts(root: string) {
  const names = await readdir(root, { recursive: true, withFileTypes: true })
  return Promise.all(names.filter(entry => entry.isFile()).map(async entry => ({
    path: join(entry.parentPath, entry.name), bytes: (await readFile(join(entry.parentPath, entry.name))).toString('base64'),
  })))
}

it('真实 JSONL 冷会话使用 read 句柄，连续展示不更改磁盘，缺失会话返回空历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-host-contract-')); roots.push(root)
  const ctx = new Context(); new SessionStore(ctx)
  const persistence = new JsonlSessionPersistence(ctx, { root, compression: 'none' })
  try {
    const { session } = reply([text, stop])
    const writer = await persistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    const before = await artifacts(root), open = vi.spyOn(persistence, 'open')
    expect(await readDisplaySessionEvents(ctx, session.id)).toEqual(session.snapshotEvents())
    expect(await readDisplaySessionEvents(ctx, session.id)).toEqual(session.snapshotEvents())
    expect(open.mock.calls.every(([, access]) => access === 'read')).toBe(true)
    expect(await artifacts(root)).toEqual(before)
    expect(await readDisplaySessionEvents(ctx, 'session-missing')).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('冷读失败仍释放句柄，错误不能伪装为空历史', async () => {
  const close = vi.fn(async () => {}), read = vi.fn(async () => { throw new Error('corrupt stored history') })
  const ctx = { sessions: { get: () => undefined }, get: () => ({ open: async () => ({
    id: 'session-cold', header: { id: 'session-cold' }, read, close,
  }) }) } as unknown as Context
  await expect(readDisplaySessionEvents(ctx, 'session-cold')).rejects.toThrow('corrupt stored history')
  expect(close).toHaveBeenCalledTimes(1)
})
