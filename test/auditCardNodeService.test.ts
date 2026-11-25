/**
 * 角色卡 Node / Service / Floors / Import / Helper / Doctor 审计回归测试。
 *
 * 覆盖 11 项已核实的真实文件系统 + 模拟宿主边界修复：
 * 1. V1 卡 spec 与 V2 包装 raw 失步（saveCharacterHelperScripts / attachCharacterBookMetadata）
 * 2. TavernState.loadCharacter 不永久缓存 null，修复损坏/缺失 card.json 后立即恢复
 * 3. deleteCharacter 与 7 项面板写入的 TOCTOU 竞态与无死锁串行化
 * 4. 收纳箱守卫补全（adoptHostFork 不陷入无限重试、forkAt 快速失败、importSessionArchive、角色资产编辑）
 * 5. saveCharacterLorebook 数组格式修订号一致 & 无名空书 { entries: {} } / { entries: [] } / [] 往返保存
 * 6. enterGreetingConversation 在异步读资产后复核绑定，避免解绑/换卡/改下标后写入过期开场白
 * 7. deleteCharacter / saveCharacter 异常路径 try...finally 缓存失效
 * 8. doctor 识别 characters/.preparing-* 草稿目录与 assets/regex-scripts.json 大文件上限
 * 9. renderOutputText 对越界 greetingIndex 按 activeGreetingIndex 夹紧
 * 10. Windows 下 saveBinding 新绑定/换卡按磁盘目录拼写规范化 cardId
 * 11. 空白 persona.name 在开场白、展示渲染与酒馆助手中统一回落 DEFAULT_USER_NAME
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USER_NAME } from '../src/core/persona.js'
import { runDoctor } from '../src/doctor.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { adoptHostFork, editAssistantMessage, enterGreetingConversation, regenerate, rollbackToFloor } from '../src/node/floors.js'
import { getHelperScriptBundle, getHelperSnapshot } from '../src/node/helperRuntime.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'
import { TavernService } from '../src/node/service.js'
import { importSessionArchive } from '../src/node/sessionArchiveImport.js'
import { snapshotSessionArchive } from '../src/node/sessionArchiveSnapshot.js'
import { CharacterArchivedError, TavernState } from '../src/node/state.js'
import { MAX_STORED_CARD_JSON_BYTES } from '../src/state/card.js'
import { jsonEditRevision } from '../src/state/characterRevision.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { MemoryStore } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'

const fsFaults = vi.hoisted(() => ({
  failRmTarget: '',
  partialDeleteCardJson: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0])
      if (fsFaults.failRmTarget && target.toLowerCase() === fsFaults.failRmTarget.toLowerCase()) {
        fsFaults.failRmTarget = ''
        if (fsFaults.partialDeleteCardJson) {
          fsFaults.partialDeleteCardJson = false
          await actual.rm(join(target, 'card.json'), { force: true })
        }
        throw Object.assign(new Error('模拟 Windows EBUSY 删除中断'), { code: 'EBUSY' })
      }
      return actual.rm(...args)
    },
  }
})

let root: string
let paths: TavernPaths
let state: TavernState

function makePaths(base: string): TavernPaths {
  return {
    root: base,
    characters: join(base, 'characters'),
    lorebooks: join(base, 'library', 'lorebooks'),
    presets: join(base, 'library', 'presets'),
    personas: join(base, 'personas'),
    regexDir: join(base, 'regex'),
    sessions: join(base, 'sessions'),
  }
}

function makeBinding(sessionId: string, cardId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    cardId,
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    greetingIndex: 0,
    interactiveCards: false,
    helperMvu: false,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function makeMinimalService(ctxOverride?: Partial<Context>): TavernService {
  const ctx = {
    reflect: { provide: () => {} },
    get: () => undefined,
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    logger: { warn: () => {}, info: () => {} },
    ...ctxOverride,
  } as unknown as Context
  const settingsScope: TavernSettingsScope = {
    get: () => resolveConfig({}),
    update: async () => undefined,
  } as unknown as TavernSettingsScope
  return new TavernService(ctx, state, settingsScope)
}

beforeEach(async () => {
  fsFaults.failRmTarget = ''
  fsFaults.partialDeleteCardJson = false
  root = await mkdtemp(join(tmpdir(), 'tavern-audit-card-node-'))
  paths = makePaths(root)
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
})

afterEach(async () => {
  fsFaults.failRmTarget = ''
  fsFaults.partialDeleteCardJson = false
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('1. V1 卡 spec 与 V2 包装 raw 一致性（node 侧）', () => {
  it('saveCharacterHelperScripts 升级 V1 卡为 V2 包装 raw 时同步更新 spec', async () => {
    const v1Bytes = new TextEncoder().encode(JSON.stringify({
      name: '旧版V1角色',
      description: 'V1描述',
      first_mes: '你好',
    }))
    const imported = await state.importCharacter('v1.json', v1Bytes)
    expect(imported.card.spec).toBe('chara_card_v1')

    const initial = await state.getCharacterHelperScripts(imported.cardId)
    await state.saveCharacterHelperScripts(imported.cardId, initial.revision, [
      { id: 'script-v1', enabled: true, content: 'console.log(1)' },
    ])

    const rawStored = JSON.parse(await readFile(join(paths.characters, imported.cardId, 'card.json'), 'utf8')) as {
      spec: string
      raw: { spec: string; data: { extensions?: { tavern_helper?: { scripts?: unknown[] } } } }
    }
    expect(rawStored.spec).toBe('chara_card_v2')
    expect(rawStored.raw.spec).toBe('chara_card_v2')
    expect(rawStored.raw.data.extensions?.tavern_helper?.scripts).toHaveLength(1)

    const reloaded = await state.loadCharacter(imported.cardId)
    expect(reloaded?.card.spec).toBe('chara_card_v2')
  })

  it('attachCharacterBookMetadata 对 V2 包装 raw（含遗留 spec=v1 失步卡与空 raw 回退）始终写入 data.character_book', async () => {
    const { cardId } = await state.createCharacter('遗留V1失步卡')
    const cardPath = join(paths.characters, cardId, 'card.json')
    const stored = JSON.parse(await readFile(cardPath, 'utf8')) as Record<string, unknown>
    stored.spec = 'chara_card_v1'
    stored.raw = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '遗留V1失步卡', description: 'desc' } }
    await writeFile(cardPath, JSON.stringify(stored, null, 2), 'utf8')

    // 用新实例读取模拟冷启动加载遗留失步卡
    const cold = new TavernState(paths, () => resolveConfig({}))
    await cold.init()
    await cold.saveCharacterLorebook(cardId, { name: '嵌书', entries: [{ keys: ['k'], content: 'v' }] })

    const updated = JSON.parse(await readFile(cardPath, 'utf8')) as {
      spec: string
      raw: Record<string, unknown> & { data?: Record<string, unknown> }
    }
    expect(updated.spec).toBe('chara_card_v2')
    expect(updated.raw.character_book).toBeUndefined()
    expect(updated.raw.data?.character_book).toEqual({ name: '嵌书', entries: [{ keys: ['k'], content: 'v' }] })

    // 空 raw 回退到 cardToStJson（V2 包装）时同样写入 data.character_book
    updated.spec = 'chara_card_v1'
    updated.raw = {}
    await writeFile(cardPath, JSON.stringify(updated, null, 2), 'utf8')
    const cold2 = new TavernState(paths, () => resolveConfig({}))
    await cold2.init()
    await cold2.saveCharacterLorebook(cardId, { name: '回退书', entries: [{ keys: ['a'], content: 'b' }] })

    const afterFallback = JSON.parse(await readFile(cardPath, 'utf8')) as {
      spec: string
      raw: Record<string, unknown> & { data?: Record<string, unknown> }
    }
    expect(afterFallback.spec).toBe('chara_card_v2')
    expect(afterFallback.raw.character_book).toBeUndefined()
    expect(afterFallback.raw.data?.character_book).toEqual({ name: '回退书', entries: [{ keys: ['a'], content: 'b' }] })
  })
})

describe('2. TavernState.loadCharacter 不永久缓存 null', () => {
  it('损坏或缺失的 card.json 在磁盘修复后，同一 TavernState 实例立即恢复读取与绑定加载', async () => {
    const { cardId } = await state.createCharacter('可恢复角色')
    await state.saveBinding(makeBinding('sess-recover', cardId))
    const cardPath = join(paths.characters, cardId, 'card.json')
    const backup = await readFile(cardPath, 'utf8')

    // 破坏磁盘 card.json，在冷态实例上触发失败读取
    await writeFile(cardPath, '{broken json', 'utf8')
    const live = new TavernState(paths, () => resolveConfig({}))
    await live.init()
    expect(await live.loadCharacter(cardId)).toBeNull()
    await expect(live.loadBinding('sess-recover')).rejects.toThrow(/card\.json 缺失或损坏/)

    // 磁盘原地修复，不重启也不构造新 TavernState
    await writeFile(cardPath, backup, 'utf8')
    const recovered = await live.loadCharacter(cardId)
    expect(recovered?.card.name).toBe('可恢复角色')
    const binding = await live.loadBinding('sess-recover')
    expect(binding?.cardId).toBe(cardId)
  })
})

describe('3. deleteCharacter 与面板写入竞态不复活僵尸目录且无死锁', () => {
  it('deleteCharacter 抢先删卡后，所有 7 项延迟面板写入均拒绝且不重建目录', async () => {
    const service = makeMinimalService()
    const cases: Array<{
      name: string
      withStory: boolean
      run: (cardId: string, storyId?: string) => Promise<unknown>
    }> = [
      { name: 'saveMemory', withStory: true, run: (cardId, storyId) => service.saveMemory({ cardId, storyId, body: '滞后记忆' }) },
      { name: 'deleteMemory', withStory: true, run: (cardId, storyId) => service.deleteMemory({ cardId, storyId, id: 'm1' }) },
      { name: 'compressMemories', withStory: true, run: (cardId, storyId) => service.compressMemories({ cardId, storyId }) },
      { name: 'saveJournal', withStory: true, run: (cardId, storyId) => service.saveJournal({ cardId, storyId, text: '滞后笔记', expectedRevision: jsonEditRevision('') }) },
      { name: 'saveChatLorebook', withStory: true, run: (cardId, storyId) => service.saveChatLorebook({ cardId, storyId, json: { entries: {} }, expectedRevision: jsonEditRevision({ entries: {} }) }) },
      { name: 'addWorldDelta', withStory: true, run: (cardId, storyId) => service.addWorldDelta({ cardId, storyId, type: 'add', content: '滞后变化' }) },
      { name: 'revokeWorldDelta', withStory: true, run: (cardId, storyId) => service.revokeWorldDelta({ cardId, storyId, id: 'd1' }) },
      { name: 'saveMemory(cardRoot)', withStory: false, run: (cardId) => service.saveMemory({ cardId, body: '卡根滞后记忆' }) },
    ]

    for (const tc of cases) {
      const { cardId } = await state.createCharacter(`竞态-${tc.name}`)
      let storyId: string | undefined
      if (tc.withStory) {
        await state.saveBinding(makeBinding(`s-${tc.name}`, cardId))
        storyId = (await state.loadBinding(`s-${tc.name}`))!.storyId!
        await state.clearBinding(`s-${tc.name}`)
      }
      await state.archiveCharacter(cardId)
      const cardRoot = join(paths.characters, cardId)

      // 持 cardRoot 锁模拟删除已在排队；先放行删除，再让滞后的面板写获取锁
      const gate = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const blocker = withWorkspaceLock(cardRoot, async () => {
        held.resolve()
        await gate.promise
      })
      await held.promise

      const deletion = state.deleteCharacter(cardId, { discardStoryIds: storyId ? [storyId] : [] })
      // 让 deletion 先拿到 sessions 锁并排进 cardRoot 锁队列，再发起滞后的 panelWrite
      await new Promise<void>((r) => setImmediate(r))
      const panelWrite = tc.run(cardId, storyId)
      await new Promise<void>((r) => setImmediate(r))
      gate.resolve()

      await expect(deletion).resolves.toEqual({ salvagedLorebook: null })
      await blocker
      await expect(panelWrite).rejects.toThrow(/不存在/)
      expect(existsSync(cardRoot)).toBe(false)
    }
  })

  it('面板写先持有 storyRoot → cardRoot 锁时，并发 deleteCharacter 正常排队完成且无死锁', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('反序锁测试')
    await state.saveBinding(makeBinding('s-order', cardId))
    const storyId = (await state.loadBinding('s-order'))!.storyId!
    await state.clearBinding('s-order')
    await state.archiveCharacter(cardId)

    const cardRoot = join(paths.characters, cardId)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const origWrite = WorkspaceFs.prototype.writeText
    const spy = vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (this: WorkspaceFs, path, text) {
      if (path === 'journal.md') {
        entered.resolve()
        await release.promise
      }
      return origWrite.call(this, path, text)
    })

    const journalSave = service.saveJournal({ cardId, storyId, text: '并发写入', expectedRevision: jsonEditRevision('') })
    await entered.promise
    const deletion = state.deleteCharacter(cardId, { discardStoryIds: [storyId] })
    release.resolve()

    const [saved, deleted] = await Promise.race([
      Promise.all([journalSave, deletion]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('检测到死锁超时')), 3000)),
    ])
    spy.mockRestore()
    expect(saved.saved).toBe(true)
    expect(deleted.salvagedLorebook).toBeNull()
    expect(existsSync(cardRoot)).toBe(false)
  })
})

describe('4. 收纳箱守卫与 adoptHostFork 非重试收敛', () => {
  it('4a: 已收纳角色上的 adoptHostFork 在 forkStory 前快速失败且不进入无限重试循环', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    new SessionProjectionRegistry(ctx)
    try {
      const { cardId } = await state.createCharacter('收纳分支源')
      await state.saveBinding(makeBinding('parent-arch', cardId))
      const parentBinding = (await state.loadBinding('parent-arch'))!
      const ws = await state.storyWorkspace(cardId, parentBinding.storyId)
      const floor = 'parent-arch#t1'
      await ws.wal.beginFloor(floor)
      await new MemoryStore(ws.fs.withFloor(floor)).write({ body: '源剧情记忆' })
      await ws.wal.commitFloor(floor)

      const parent = ctx.sessions.create(SessionId('parent-arch'))
      parent.append('agent-preset/selected', { agentPreset: 'tavern' })
      parent.append('turn/start', { turn: 1 })
      parent.append('step/start', { turn: 1, step: 1 })
      parent.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
      parent.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
      parent.append('assistant/message', {
        turn: 1, step: 1,
        stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        message: createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: 'hello' }] }),
      }, { surfaceOp: 'append' })
      parent.append('step/end', { turn: 1, step: 1 })
      parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await state.archiveCharacter(cardId)
      const storiesBefore = (await state.listStories(cardId)).length
      const forkSpy = vi.spyOn(state, 'forkStory')
      let adoptionRuns = 0

      const seed = parent.snapshotEvents()
      const child = ctx.sessions.create(SessionId('child-arch'), {
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { parentSession: parent.id, isSeeded: true, agentPreset: 'tavern' },
      })

      const tracked = state.trackBindingAdoption(child.id, () => {
        adoptionRuns += 1
        return adoptHostFork({ ctx, state }, child)
      })
      await expect(tracked).rejects.toBeInstanceOf(CharacterArchivedError)
      expect(forkSpy).not.toHaveBeenCalled()
      expect(adoptionRuns).toBe(1)
      expect((await state.listStories(cardId)).length).toBe(storiesBefore)

      // 连续多次 loadBinding 不再重跑 adoptHostFork / forkStory，保持 fail-closed 抛出 CharacterArchivedError
      for (let i = 0; i < 4; i++) {
        await expect(state.loadBinding(child.id)).rejects.toBeInstanceOf(CharacterArchivedError)
      }
      expect(adoptionRuns).toBe(1)
      expect(forkSpy).not.toHaveBeenCalled()
      const retries = (state as unknown as { bindingAdoptionRetries: Map<string, unknown> }).bindingAdoptionRetries
      expect(retries.has(child.id)).toBe(false)

      // 恢复角色后，下一次读取允许完成接管
      await state.restoreCharacter(cardId)
      const adopted = await state.loadBinding(child.id)
      expect(adopted?.cardId).toBe(cardId)
      expect(adopted?.storyId).not.toBe(parentBinding.storyId)
      expect(adoptionRuns).toBe(2)
      expect(forkSpy).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('4b: 已收纳角色上的 forkAt（regenerate / rollbackToFloor / editAssistantMessage）在 forkStory 和 create 前快速失败', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    try {
      const { cardId } = await state.createCharacter('收纳楼层操作')
      await state.saveBinding(makeBinding('sess-fork-arch', cardId))
      const session = ctx.sessions.create(SessionId('sess-fork-arch'))
      session.append('agent-preset/selected', { agentPreset: 'tavern' })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] }), { surfaceOp: 'append' })
      const assistant = createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '第一条回复' }] })
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: assistant }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      await state.archiveCharacter(cardId)
      const forkSpy = vi.spyOn(state, 'forkStory')
      const createSpy = vi.spyOn(ctx.agents, 'create')

      await expect(regenerate({ ctx, state }, session.id, assistant.id)).rejects.toBeInstanceOf(CharacterArchivedError)
      await expect(rollbackToFloor({ ctx, state }, session.id, assistant.id)).rejects.toBeInstanceOf(CharacterArchivedError)
      await expect(editAssistantMessage({ ctx, state }, session.id, assistant.id, '编辑正文')).rejects.toBeInstanceOf(CharacterArchivedError)

      expect(forkSpy).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('4c: importSessionArchive 拒绝向已收纳角色导入新会话/剧情', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    try {
      const { cardId } = await state.createCharacter('收纳迁移目标')
      await state.saveBinding(makeBinding('session-src', cardId))
      const session = ctx.sessions.create(SessionId('session-src'))
      session.append('agent-preset/selected', { agentPreset: 'tavern' })
      const persistence = {
        open: async () => ({ header: session.header, inheritedEventCount: 0, read: async () => ({ events: session.snapshotEvents() }), close: async () => {} }),
        stat: async () => undefined,
        create: vi.fn(),
      }
      const fakeCtx = {
        sessions: { get: (id: string) => id === 'session-src' ? session : undefined, flush: async () => true, messageProjections: ctx.sessions.messageProjections },
        get: (name: string) => name === 'sessionPersistence' ? persistence
          : name === 'workspaceRegistry' ? { list: () => [{ id: 'ws-1', path: root, attachSession: async () => {} }] } : undefined,
      } as unknown as Context

      const archive = await snapshotSessionArchive(fakeCtx, state, 'session-src')
      const originalStoryId = archive.binding.storyId!
      // 清掉原绑定与原剧情后收纳该角色，模拟将一份合法会话迁移包导入已收纳角色
      await state.clearBinding('session-src')
      await state.discardUnboundStory(cardId, originalStoryId, 'session-src')
      await state.archiveCharacter(cardId)
      const storiesBefore = (await state.listStories(cardId)).length

      const destCtx = {
        sessions: { get: () => undefined, flush: async () => true, messageProjections: ctx.sessions.messageProjections },
        get: (name: string) => name === 'sessionPersistence' ? persistence
          : name === 'workspaceRegistry' ? { list: () => [{ id: 'ws-1', path: root, attachSession: async () => {} }] } : undefined,
      } as unknown as Context

      await expect(importSessionArchive(destCtx, state, archive, 'ws-1')).rejects.toBeInstanceOf(CharacterArchivedError)
      expect((await state.listStories(cardId)).length).toBe(storiesBefore)
      expect(await state.loadBinding('session-src')).toBeNull()
      expect(persistence.create).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('4d: 已收纳角色拒绝 saveCharacter / saveCharacterLorebook / deleteCharacterLorebook / saveCharacterHelperScripts', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('收纳只读角色')
    await state.saveCharacterLorebook(cardId, { name: '原书', entries: [{ keys: ['a'], content: 'b' }] })
    const scriptInitial = await state.getCharacterHelperScripts(cardId)
    const cardBefore = await readFile(join(paths.characters, cardId, 'card.json'), 'utf8')

    await state.archiveCharacter(cardId)

    await expect(state.saveCharacter(cardId, { description: '篡改' })).rejects.toBeInstanceOf(CharacterArchivedError)
    await expect(service.saveCharacter({ cardId, description: '服务篡改' })).rejects.toMatchObject({
      code: 'tavern/character-archived',
      isDSHRemoteError: true,
    })
    await expect(state.saveCharacterLorebook(cardId, { name: '新书', entries: [] })).rejects.toBeInstanceOf(CharacterArchivedError)
    await expect(state.deleteCharacterLorebook(cardId)).rejects.toBeInstanceOf(CharacterArchivedError)
    await expect(state.saveCharacterHelperScripts(cardId, scriptInitial.revision, [{ id: 's1', content: '1' }])).rejects.toBeInstanceOf(CharacterArchivedError)

    expect(await readFile(join(paths.characters, cardId, 'card.json'), 'utf8')).toBe(cardBefore)

    // 恢复后重新允许编辑
    await state.restoreCharacter(cardId)
    await expect(state.saveCharacter(cardId, { description: '恢复后合法修改' })).resolves.toMatchObject({ cardId })
  })
})

describe('5. saveCharacterLorebook 数组修订号与无名空书往返', () => {
  it('数组格式世界书持久化 canonical 对象，返回修订号与 loadCharacterLorebookRaw 一致', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('数组嵌书角色')
    const entry = { keys: ['钥匙'], content: '在抽屉里' }
    const saved = await service.saveCharacterLorebook({ cardId, json: [entry] })

    const loaded = await service.getCharacterLorebook({ cardId })
    expect(loaded.entryCount).toBe(1)
    expect(loaded.revision).toBe(saved.revision)
    expect(loaded.json).toEqual({ entries: [entry] })

    const diskBook = JSON.parse(await readFile(join(paths.characters, cardId, 'assets', 'character-book.json'), 'utf8'))
    expect(diskBook).toEqual({ entries: [entry] })

    // 用第一次返回的 revision 继续保存不会误报冲突
    const next = await service.saveCharacterLorebook({
      cardId,
      json: [{ keys: ['钥匙'], content: '已取出' }],
      expectedRevision: saved.revision,
    })
    expect(next.revision).toBe((await service.getCharacterLorebook({ cardId })).revision)
  })

  it('无名空书 { entries: {} } / { entries: [] } / [] 可清空保存、冷重载与二次编辑，非法结构仍拒绝', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('空书往返角色')
    await state.saveCharacterLorebook(cardId, { entries: { '0': { key: ['k'], content: 'v' } } })

    for (const emptyInput of [{ entries: {} }, { entries: [] }, []] as const) {
      const current = await service.getCharacterLorebook({ cardId })
      const saved = await service.saveCharacterLorebook({
        cardId,
        json: emptyInput,
        expectedRevision: current.revision,
      })
      expect(saved.entryCount).toBe(0)
      expect(saved.name).toBe('空书往返角色')

      // 冷重载仍可读到空书且 revision 与 parseLorebook 全部一致
      const cold = new TavernState(paths, () => resolveConfig({}))
      await cold.init()
      const reloaded = await cold.loadCharacterLorebookRaw(cardId)
      expect(reloaded).not.toBeNull()
      expect(reloaded!.entryCount).toBe(0)
      expect(jsonEditRevision(reloaded!.json)).toBe(saved.revision)
      expect(parseLorebook(reloaded!.json, { source: 'character', sourceRef: cardId })).toEqual([])

      // 携带该 revision 可继续追加条目
      const refilled = await service.saveCharacterLorebook({
        cardId,
        json: { entries: { '0': { key: ['k2'], content: '恢复条目' } } },
        expectedRevision: saved.revision,
      })
      expect(refilled.entryCount).toBe(1)
    }

    await expect(state.saveCharacterLorebook(cardId, {})).rejects.toThrow('内嵌世界书缺少合法结构')
    await expect(state.saveCharacterLorebook(cardId, { entries: 'invalid' })).rejects.toThrow('内嵌世界书缺少合法结构')
    await expect(state.saveCharacterLorebook(cardId, null)).rejects.toThrow('内嵌世界书缺少合法结构')
  })
})

describe('6. enterGreetingConversation 异步读取后复核绑定', () => {
  it('异步读资产期间解绑或换卡/改开场白下标时，不向会话写入过期开场白', async () => {
    for (const mutation of ['clear', 'switchCard', 'changeGreetingIndex'] as const) {
      const ctx = new Context()
      new SessionStore(ctx)
      new AgentRegistry(ctx)
      try {
        const cardA = await state.createCharacter(`开场白A-${mutation}`)
        await state.saveCharacter(cardA.cardId, { firstMes: '来自A的开场白', alternateGreetings: ['来自A的备选'] })
        const cardB = await state.createCharacter(`开场白B-${mutation}`)
        await state.saveCharacter(cardB.cardId, { firstMes: '来自B的开场白' })

        const session = ctx.sessions.create(SessionId(`sess-greet-${mutation}`))
        session.append('agent-preset/selected', { agentPreset: 'tavern' })
        await state.saveBinding(makeBinding(session.id, cardA.cardId))

        const service = makeMinimalService({
          sessions: { get: (id: string) => id === session.id ? session : undefined } as unknown as Context['sessions'],
        })

        // 拦在 expandGreeting 的 resolvePersona，模拟异步资产读取窗口
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const origResolve = state.resolvePersona.bind(state)
        let hits = 0
        const spy = vi.spyOn(state, 'resolvePersona').mockImplementation(async (personaId) => {
          hits += 1
          if (hits === 2) { // 第 1 次在 loadBinding，第 2 次在 expandGreeting
            entered.resolve()
            await release.promise
          }
          return origResolve(personaId)
        })

        const pending = enterGreetingConversation({ ctx, state }, session.id)
        await entered.promise

        if (mutation === 'clear') {
          await service.clearSessionBinding({ sessionId: session.id })
        } else if (mutation === 'switchCard') {
          await service.setSessionBinding({ binding: makeBinding(session.id, cardB.cardId) })
        } else {
          await service.setSessionBinding({ binding: makeBinding(session.id, cardA.cardId, { greetingIndex: 1 }) })
        }

        release.resolve()
        const created = await pending
        spy.mockRestore()

        expect(created).toBe(false)
        expect(session.snapshotEvents().filter((e) => e.type === 'assistant/message')).toHaveLength(0)
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })
})

describe('7. deleteCharacter 与 saveCharacter 失败路径的 try...finally 缓存失效', () => {
  it('deleteCharacter 部分删除抛错时仍逐出全部进程内缓存与 avatarCache', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('部分删除角色')
    await state.saveCharacterLorebook(cardId, { name: '书', entries: [{ keys: ['k'], content: 'v' }] })
    await state.loadCharacter(cardId)
    await state.loadCharacterLorebookEntries(cardId)
    await state.getCharacterHelperScripts(cardId)
    await state.rulesFor(makeBinding('s-partial', cardId))
    await service.getAvatar({ cardId })
    await state.archiveCharacter(cardId)

    const cardRoot = join(paths.characters, cardId)
    fsFaults.failRmTarget = cardRoot
    fsFaults.partialDeleteCardJson = true

    await expect(service.deleteCharacter({ cardId })).rejects.toThrow(/EBUSY/)
    // card.json 已被部分删除，缓存若未在 finally 清理会继续返回旧卡
    expect(await state.loadCharacter(cardId)).toBeNull()
    const caches = state as unknown as {
      cardCache: Map<string, unknown>
      charLoreCache: Map<string, unknown>
      cardRegexCache: Map<string, unknown>
      charScriptCache: Map<string, unknown>
      workspaces: Map<string, unknown>
    }
    expect(caches.cardCache.size).toBe(0)
    expect(caches.charLoreCache.size).toBe(0)
    expect(caches.cardRegexCache.size).toBe(0)
    expect(caches.charScriptCache.size).toBe(0)
    expect(caches.workspaces.size).toBe(0)
    expect((service as unknown as { avatarCache: Map<string, unknown> }).avatarCache.size).toBe(0)
  })

  it('saveCharacter 写入回执抛错时仍在 finally 推进修订号，下次读盘拿到新内容', async () => {
    const { cardId } = await state.createCharacter('写回执失败角色')
    await state.loadCharacter(cardId) // 预热 cardCache

    const origWrite = WorkspaceFs.prototype.writeText
    const spy = vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (this: WorkspaceFs, path, text) {
      await origWrite.call(this, path, text)
      if (path === 'card.json') throw new Error('模拟落盘后回执失败')
    })

    await expect(state.saveCharacter(cardId, { description: '已落盘但回执异常' })).rejects.toThrow('模拟落盘后回执失败')
    spy.mockRestore()

    const reloaded = await state.loadCharacter(cardId)
    expect(reloaded?.card.description).toBe('已落盘但回执异常')
  })
})

describe('8. doctor 处理 .preparing-* 草稿与大体积 assets/regex-scripts.json', () => {
  it('characters/.preparing-* 记为草稿 info 而非 CHARACTER_ID_INVALID，大体积 regex-scripts.json 不报 oversizedJson', async () => {
    const doctorHome = join(root, 'doctor-home')
    const doctorPaths = makePaths(join(doctorHome, 'dsh-tavern'))
    const doctorState = new TavernState(doctorPaths, () => resolveConfig({}))
    await doctorState.init()
    const { cardId } = await doctorState.createCharacter('诊断角色')
    const draftDir = join(doctorPaths.characters, '.preparing-00000000-0000-4000-8000-000000000001')
    await mkdir(draftDir, { recursive: true })

    // 写入 >16 MiB 但 <128 MiB 的合法 assets/regex-scripts.json
    const bigRules = [{ id: 'r1', name: 'big', find: 'a', replace: 'x'.repeat(17 * 1024 * 1024), enabled: false, scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'card' }]
    const regexJson = JSON.stringify(bigRules)
    expect(Buffer.byteLength(regexJson, 'utf8')).toBeGreaterThan(16 * 1024 * 1024)
    expect(Buffer.byteLength(regexJson, 'utf8')).toBeLessThan(MAX_STORED_CARD_JSON_BYTES)
    await writeFile(join(doctorPaths.characters, cardId, 'assets', 'regex-scripts.json'), regexJson, 'utf8')

    const report = await runDoctor({ home: doctorHome })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters.drafts).toBe(1)
    expect(report.statistics.characters.invalidIds).toBe(0)
    expect(report.statistics.files.oversizedJson).toBe(0)
    expect(report.issues).toContainEqual({ code: 'CHARACTER_DRAFT_PRESENT', severity: 'info', count: 1 })
    expect(report.issues.some((issue) => issue.code === 'CHARACTER_ID_INVALID')).toBe(false)

    // .preparing-* 符号链接/junction 仍按不安全链接报错
    const linkTarget = join(root, 'external-dir')
    await mkdir(linkTarget, { recursive: true })
    await symlink(linkTarget, join(doctorPaths.characters, '.preparing-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const linkReport = await runDoctor({ home: doctorHome })
    expect(linkReport.ok).toBe(false)
    expect(linkReport.issues.some((issue) => issue.code === 'CHARACTER_LINK_SKIPPED')).toBe(true)
  })
})

describe('9. renderOutputText 夹紧越界 greetingIndex', () => {
  it('越界 greetingIndex 返回 0，有效下标保持不变', async () => {
    const service = makeMinimalService()
    const { cardId } = await state.createCharacter('开场白夹紧角色')
    await state.saveCharacter(cardId, { firstMes: '开场0', alternateGreetings: ['开场1'] })

    await state.saveBinding(makeBinding('s-oob', cardId, { greetingIndex: 5 }))
    const oob = await service.renderOutputText({ sessionId: 's-oob', text: '正文' })
    expect(oob.greetings).toEqual(['开场0', '开场1'])
    expect(oob.greetingIndex).toBe(0)

    await state.saveBinding(makeBinding('s-valid', cardId, { greetingIndex: 1 }))
    const valid = await service.renderOutputText({ sessionId: 's-valid', text: '正文' })
    expect(valid.greetingIndex).toBe(1)
  })
})

describe('10. Windows saveBinding 规范化 cardId 磁盘拼写', () => {
  it.runIf(process.platform === 'win32')('新绑定与换卡绑定均将大小写别名规范化为磁盘实际目录名', async () => {
    const cardA = await state.createCharacter('CaseCardAlpha')
    const cardB = await state.createCharacter('CaseCardBeta')
    expect(cardA.cardId).not.toBe(cardA.cardId.toUpperCase())
    expect(cardB.cardId).not.toBe(cardB.cardId.toUpperCase())

    // 新建绑定传入全大写 cardId
    await state.saveBinding(makeBinding('s-win-case', cardA.cardId.toUpperCase()))
    const persistedA = JSON.parse(await readFile(sessionFile(paths, 's-win-case'), 'utf8')) as { cardId: string }
    expect(persistedA.cardId).toBe(cardA.cardId)
    expect((await state.loadBinding('s-win-case'))?.cardId).toBe(cardA.cardId)

    // 换卡绑定传入全大写 cardB
    const current = (await state.loadBinding('s-win-case'))!
    await state.saveBinding({ ...current, cardId: cardB.cardId.toUpperCase(), storyId: undefined })
    const persistedB = JSON.parse(await readFile(sessionFile(paths, 's-win-case'), 'utf8')) as { cardId: string }
    expect(persistedB.cardId).toBe(cardB.cardId)
    expect((await state.loadBinding('s-win-case'))?.cardId).toBe(cardB.cardId)
  })
})

describe('11. 空白 persona.name 统一回落 DEFAULT_USER_NAME', () => {
  it('enterGreetingConversation、renderOutputText、getHelperSnapshot 与 getHelperScriptBundle 均不暴露空白用户名', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    try {
      const { cardId } = await state.createCharacter('空白人设角色')
      await state.saveCharacter(cardId, { firstMes: '欢迎 {{user}} 来到旅馆' })
      const personaId = await state.savePersona({
        id: 'blank-persona',
        name: '   ',
        description: '空白名测试',
        lorebookId: null,
        avatar: null,
      })

      // 1) enterGreetingConversation (expandGreeting)
      const greetSession = ctx.sessions.create(SessionId('s-blank-greet'))
      greetSession.append('agent-preset/selected', { agentPreset: 'tavern' })
      await state.saveBinding(makeBinding(greetSession.id, cardId, { personaId, interactiveCards: true }))
      expect(await enterGreetingConversation({ ctx, state }, greetSession.id)).toBe(true)
      const greetMsg = greetSession.snapshotEvents().find((e) => e.type === 'assistant/message')
      expect(greetMsg && greetMsg.type === 'assistant/message'
        ? greetMsg.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        : '').toBe(`欢迎 ${DEFAULT_USER_NAME} 来到旅馆`)

      // 2) service.renderOutputText
      const service = makeMinimalService({
        sessions: { get: (id: string) => id === greetSession.id ? greetSession : undefined } as unknown as Context['sessions'],
      })
      const rendered = await service.renderOutputText({ sessionId: greetSession.id, text: '你好 {{user}}' })
      expect(rendered.userName).toBe(DEFAULT_USER_NAME)
      expect(rendered.text).toBe(`你好 ${DEFAULT_USER_NAME}`)
      expect(rendered.greetings[0]).toBe(`欢迎 ${DEFAULT_USER_NAME} 来到旅馆`)

      // 3) helperRuntime: getHelperSnapshot & getHelperScriptBundle
      const helperEvents: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 0, surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: '测试台词' }], source: { kind: 'user' } }) },
        { type: 'assistant/message', seq: 2, time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '测试回复' }] }) } },
        { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[]
      const helperCtx = {
        sessions: { get: (id: string) => id === 's-blank-helper' ? { snapshotEvents: () => helperEvents } : undefined },
        get: () => undefined,
      } as unknown as Context
      await state.saveBinding(makeBinding('s-blank-helper', cardId, { personaId, interactiveCards: true }))

      const snap = await getHelperSnapshot(helperCtx, state, 's-blank-helper', 2)
      expect(snap.messages[0]?.name).toBe(DEFAULT_USER_NAME)

      const bundle = await getHelperScriptBundle(helperCtx, state, 's-blank-helper')
      expect(bundle.userName).toBe(DEFAULT_USER_NAME)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
