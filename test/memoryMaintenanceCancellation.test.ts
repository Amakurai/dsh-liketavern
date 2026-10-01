/** 记忆维护取消回归：真实 AgentLoop 的维护信号与剧情文件验证取消不归档，下一已结束轮仍可重试。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { resolveConfig } from '../src/node/config.js'
import { registerMemoryMaintenance } from '../src/node/memoryMaintenance.js'
import { TavernState } from '../src/node/state.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'

const lockProbe = vi.hoisted(() => ({ root: '', queued: null as (() => void) | null }))
vi.mock('../src/state/workspaceLock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/state/workspaceLock.js')>()
  return { ...actual, withWorkspaceLock: <T>(root: string, task: () => Promise<T>) => {
    if (root === lockProbe.root) lockProbe.queued?.()
    return actual.withWorkspaceLock(root, task)
  } }
})

let root: string, ctx: Context, agent: Agent
afterEach(async () => {
  lockProbe.root = ''; lockProbe.queued = null
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent?.whenIdle()
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})

it.each(['stream', 'workspace-lock'] as const)('用户取消维护时迟到 stop 或等待锁不归档原文，下一轮仍能完成（阶段=%s）', async stage => {
  root = await mkdtemp(join(tmpdir(), 'memory-maintenance-cancel-'))
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig({ memory: { maxEntries: 1, compressBatch: 2 } }))
  await state.init()
  const { cardId } = await state.createCharacter('取消维护工厂角色')
  await state.saveBinding({ sessionId: 'cancel-maintenance', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding('cancel-maintenance'))!, ws = await state.storyWorkspace(cardId, binding.storyId)
  await ws.memory.write({ body: '第一条工厂事实' }); await ws.memory.write({ body: '第二条工厂事实' })
  const original = await ws.memory.list()
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('cancel-maintenance'), { provider: 'factory', model: 'factory' })
  const entered = Promise.withResolvers<Readonly<GenerateOptions>>(), release = Promise.withResolvers<void>()
  let calls = 0
  const llm = { async *stream(options: GenerateOptions) {
    calls++; entered.resolve(options)
    // 工厂适配器故意忽略信号；即使后来正常 stop，取消的一次维护也不得归档。
    await release.promise
    yield { type: 'text-delta' as const, text: '迟到的合并正文' }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  } } as unknown as LlmRuntime
  registerMemoryMaintenance(ctx, state, llm)
  agent.session.append('turn/start', { turn: 1 }); agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  const options = await entered.promise
  if (stage === 'workspace-lock') {
    const held = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
    const holder = withWorkspaceLock(ws.fs.root, async () => { held.resolve(); await unlock.promise })
    await held.promise
    lockProbe.root = ws.fs.root; lockProbe.queued = queued.resolve
    release.resolve()
    await queued.promise
    agent.cancel({ kind: 'user' })
    unlock.resolve(); await holder
    lockProbe.root = ''; lockProbe.queued = null
  } else {
    agent.cancel({ kind: 'user' })
    release.resolve()
  }
  await state.waitForSessionTasks(agent.id); await agent.whenIdle()
  expect(options.signal?.aborted).toBe(true)
  expect(await ws.memory.list()).toEqual(original)
  expect(await ws.fs.list('memory/archive')).toEqual([])
  expect(state.pendingMemoryCompress.has(binding.storyId!)).toBe(true)
  agent.session.append('turn/start', { turn: 2 }); agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await state.waitForSessionTasks(agent.id); await agent.whenIdle()
  expect(calls).toBe(2)
  expect((await ws.memory.list()).map(entry => entry.body)).toEqual(['迟到的合并正文'])
  expect(await ws.fs.list('memory/archive')).toHaveLength(2)
  expect(state.pendingMemoryCompress.has(binding.storyId!)).toBe(false)
})
