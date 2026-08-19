/**
 * TavernState 运行时辅助测试（真实临时目录）。
 * 覆盖：
 * - resolveModelInfoCached：同 provider+model 复用一次解析、不同模型各自解析、失败不缓存；
 * - standingRevTags：绑定 → 修订标记形状；savePreset/deletePreset/saveLorebook/deleteLorebook/
 *   saveCharacterLorebook 等写方法 bump 对应修订号（standing 指纹随资产内容失效重算）；
 * - workspace：拒绝会把工作区根移出 characters/ 的非法 cardId；
 * - 会话副作用队列：同会话严格串行、不同会话互不阻塞、失败后仍可继续；
 * - compressOldestMemories：idle 期异步压缩——最旧批次合并为一条并归档、
 *   无模型/空批次/合并失败均不动记忆库。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CharacterCard, PromptPreset } from '../src/core/types.js'
import type { SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { compressOldestMemories } from '../src/node/memoryMaintenance.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { importCard } from '../src/state/workspace.js'

let root: string
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'state-runtime-test-'))
  const paths: TavernPaths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sessionId: 's1',
    cardId: 'c1',
    cardName: '测试角色',
    presetId: 'p1',
    personaId: null,
    lorebookIds: ['g1'],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '测试角色',
    description: '描述',
    personality: '',
    scenario: '',
    firstMes: '你好',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    characterVersion: '1',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: {},
    ...overrides,
  }
}

function mockLlm(info: LlmResolvedModelInfo) {
  const resolveModelInfo = vi.fn(async () => info)
  return { llm: { resolveModelInfo } as unknown as LlmRuntime, resolveModelInfo }
}

describe('resolveModelInfoCached', () => {
  const info = { provider: 'p', id: 'm', name: 'M' } as LlmResolvedModelInfo

  it('同 provider+model 复用一次解析结果', async () => {
    const { llm, resolveModelInfo } = mockLlm(info)
    const a = await state.resolveModelInfoCached(llm, 'p', 'm')
    const b = await state.resolveModelInfoCached(llm, 'p', 'm')
    expect(a).toBe(info)
    expect(b).toBe(info)
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('不同模型各自解析', async () => {
    const { llm, resolveModelInfo } = mockLlm(info)
    await state.resolveModelInfoCached(llm, 'p', 'm1')
    await state.resolveModelInfoCached(llm, 'p', 'm2')
    expect(resolveModelInfo).toHaveBeenCalledTimes(2)
  })

  it('解析失败不缓存，下次重试', async () => {
    let calls = 0
    const resolveModelInfo = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return info
    })
    const llm = { resolveModelInfo } as unknown as LlmRuntime
    await expect(state.resolveModelInfoCached(llm, 'p', 'm')).rejects.toThrow('boom')
    await expect(state.resolveModelInfoCached(llm, 'p', 'm')).resolves.toBe(info)
    expect(resolveModelInfo).toHaveBeenCalledTimes(2)
  })
})

describe('standingRevTags', () => {
  it('形状：绑定预设 + 全局世界书按序 + 主世界书（库书优先，否则卡内嵌书）', () => {
    expect(state.standingRevTags(makeBinding())).toEqual(['preset:p1=0', 'lore:g1=0', 'charlore:c1=0'])
    expect(state.standingRevTags(makeBinding({ presetId: null, lorebookIds: [], characterLorebookId: 'lib1' }))).toEqual([
      'preset:=0',
      'lore:lib1=0',
    ])
  })

  it('savePreset / deletePreset bump 预设修订号', async () => {
    const preset = { name: '预设', identifier: 'p1', entries: [] } as PromptPreset
    await state.savePreset(preset)
    expect(state.standingRevTags(makeBinding())[0]).toBe('preset:p1=1')
    await state.deletePreset('p1')
    expect(state.standingRevTags(makeBinding())[0]).toBe('preset:p1=2')
  })

  it('saveLorebook / deleteLorebook bump 世界书修订号', async () => {
    await state.saveLorebook('g1', { entries: [] })
    expect(state.standingRevTags(makeBinding())[1]).toBe('lore:g1=1')
    await state.deleteLorebook('g1')
    expect(state.standingRevTags(makeBinding())[1]).toBe('lore:g1=2')
  })

  it('saveCharacterLorebook bump 卡内嵌书修订号', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const binding = makeBinding({ cardId })
    expect(state.standingRevTags(binding)).toContain(`charlore:${cardId}=0`)
    await state.saveCharacterLorebook(cardId, { entries: [{ keys: ['剑'], content: '断剑重铸' }] })
    expect(state.standingRevTags(binding)).toContain(`charlore:${cardId}=1`)
  })
})

describe('workspace cardId 边界', () => {
  it('在创建 WorkspaceFs/WAL 句柄前拒绝点目录与路径穿越', async () => {
    await expect(state.workspace('.')).rejects.toThrow(/非法的角色 ID/)
    await expect(state.workspace('../outside')).rejects.toThrow(/非法的角色 ID/)
    await expect(state.workspace('nested/card')).rejects.toThrow(/非法的角色 ID/)
  })
})

describe('会话副作用队列', () => {
  it('同会话按入队顺序执行，wait 会等待调用时的队尾', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = state.enqueueSessionTask('s1', async () => {
      order.push('begin-1')
      await gate
      order.push('end-1')
    })
    const second = state.enqueueSessionTask('s1', () => {
      order.push('task-2')
    })
    const waited = state.waitForSessionTasks('s1').then(() => order.push('waited'))

    await Promise.resolve()
    expect(order).toEqual(['begin-1'])
    release()
    await Promise.all([first, second, waited])
    expect(order).toEqual(['begin-1', 'end-1', 'task-2', 'waited'])
  })

  it('失败不会阻断同会话后续任务，不同会话可并行', async () => {
    const broken = state.enqueueSessionTask('s1', () => {
      throw new Error('boom')
    })
    const recovered = state.enqueueSessionTask('s1', () => 'ok')
    const other = state.enqueueSessionTask('s2', () => 'parallel')

    await expect(broken).rejects.toThrow('boom')
    await expect(recovered).resolves.toBe('ok')
    await expect(other).resolves.toBe('parallel')
  })
})

describe('compressOldestMemories', () => {
  function mockStreamLlm(text: string) {
    return {
      stream: vi.fn(async function* () {
        yield { type: 'text-delta' as const, text }
      }),
    } as unknown as LlmRuntime
  }

  it('最旧批次合并为一条并归档，索引重建后可检索', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const ws = await state.workspace(cardId)
    await ws.memory.write({ body: '主角在酒馆认识了艾莉丝', tags: ['关系'], keys: ['艾莉丝'] })
    await ws.memory.write({ body: '艾莉丝把断剑交给了铁匠', tags: ['物品'], keys: ['断剑'] })
    await ws.memory.write({ body: '铁匠答应三天后交货', tags: ['约定'], keys: ['铁匠'] })

    const result = await compressOldestMemories(state, mockStreamLlm('艾莉丝委托铁匠重铸断剑，三天后交货'), cardId, 'p', 'm')

    expect(result).toEqual({ merged: '艾莉丝委托铁匠重铸断剑，三天后交货', archived: 3 })
    expect((await ws.memory.stats()).count).toBe(1)
    const hits = await ws.memory.search('断剑', { topK: 5 })
    expect(hits.map((h) => h.entry.body)).toEqual(['艾莉丝委托铁匠重铸断剑，三天后交货'])
    expect(hits[0]!.entry.tags).toContain('compressed')
    expect(hits[0]!.entry.tags).toEqual(expect.arrayContaining(['关系', '物品', '约定']))
    expect(hits[0]!.entry.keys).toEqual(expect.arrayContaining(['艾莉丝', '断剑', '铁匠']))
  })

  it('无模型或缺 provider/model 时不做任何事', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const ws = await state.workspace(cardId)
    await ws.memory.write({ body: '一条记忆' })
    expect(await compressOldestMemories(state, undefined, cardId, 'p', 'm')).toBeNull()
    expect(await compressOldestMemories(state, mockStreamLlm('x'), cardId, undefined, 'm')).toBeNull()
    expect((await ws.memory.stats()).count).toBe(1)
  })

  it('空批次与合并失败返回 null 且不动记忆库', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const ws = await state.workspace(cardId)
    expect(await compressOldestMemories(state, mockStreamLlm('x'), cardId, 'p', 'm')).toBeNull()

    await ws.memory.write({ body: '一条记忆' })
    const broken = {
      stream: vi.fn(async function* (): AsyncGenerator<{ type: 'text-delta'; text: string }> {
        throw new Error('net down')
      }),
    } as unknown as LlmRuntime
    expect(await compressOldestMemories(state, broken, cardId, 'p', 'm')).toBeNull()
    expect((await ws.memory.stats()).count).toBe(1)
  })
})
