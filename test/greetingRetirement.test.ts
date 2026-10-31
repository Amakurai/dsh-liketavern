/** 旧开场白会话的创建事件兼容：公告期间只读，补偿对齐 Agent，损坏历史不伪装为可恢复。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as persistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { createGreetingRetirement } from '../src/node/greetingRetirement.js'

let root: string, ctx: Context
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-greeting-retirement-'))
  ctx = new Context(); new SessionStore(ctx); new AgentRegistry(ctx)
  await persistenceJsonl.apply(ctx, { root: join(root, 'sessions'), compression: 'none' })
})
afterEach(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

function legacySeed() {
  const seed = Session.create(SessionId('legacy-seed'))
  const message = createAssistantMessage({ source: { ...TAVERN_GREETING_SOURCE }, content: [{ type: 'text', text: '旧开场白' }] })
  seed.append('assistant/message', { turn: 0, step: 0, message, stream: [] }, { surfaceOp: 'append' })
  return seed.snapshotEvents()
}

it('公告期间不可写时，公告结束后补空轮次并在 Agent 发布时对齐计数', async () => {
  const retirement = createGreetingRetirement(ctx), id = SessionId('session-legacy-greeting')
  let announcing = false
  ctx.on('session/created', session => {
    if (session.id !== id) return
    announcing = true
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation((type, data, ...options) => {
      if (announcing) throw new Error('宿主公告期间只读')
      return Reflect.apply(append, session, [type, data, ...options])
    })
    retirement.schedule(session)
    announcing = false
  })
  const session = ctx.sessions.create(id, { seed: legacySeed(), meta: { agentPreset: 'tavern' } })
  expect(session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  await Promise.resolve()
  expect(session.snapshotEvents().filter(event => event.type === 'turn/start' || event.type === 'turn/end')
    .map(event => [event.type, event.data.turn])).toEqual([['turn/start', 1], ['turn/end', 1]])
  expect(JSON.stringify(session.snapshotEvents())).toContain('旧开场白')

  const phase = { kind: 'maintenance', lastTurn: 0 }
  const agent = { id, session, phase } as unknown as Agent
  vi.spyOn(ctx.agents, 'get').mockReturnValue(agent)
  retirement.agentCreated(agent)
  expect(phase.lastTurn).toBe(1)
  phase.lastTurn = 3
  retirement.agentCreated(agent)
  expect(phase.lastTurn).toBe(3)

  const handle = await ctx.sessionPersistence.create({ ...session.header, cwd: root })
  try {
    await handle.append([...session.snapshotEvents()]); await handle.flush()
    // 旧版遗留的游离 assistant 消息本身不满足宿主 V4 日志约束；尾部补偿不能假装修好历史。
    await expect(handle.read()).rejects.toThrow(/assistant\/message does not match an open turn and step/)
  } finally { await handle.close() }
})

it('创建后会话已经脱离注册表时不再改写旧对象', async () => {
  const retirement = createGreetingRetirement(ctx), id = SessionId('session-removed-greeting')
  const session = ctx.sessions.create(id, { seed: legacySeed(), meta: { agentPreset: 'tavern' } })
  const before = session.snapshotEvents()
  retirement.schedule(session)
  vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
  await Promise.resolve()
  expect(session.snapshotEvents()).toEqual(before)
})

it('补偿等待期间已有真实轮次时不再写入合成轮次', async () => {
  const retirement = createGreetingRetirement(ctx), id = SessionId('session-started-greeting')
  const session = ctx.sessions.create(id, { seed: legacySeed(), meta: { agentPreset: 'tavern' } })
  retirement.schedule(session)
  session.append('turn/start', { turn: 2 })
  const before = session.snapshotEvents()
  await Promise.resolve()
  expect(session.snapshotEvents()).toEqual(before)
})
