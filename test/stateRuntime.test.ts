/**
 * TavernState 运行时辅助测试（真实临时目录）。
 * 覆盖：
 * - resolveModelInfoCached：同 provider+model 复用一次解析、不同模型各自解析、失败不缓存；
 * - standingRevTags：绑定 → 修订标记形状；savePreset/deletePreset/saveLorebook/deleteLorebook/
 *   saveCharacterLorebook 等写方法 bump 对应修订号（standing 指纹随资产内容失效重算）；
 *   末尾 config 标记只随真正决定 standing 字节的键变化（characterStrategy / useGroupScoring /
 *   sampling.maxTokens），只影响 turn 层的键（tokenBudget / scanDepth 等）不动它；
 * - peekStanding：组装失败兜底只读同卡同场景的钉位，异卡/异场景/异会话一律不命中；
 * - 库资产文件名净化：写盘 id、删除路径与修订号键共用一个 id（原始名带空格也能失效钉死）；
 * - 库资产解析缓存（rev-keyed）：写方法 bump 后读到新值，损坏的预设文件回退 null 不抛错；
 * - loadBinding 自愈的读-改-写竞态：落盘前复读，磁盘已被换卡覆盖则丢弃本次自愈；
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
import { standingFingerprint } from '../src/core/standingPin.js'
import type { CharacterCard, PromptPreset } from '../src/core/types.js'
import { loadBinding, saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { compressOldestMemories } from '../src/node/memoryMaintenance.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { importCard } from '../src/state/workspace.js'

let root: string
let paths: TavernPaths
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'state-runtime-test-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
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
    depthPrompt: null,
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
  /** 资产标记（末尾 config 标记单独断言）。 */
  const assetTags = (tags: string[]) => tags.slice(0, -1)
  const configTag = (tags: string[]) => tags[tags.length - 1]

  it('形状：绑定预设 + 全局世界书按序 + 主世界书 + 卡修订 + 会话世界书 + config', () => {
    const tags = state.standingRevTags(makeBinding())
    expect(assetTags(tags)).toEqual(['preset:p1=0', 'lore:g1=0', 'charlore:c1=0', 'card:c1=0', 'chatlore:c1=0'])
    expect(configTag(tags)).toMatch(/^config=[0-9a-f]{8}$/)
    expect(
      assetTags(state.standingRevTags(makeBinding({ presetId: null, lorebookIds: [], characterLorebookId: 'lib1' }))),
    ).toEqual(['preset:=0', 'lore:lib1=0', 'card:c1=0', 'chatlore:c1=0'])
    expect(state.standingRevTags(makeBinding(), { personaLorebookId: 'pbook' })).toContain('lore:pbook=0')
  })

  it('设置进指纹：只有决定 standing 字节的键变则 config 标记变，turn 层键不变', () => {
    let raw: Record<string, unknown> = {}
    const live = new TavernState(paths, () => resolveConfig(raw))
    const base = configTag(live.standingRevTags(makeBinding()))

    // characterStrategy 决定多来源条目（含 standing 侧常驻）的落位顺序，必须打穿钉死
    raw = { worldInfo: { characterStrategy: 2 } }
    expect(configTag(live.standingRevTags(makeBinding()))).not.toBe(base)

    // useGroupScoring 决定 inclusion group 里哪条常驻条目胜出，同样必须打穿
    raw = { worldInfo: { useGroupScoring: true } }
    expect(configTag(live.standingRevTags(makeBinding()))).not.toBe(base)

    // maxTokens 决定 trimNonHistory 的裁剪线，同样必须打穿
    raw = { sampling: { maxTokens: 4096 } }
    expect(configTag(live.standingRevTags(makeBinding()))).not.toBe(base)

    // tokenBudget / scanDepth 只影响 turn 层触发与计费，不能白白打断 KV 前缀缓存
    raw = { worldInfo: { tokenBudget: 999, scanDepth: 8 } }
    expect(configTag(live.standingRevTags(makeBinding()))).toBe(base)

    // 与 standing 无关的键也不能打穿
    raw = { interactiveCards: false, triggerLogMax: 50 }
    expect(configTag(live.standingRevTags(makeBinding()))).toBe(base)
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

  it('文件名净化：写盘 id、修订号键与删除路径一致，绑定持净化名也能失效钉死', async () => {
    const binding = makeBinding({ lorebookIds: ['主线_设定'] })
    expect(state.standingRevTags(binding)[1]).toBe('lore:主线_设定=0')

    // 服务层要拿到净化后的 id，客户端打开的目标才和磁盘一致
    expect(await state.saveLorebook('主线 设定', { entries: [] })).toBe('主线_设定')
    expect(await state.listLorebooks()).toEqual(['主线_设定'])
    expect(state.standingRevTags(binding)[1]).toBe('lore:主线_设定=1')

    // 按原始名删除也要命中净化后的那个文件
    await state.deleteLorebook('主线 设定')
    expect(await state.listLorebooks()).toEqual([])
    expect(state.standingRevTags(binding)[1]).toBe('lore:主线_设定=2')
  })

  it('预设 identifier 净化后同样对得上（保存 → 读取 → 修订号）', async () => {
    const preset = { name: '预设', identifier: '我的 预设', entries: [] } as PromptPreset
    expect(await state.savePreset(preset)).toBe('我的_预设')
    expect(await state.listPresets()).toEqual(['我的_预设'])
    // 原始名与净化名都能读到同一份，修订号键也是同一个
    expect((await state.loadPreset('我的 预设'))?.name).toBe('预设')
    expect((await state.loadPreset('我的_预设'))?.name).toBe('预设')
    expect(state.standingRevTags(makeBinding({ presetId: '我的 预设' }))[0]).toBe('preset:我的_预设=1')
  })

  it('库资产解析缓存：写方法后读到新值，绕开写方法的损坏文件不返回旧值以外的东西', async () => {
    const preset = { name: 'v1', identifier: 'cache-test', entries: [] } as PromptPreset
    await state.savePreset(preset)
    expect((await state.loadPreset('cache-test'))?.name).toBe('v1')
    // savePreset bump 修订号 → 缓存失效，读到新值
    await state.savePreset({ ...preset, name: 'v2' })
    expect((await state.loadPreset('cache-test'))?.name).toBe('v2')

    // 损坏的预设文件：loadPreset 回退 null（调用方落到默认预设），而不是抛错打崩组装管线
    const fsRaw = await import('node:fs/promises')
    await fsRaw.writeFile(join(root, 'library', 'presets', 'broken.json'), '{broken', 'utf8')
    expect(await state.loadPreset('broken')).toBeNull()
  })

  it('角色卡解析缓存：saveCharacter / saveCharacterLorebook 后读到新内容', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    expect((await state.loadCharacter(cardId))?.card.description).toBe('描述')
    await state.saveCharacter(cardId, { description: '新描述' })
    expect((await state.loadCharacter(cardId))?.card.description).toBe('新描述')
    await state.saveCharacterLorebook(cardId, { entries: [{ keys: ['剑'], content: '断剑' }] })
    const card = (await state.loadCharacter(cardId))?.card
    expect(card?.characterBook?.entries).toHaveLength(1)
    expect(card?.description).toBe('新描述')
  })

  it('saveCharacterLorebook bump 卡内嵌书修订号', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const binding = makeBinding({ cardId })
    expect(state.standingRevTags(binding)).toContain(`charlore:${cardId}=0`)
    await state.saveCharacterLorebook(cardId, { entries: [{ keys: ['剑'], content: '断剑重铸' }] })
    expect(state.standingRevTags(binding)).toContain(`charlore:${cardId}=1`)
  })

  it('saveCharacter / saveChatLorebook bump 卡与会话世界书修订号', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const binding = makeBinding({ cardId })
    expect(state.standingRevTags(binding)).toContain(`card:${cardId}=0`)
    expect(state.standingRevTags(binding)).toContain(`chatlore:${cardId}=0`)
    await state.saveCharacter(cardId, { description: '新描述' })
    expect(state.standingRevTags(binding)).toContain(`card:${cardId}=1`)
    await state.saveChatLorebook(cardId, { entries: { '1': { key: ['门'], content: '门后' } } })
    expect(state.standingRevTags(binding)).toContain(`chatlore:${cardId}=1`)
  })
})

describe('peekStanding', () => {
  it('组装失败兜底：只读同卡同场景的钉位，异卡/异场景/异会话一律不命中', () => {
    // 指纹第三段是 cardId（standingFingerprint 布局）；makeBinding 默认 cardId 'c1'
    const fp = standingFingerprint(makeBinding())
    state.pinStanding('s1', 'normal', fp, 'BYTES')
    expect(state.peekStanding('s1', 'normal', 'c1')).toBe('BYTES')
    expect(state.peekStanding('s1', 'normal', 'c2')).toBeUndefined()
    expect(state.peekStanding('s1', 'continue', 'c1')).toBeUndefined()
    expect(state.peekStanding('s2', 'normal', 'c1')).toBeUndefined()
    // 没钉过的会话直接 undefined
    expect(state.peekStanding('s9', 'normal', 'c1')).toBeUndefined()
  })
})

describe('loadBinding 自愈', () => {
  it('磁盘未变时按名字接回新工作区并落盘', async () => {
    const a = await importCard(paths.characters, makeCard({ name: '甲' }))
    await saveBinding(paths, makeBinding({ cardId: 'gone', cardName: '甲' }))

    expect((await state.loadBinding('s1'))?.cardId).toBe(a.cardId)
    expect((await loadBinding(paths, 's1'))?.cardId).toBe(a.cardId)
  })

  it('自愈期间用户换了卡：复读发现磁盘已变，丢弃本次自愈不覆盖', async () => {
    const a = await importCard(paths.characters, makeCard({ name: '甲' }))
    const b = await importCard(paths.characters, makeCard({ name: '乙' }))
    await saveBinding(paths, makeBinding({ cardId: 'gone', cardName: '甲' }))

    // loadBinding 是热路径读，不走 enqueueSessionTask：在它 await 期间模拟用户改绑到乙
    const spy = vi.spyOn(state, 'listCharacters').mockImplementation(async () => {
      spy.mockRestore()
      await saveBinding(paths, makeBinding({ cardId: b.cardId, cardName: '乙' }))
      return state.listCharacters()
    })

    // 本次调用仍返回自己算出的结果（调用方拿到的是它读到的那份的自愈值）
    expect((await state.loadBinding('s1'))?.cardId).toBe(a.cardId)
    // 但磁盘上用户刚选的乙没有被悄悄覆盖回甲
    expect((await loadBinding(paths, 's1'))?.cardId).toBe(b.cardId)
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
