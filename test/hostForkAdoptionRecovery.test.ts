/** 原生分支接管恢复：真实文件系统和公开 AgentLoop 验证失败拒绝发信、单次重试与冻结来源。 */
import { mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { adoptHostFork } from '../src/node/floors.js'
import { hostForkAdoptionFile } from '../src/node/hostForkAdoption.js'
import { sessionFile } from '../src/node/paths.js'
import { registerPromptInputTracking } from '../src/node/pendingInputs.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { isTavernRuntimeSession } from '../src/node/tavernSession.js'
import { MemoryStore } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))
const deletionPause = vi.hoisted(() => ({ sessionId: '', entered: null as PromiseWithResolvers<void> | null, released: null as PromiseWithResolvers<void> | null }))
vi.mock('../src/node/hostForkAdoption.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/hostForkAdoption.js')>()
  return { ...actual, deleteHostForkAdoption: async (...args: Parameters<typeof actual.deleteHostForkAdoption>) => {
    if (deletionPause.sessionId === args[1]) {
      deletionPause.sessionId = ''
      deletionPause.entered!.resolve()
      await deletionPause.released!.promise
    }
    return actual.deleteHostForkAdoption(...args)
  } }
})
const faults = vi.hoisted(() => ({ read: '', rename: '', renameCountdown: 0, remove: '', stat: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.remove === String(args[0])) {
        faults.remove = ''
        throw Object.assign(new Error('工厂接管记录清理失败'), { code: 'EIO' })
      }
      return actual.rm(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.stat === String(args[0])) {
        faults.stat = ''
        throw Object.assign(new Error('工厂来源绑定检查点读取失败'), { code: 'EIO' })
      }
      return actual.lstat(...args)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (faults.read === String(args[0])) {
        faults.read = ''
        throw Object.assign(new Error('工厂来源绑定读取失败'), { code: 'EIO' })
      }
      return actual.readFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename === String(args[1])) {
        if (faults.renameCountdown > 0 && --faults.renameCountdown > 0) return actual.rename(...args)
        faults.rename = ''
        throw Object.assign(new Error('工厂子绑定发布失败'), { code: 'EIO' })
      }
      return actual.rename(...args)
    },
  }
})

let root: string, ctx: Context, state: TavernState, parent: Agent, cardA: string, cardB: string, storyA: string
let seed: readonly SessionEvent[]
const adoptions = new Map<string, Promise<boolean>>()
const handles = new Map<string, AgentHandle>()
const requests: GenerateOptions[] = [], errors: unknown[] = [], adoptionErrors: unknown[] = []
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 64_000 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'text-delta', index: 0, text: '工厂角色回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const source = () => state.storyWorkspace(cardA, storyA)
async function fact(turn: number, body: string): Promise<void> {
  const ws = await source(), floor = `${parent.id}#t${turn}`
  await ws.wal.beginFloor(floor)
  await new MemoryStore(ws.fs.withFloor(floor)).write({ body })
  await ws.wal.commitFloor(floor)
}
function history(turn: number): void {
  parent.session.append('turn/start', { turn })
  parent.session.append('step/start', { turn, step: 1 })
  // 真实首请求具备可替换的受保护 system 首节点，手工继承历史也须通过发布版 v4 冷恢复校验。
  if (turn === 1) parent.session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
  parent.session.append('user/message', message(`来源第${turn}轮`), { surfaceOp: 'append' })
  parent.session.append('assistant/message', { turn, step: 1,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    message: createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: `继承角色第${turn}轮` }] }),
  }, { surfaceOp: 'append' })
  parent.session.append('step/end', { turn, step: 1 })
  parent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
async function child(id = 'native-child'): Promise<Agent> {
  const handle = await ctx.agents.create({ sessionId: SessionId(id), seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { parentSession: parent.id, isSeeded: true, agentPreset: 'tavern' },
    agentOptions: { provider: 'factory', model: 'factory' },
  })
  handles.set(id, handle)
  return handle.agent
}
async function idle(agent: Agent): Promise<void> {
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
}
function runtime(): AgentLoop {
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'host-sessions'), compression: 'none' })
  new LlmRuntime(ctx).registerAdapter(['factory'], new FactoryAdapter())
  return new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
}
function plugin(): void {
  new TavernService(ctx, state, {} as TavernSettingsScope)
  ctx.on('session/created', session => {
    if (!session.header.parentSession || !isTavernRuntimeSession(ctx, session)) return
    const task = state.trackBindingAdoption(session.id, () => adoptHostFork({ ctx, state }, session))
    adoptions.set(session.id, task)
    void task.catch(error => adoptionErrors.push(error))
  })
  ctx.on('session/event', (session, event) => {
    if (session.id === parent.id) return
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  registerPromptInputTracking(ctx, state)
  applyAgent(ctx)
}
async function coldResume(original: Agent): Promise<Agent> {
  const paths = state.paths
  await ctx.fiber.dispose()
  state = new TavernState(paths, () => resolveConfig({})); await state.init()
  runtime(); plugin()
  return (await ctx.agents.resume({ resumeSessionId: original.id, agentOptions: { provider: 'factory', model: 'factory' } })).agent
}
beforeEach(async () => {
  deletionPause.sessionId = ''; deletionPause.entered = null; deletionPause.released = null
  faults.read = ''; faults.rename = ''; faults.renameCountdown = 0; faults.remove = ''; faults.stat = ''; requests.length = 0; errors.length = 0; adoptionErrors.length = 0; adoptions.clear(); handles.clear()
  root = await mkdtemp(join(tmpdir(), 'tavern-native-recovery-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardA = (await state.createCharacter('原生来源角色')).cardId
  cardB = (await state.createCharacter('后来换绑角色')).cardId
  await state.saveCharacter(cardA, { description: 'NATIVE-A-ONLY' }); await state.saveCharacter(cardB, { description: 'NATIVE-B-ONLY' })
  await state.saveBinding({ sessionId: 'native-parent', cardId: cardA, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyA = (await state.loadBinding('native-parent'))!.storyId!
  const loop = runtime()
  parent = await loop.create(SessionId('native-parent'), { provider: 'factory', model: 'factory' })
  parent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  history(1); await fact(1, '继承边界内事实'); seed = parent.session.snapshotEvents()
  history(2); await fact(2, '边界之后事实')
  plugin()
})
afterEach(async () => {
  faults.read = ''; faults.rename = ''; faults.renameCountdown = 0; faults.remove = ''; faults.stat = ''; vi.restoreAllMocks()
  for (const agent of ctx.agents.list()) agent.cancel({ kind: 'disposed' }, { keepInbox: true })
  for (const agent of ctx.agents.list()) await idle(agent)
  await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
})

it('接管坏 WAL 失败后真实继承会话拒绝发信，修复后新读重试并按独立剧情正常发信', async () => {
  const ws = await source(), path = 'state/wal/native-parent_t2/meta.json', valid = await ws.fs.readText(path)
  await ws.fs.writeText(path, '{broken')
  const agent = await child()
  await expect(adoptions.get(agent.id)).rejects.toThrow('WAL 元数据损坏')
  agent.followup(message('接着继承角色历史'))
  await idle(agent)
  expect(requests).toHaveLength(0)
  expect(errors.some(error => String(error).includes('WAL 元数据损坏'))).toBe(true)
  expect(state.openFloors.has(agent.id)).toBe(false)
  expect(agent.session.snapshotEvents().slice(seed.length).some(event => event.type === 'user/message' || event.type === 'request/header')).toBe(false)
  await ws.fs.writeText(path, valid!)
  errors.length = 0
  const adopted = (await state.loadBinding(agent.id))!
  expect(adopted.cardId).toBe(cardA); expect(adopted.storyId).not.toBe(storyA)
  expect(adopted.walLineage).toEqual([{ sessionId: parent.id, throughTurn: 1 }])
  const childWs = await state.storyWorkspace(adopted.cardId, adopted.storyId)
  expect((await childWs.memory.list()).map(item => item.body)).toEqual(['继承边界内事实'])
  agent.followup(message('修复后接话'))
  await idle(agent)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('NATIVE-A-ONLY')
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')!
  expect(end.type === 'turn/end' && (await childWs.wal.validateFloor(`${agent.id}#t${end.data.turn}`)).committed).toBe(true)
})

it('第一批等待者保留原拒绝，修复后的并行读取只准备一个新剧情', async () => {
  const ws = await source(), path = 'state/wal/native-parent_t2/meta.json', valid = await ws.fs.readText(path)
  await ws.fs.writeText(path, '{broken')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = state.forkStory.bind(state)
  const preparing = vi.spyOn(state, 'forkStory').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
  const agent = await child(); await entered.promise
  const first = Promise.allSettled([state.loadBinding(agent.id), state.loadBinding(agent.id)])
  release.resolve()
  expect((await first).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(preparing).toHaveBeenCalledTimes(1)
  await ws.fs.writeText(path, valid!)
  const before = (await state.listStories(cardA)).length
  const bindings = await Promise.all([state.loadBinding(agent.id), state.loadBinding(agent.id), state.loadBinding(agent.id)])
  expect(new Set(bindings.map(binding => binding?.storyId)).size).toBe(1)
  expect(bindings[0]?.cardId).toBe(cardA)
  expect(preparing).toHaveBeenCalledTimes(2)
  expect((await state.listStories(cardA)).length).toBe(before + 1)
})

it('发布子绑定失败清理已准备剧情，重试仍沿首次来源与 seed 排除后来的事实和换卡', async () => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const before = (await state.listStories(cardA)).length, agent = await child()
  await expect(adoptions.get(agent.id)).rejects.toThrow('工厂子绑定发布失败')
  expect((await state.listStories(cardA)).length).toBe(before)
  history(3); await fact(3, '接管失败后来源新增事实')
  await state.saveBinding({ ...(await state.loadBinding(parent.id))!, cardId: cardB, storyId: undefined })
  const adopted = (await state.loadBinding(agent.id))!
  expect(adopted.cardId).toBe(cardA)
  expect(adopted.walLineage).toEqual([{ sessionId: parent.id, throughTurn: 1 }])
  const childWs = await state.storyWorkspace(adopted.cardId, adopted.storyId)
  expect((await childWs.memory.list()).map(item => item.body)).toEqual(['继承边界内事实'])
  expect((await (await source()).memory.list()).map(item => item.body).sort()).toEqual(['接管失败后来源新增事实', '继承边界内事实', '边界之后事实'].sort())
  expect((await state.listStories(cardA)).length).toBe(before + 1)
  agent.followup(message('重试后的角色接话')); await idle(agent)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('NATIVE-A-ONLY')
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('NATIVE-B-ONLY')
})

it('初次来源绑定读取失败且文件身份未变时可恢复，不能误判合法未绑定而发信', async () => {
  faults.read = sessionFile(state.paths, parent.id)
  const agent = await child()
  await expect(adoptions.get(agent.id)).rejects.toThrow('工厂来源绑定读取失败')
  expect(await state.loadBinding(agent.id)).toMatchObject({ cardId: cardA })
  expect(requests).toHaveLength(0)
})

it('失败分支同 ID 宿主 Session 重建后仍沿首次来源，不把旧角色 seed 接到后来新卡', async () => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  await handles.get(original.id)!.dispose()
  await state.saveBinding({ ...(await state.loadBinding(parent.id))!, cardId: cardB, storyId: undefined })
  const restored = (await ctx.agents.resume({ resumeSessionId: original.id,
    agentOptions: { provider: 'factory', model: 'factory' },
  })).agent
  expect(restored.session).not.toBe(original.session)
  expect(await adoptions.get(restored.id)).toBe(true)
  const binding = (await state.loadBinding(restored.id))!
  expect(binding.cardId).toBe(cardA)
  expect(binding.walLineage).toEqual([{ sessionId: parent.id, throughTurn: 1 }])
  const ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  expect((await ws.memory.list()).map(item => item.body)).toEqual(['继承边界内事实'])
  restored.followup(message('重建后的原角色接话')); await idle(restored)
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('NATIVE-A-ONLY')
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('NATIVE-B-ONLY')
})

it('冷重建 TavernState 后公开 JSONL resume 仍保留失败分支原来源和继承边界', async () => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  await state.saveBinding({ ...(await state.loadBinding(parent.id))!, cardId: cardB, storyId: undefined })
  const restored = await coldResume(original)
  expect(restored.session).not.toBe(original.session)
  expect(original.session.firstLifecycleSeq).toBe(original.session.inheritedEventCount)
  expect(restored.session.firstLifecycleSeq).toBeGreaterThan(restored.session.inheritedEventCount)
  expect(await adoptions.get(restored.id)).toBe(true)
  const binding = (await state.loadBinding(restored.id))!
  expect(binding.cardId).toBe(cardA)
  expect(binding.walLineage).toEqual([{ sessionId: parent.id, throughTurn: 1 }])
  const ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  expect((await ws.memory.list()).map(item => item.body)).toEqual(['继承边界内事实'])
  restored.followup(message('冷恢复后的原角色接话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('NATIVE-A-ONLY')
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('NATIVE-B-ONLY')
})

it('首接管记录无法写入后冷恢复即使来源已解绑也明确拒绝，不能发出继承角色历史', async () => {
  faults.rename = join(root, hostForkAdoptionFile('native-child'))
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  expect(await new WorkspaceFs(root, null).readText(hostForkAdoptionFile(original.id))).toBeNull()
  await state.clearBinding(parent.id)
  const restored = await coldResume(original)
  await expect(adoptions.get(restored.id)).rejects.toThrow(/无法确认.*原来源.*重新创建分支/)
  restored.followup(message('没有记录的旧角色不得发信')); await idle(restored)
  expect(requests).toHaveLength(0)
  expect(await state.loadBindingUnwaited(restored.id)).toBeNull()
  expect(state.openFloors.has(restored.id)).toBe(false)
})

it('已确认未绑定的 skip 凭据允许冷恢复普通助手发信，不沿后来父绑定自动选卡', async () => {
  await state.clearBinding(parent.id)
  const original = await child()
  expect(await adoptions.get(original.id)).toBe(false)
  const record = JSON.parse((await new WorkspaceFs(root, null).readText(hostForkAdoptionFile(original.id)))!)
  expect(record.status).toBe('skipped'); expect(record.binding).toBeUndefined(); expect(record.sourceCheckpoint).toBeUndefined()
  await state.saveBinding({ sessionId: parent.id, cardId: cardB, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  expect(await state.loadBinding(restored.id)).toBeNull()
  restored.followup(message('确认合法的普通会话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('已有合法子绑定成功清接管记录后仍可公开冷 resume，不误拒绝独立剧情', async () => {
  const original = await child()
  expect(await adoptions.get(original.id)).toBe(true)
  const binding = (await state.loadBinding(original.id))!
  expect(await new WorkspaceFs(root, null).readText(hostForkAdoptionFile(original.id))).toBeNull()
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  expect(await state.loadBinding(restored.id)).toMatchObject({ cardId: cardA, storyId: binding.storyId })
  restored.followup(message('已绑定分支正常冷恢复')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('已绑定子剧情的残留接管记录不依赖旧来源可读，冷恢复仍正常发信', async () => {
  faults.remove = join(root, hostForkAdoptionFile('native-child'))
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂接管记录清理失败')
  expect(await state.loadBindingUnwaited(original.id)).toMatchObject({ cardId: cardA })
  faults.read = join(state.paths.characters, cardA, 'stories', storyA, 'story.json')
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  restored.followup(message('独立剧情无需旧来源重读')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('成功原生分支经服务明确解除绑定后冷恢复仍可普通助手发信', async () => {
  const original = await child()
  expect(await adoptions.get(original.id)).toBe(true)
  const service = ctx.get('tavern') as TavernService
  expect(await service.clearSessionBinding({ sessionId: original.id })).toEqual({ cleared: true })
  expect(await state.loadBinding(original.id)).toBeNull()
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  expect(await state.loadBinding(restored.id)).toBeNull()
  restored.followup(message('解除角色后普通助手接话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('已发布绑定清理失败留下的旧 ready 重试，在合法解除后不能重新绑回角色', async () => {
  faults.remove = join(root, hostForkAdoptionFile('native-child'))
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂接管记录清理失败')
  const service = ctx.get('tavern') as TavernService
  expect(await service.clearSessionBinding({ sessionId: original.id })).toEqual({ cleared: true })
  expect(await state.loadBinding(original.id)).toBeNull()
  original.followup(message('明确解除后本进程普通助手接话')); await idle(original)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  expect(await state.loadBinding(original.id)).toBeNull()
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  expect(await state.loadBinding(restored.id)).toBeNull()
})

it('upfront 已绑子剧情的迟到真实删除与明确解除串行，不能删除刚保存的 skip 意图', async () => {
  const original = await child()
  expect(await adoptions.get(original.id)).toBe(true)
  await handles.get(original.id)!.dispose()
  deletionPause.sessionId = original.id
  deletionPause.entered = Promise.withResolvers<void>(); deletionPause.released = Promise.withResolvers<void>()
  const resumed = (await ctx.agents.resume({ resumeSessionId: original.id, agentOptions: { provider: 'factory', model: 'factory' } })).agent
  await deletionPause.entered.promise
  const service = ctx.get('tavern') as TavernService
  let cleared = false
  const clearing = service.clearSessionBinding({ sessionId: resumed.id }).then(value => { cleared = true; return value })
  await new Promise(resolve => setTimeout(resolve, 30))
  const clearedBeforeCleanup = cleared
  deletionPause.released.resolve()
  expect(await adoptions.get(resumed.id)).toBe(false)
  expect(await clearing).toEqual({ cleared: true })
  expect(clearedBeforeCleanup).toBe(false)
  expect(JSON.parse((await new WorkspaceFs(root, null).readText(hostForkAdoptionFile(resumed.id)))!).status).toBe('skipped')
  const restored = await coldResume(resumed)
  expect(await adoptions.get(restored.id)).toBe(false)
  restored.followup(message('前置清理后合法普通会话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('明确解除的 skip 保存失败时不取消、不删已有绑定，重试同批解除后冷恢复仍正常', async () => {
  const original = await child()
  expect(await adoptions.get(original.id)).toBe(true)
  const binding = (await state.loadBinding(original.id))!, service = ctx.get('tavern') as TavernService
  const cancel = vi.spyOn(original, 'cancel')
  faults.rename = join(root, hostForkAdoptionFile(original.id))
  await expect(service.clearSessionBinding({ sessionId: original.id })).rejects.toThrow('工厂子绑定发布失败')
  expect(cancel).not.toHaveBeenCalled()
  expect(await state.loadBinding(original.id)).toEqual(binding)
  expect(await Promise.all([service.clearSessionBinding({ sessionId: original.id }), service.clearSessionBinding({ sessionId: original.id })])).toEqual([{ cleared: true }, { cleared: true }])
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  restored.followup(message('解除重试后普通会话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('子绑定发布后的清理晚窗与服务解除串行，解除凭据不能被迟到接管清理删除', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const save = state.saveBinding.bind(state)
  vi.spyOn(state, 'saveBinding').mockImplementationOnce(async (...args) => { await save(...args); entered.resolve(); await release.promise })
  const original = await child(); await entered.promise
  const service = ctx.get('tavern') as TavernService
  let cleared = false
  const clearing = service.clearSessionBinding({ sessionId: original.id }).then(value => { cleared = true; return value })
  await new Promise(resolve => setTimeout(resolve, 30))
  const clearedBeforeCleanup = cleared
  release.resolve()
  expect(await adoptions.get(original.id)).toBe(true)
  expect(await clearing).toEqual({ cleared: true })
  expect(clearedBeforeCleanup).toBe(false)
  const record = JSON.parse((await new WorkspaceFs(root, null).readText(hostForkAdoptionFile(original.id)))!)
  expect(record.status).toBe('skipped')
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  restored.followup(message('晚窗解除后正常普通会话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('确认未绑定后 skip 写入失败仍拒绝，下一次读必须持久化凭据再允许冷恢复', async () => {
  await state.clearBinding(parent.id)
  faults.rename = join(root, hostForkAdoptionFile('native-child')); faults.renameCountdown = 3
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  const fs = new WorkspaceFs(root, null), file = hostForkAdoptionFile(original.id)
  expect(JSON.parse((await fs.readText(file))!).status).toBe('checkpoint')
  expect(await state.loadBinding(original.id)).toBeNull()
  expect(JSON.parse((await fs.readText(file))!).status).toBe('skipped')
  const restored = await coldResume(original)
  expect(await adoptions.get(restored.id)).toBe(false)
  restored.followup(message('凭据重试后合法普通会话')); await idle(restored)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})

it('初始来源检查点无法确认的记录跨冷恢复仍拒绝，不因 I/O 已恢复而猜来源', async () => {
  faults.stat = sessionFile(state.paths, parent.id)
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂来源绑定检查点读取失败')
  const restored = await coldResume(original)
  await expect(adoptions.get(restored.id)).rejects.toThrow(/未能确认.*来源绑定.*重新创建分支/)
  restored.followup(message('未知来源不得因重启绕过')); await idle(restored)
  expect(requests).toHaveLength(0)
})

it('私有接管记录内部目录被真实链接替换时拒绝冷恢复，不读取或重写链接目标', async () => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  const file = hostForkAdoptionFile(original.id), before = await new WorkspaceFs(root, null).readText(file)
  await rename(join(root, 'state'), join(root, 'original-state'))
  await symlink(join(root, 'original-state'), join(root, 'state'), process.platform === 'win32' ? 'junction' : 'dir')
  const restored = await coldResume(original)
  await expect(adoptions.get(restored.id)).rejects.toThrow('链接')
  restored.followup(message('链接记录不能接管')); await idle(restored)
  expect(requests).toHaveLength(0)
  expect(await new WorkspaceFs(join(root, 'original-state'), null).readText(file.slice('state/'.length))).toBe(before)
})

it('原来源卡目录被真实 junction 替换时冷恢复在准备剧情之前拒绝，不跨链接写入', async () => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  const backup = join(root, 'original-card'), cardRoot = join(state.paths.characters, cardA)
  await rename(cardRoot, backup)
  const fs = new WorkspaceFs(backup, null), before = await fs.list('stories')
  await symlink(backup, cardRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const paths = state.paths
  await ctx.fiber.dispose()
  state = new TavernState(paths, () => resolveConfig({})); await state.init()
  runtime(); plugin()
  const preparing = vi.spyOn(state, 'forkStory')
  const restored = (await ctx.agents.resume({ resumeSessionId: original.id, agentOptions: { provider: 'factory', model: 'factory' } })).agent
  await expect(adoptions.get(restored.id)).rejects.toThrow('链接')
  restored.followup(message('链接来源不得准备副本')); await idle(restored)
  expect(requests).toHaveLength(0); expect(preparing).not.toHaveBeenCalled()
  expect(await fs.list('stories')).toEqual(before)
})

it.each([false, true])('未验证来源的检查点跨冷恢复保留：文件换绑 %s 时安全恢复或拒绝', async changed => {
  faults.read = sessionFile(state.paths, parent.id)
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂来源绑定读取失败')
  if (changed) await state.saveBinding({ ...(await state.loadBinding(parent.id))!, cardId: cardB, storyId: undefined })
  const restored = await coldResume(original)
  if (changed) {
    await expect(adoptions.get(restored.id)).rejects.toThrow(/来源.*绑定.*变化.*重新.*分支/)
    restored.followup(message('检查点已变化不得发信')); await idle(restored)
    expect(requests).toHaveLength(0)
  } else {
    expect(await adoptions.get(restored.id)).toBe(true)
    expect(await state.loadBinding(restored.id)).toMatchObject({ cardId: cardA })
    restored.followup(message('检查点未变正常恢复')); await idle(restored)
    expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  }
})

it.each(['json', 'sessionId', 'parentId', 'seedHash', 'inheritedCount', 'rollbackFromTurn', 'storyOwner', 'statusArray'])('损坏的持久接管记录 %s 冷恢复整条拒绝，不写剧情或发信', async field => {
  faults.rename = sessionFile(state.paths, 'native-child')
  const original = await child()
  await expect(adoptions.get(original.id)).rejects.toThrow('工厂子绑定发布失败')
  const fs = new WorkspaceFs(root, null), file = hostForkAdoptionFile(original.id)
  const before = (await state.listStories(cardA)).length
  const record = JSON.parse((await fs.readText(file))!)
  if (field === 'storyOwner') {
    const other = { ...(await state.loadBinding(parent.id))!, sessionId: 'other-owner', storyId: undefined }
    await state.saveBinding(other)
    record.binding.storyId = (await state.loadBinding('other-owner'))!.storyId
  } else if (field === 'statusArray') {
    record.status = ['unverified']
    for (const key of ['sourceUncertain', 'sourceCheckpoint', 'binding', 'rollbackFromTurn']) delete record[key]
  } else if (field === 'rollbackFromTurn') record.rollbackFromTurn = 99
  else if (field === 'inheritedCount') record.inheritedCount += 1
  else if (field !== 'json') record[field] = 'wrong-original-identity'
  await fs.writeText(file, field === 'json' ? '{broken' : JSON.stringify(record))
  const currentStories = (await state.listStories(cardA)).length
  const restored = await coldResume(original)
  await expect(adoptions.get(restored.id)).rejects.toThrow('接管记录损坏')
  restored.followup(message('损坏的记录不得发信')); await idle(restored)
  expect(requests).toHaveLength(0)
  expect((await state.listStories(cardA)).length).toBe(currentStories)
  expect(currentStories).toBe(before + (field === 'storyOwner' ? 1 : 0))
  expect(await state.loadBindingUnwaited(restored.id)).toBeNull()
})

it('初次来源读取失败后同 seq 换绑使检查点失效，旧角色 seed 不能改接新剧情', async () => {
  faults.read = sessionFile(state.paths, parent.id)
  const agent = await child(), seq = parent.session.snapshotEvents().length
  await expect(adoptions.get(agent.id)).rejects.toThrow('工厂来源绑定读取失败')
  await state.saveBinding({ ...(await state.loadBinding(parent.id))!, cardId: cardB, storyId: undefined })
  expect(parent.session.snapshotEvents()).toHaveLength(seq)
  await expect(state.loadBinding(agent.id)).rejects.toThrow(/来源.*绑定.*变化.*重新.*分支/)
  agent.followup(message('旧角色不得转交新绑定')); await idle(agent)
  expect(requests).toHaveLength(0)
  expect(await state.loadBindingUnwaited(agent.id)).toBeNull()
})

it('初次来源文件检查点不可取得时保留明确失败，用户重新分支可安全恢复', async () => {
  faults.stat = sessionFile(state.paths, parent.id)
  const agent = await child()
  await expect(adoptions.get(agent.id)).rejects.toThrow('工厂来源绑定检查点读取失败')
  await expect(state.loadBinding(agent.id)).rejects.toThrow(/未能确认.*来源绑定.*重新创建分支/)
  agent.followup(message('未知初始来源不得发信')); await idle(agent)
  expect(requests).toHaveLength(0)
  expect(await state.loadBindingUnwaited(agent.id)).toBeNull()
  const replacement = await child('native-replacement')
  expect(await adoptions.get(replacement.id)).toBe(true)
  replacement.followup(message('重新分支后的角色接话')); await idle(replacement)
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('NATIVE-A-ONLY')
})

it('公开宿主连续分支在父接管尚未发布时等待父剧情，不持 sessions 锁互相等待', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = state.forkStory.bind(state)
  vi.spyOn(state, 'forkStory').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return original(...args) })
  const middle = await child('native-middle'); await entered.promise
  const middleSeed = middle.session.snapshotEvents()
  const leaf = (await ctx.agents.create({ sessionId: SessionId('native-leaf'), seed: middleSeed,
    inheritedEventCount: SessionLogOffset(middleSeed.length), meta: { parentSession: middle.id, isSeeded: true, agentPreset: 'tavern' },
    agentOptions: { provider: 'factory', model: 'factory' },
  })).agent
  const reads = Promise.all([state.loadBinding(middle.id), state.loadBinding(leaf.id)])
  release.resolve()
  const [middleBinding, leafBinding] = await reads
  expect(middleBinding?.cardId).toBe(cardA); expect(leafBinding?.cardId).toBe(cardA)
  expect(leafBinding?.storyId).not.toBe(middleBinding?.storyId)
  const ws = await state.storyWorkspace(leafBinding!.cardId, leafBinding!.storyId)
  expect((await ws.memory.list()).map(item => item.body)).toEqual(['继承边界内事实'])
  leaf.followup(message('连续分支独立角色接话')); await idle(leaf)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
  expect(state.openFloors.has(leaf.id)).toBe(false)
})

it('来源确实未绑定的合法跳过仍返回 null，允许普通会话发信', async () => {
  await state.clearBinding(parent.id)
  const agent = await child()
  expect(await adoptions.get(agent.id)).toBe(false)
  expect(await state.loadBinding(agent.id)).toBeNull()
  agent.followup(message('合法未绑定会话')); await idle(agent)
  expect(errors).toEqual([]); expect(requests).toHaveLength(1)
})
