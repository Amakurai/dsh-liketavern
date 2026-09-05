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
 * - 人设与全局正则解析缓存（组装热路径每 step 都读）：savePersona/deletePersona/saveRegexRules
 *   bump 后读到新值，文件名净化与修订号键共用一个 id，损坏文件回退空值不抛错；
 * - 卡级正则解析缓存（assets/regex-scripts.json，mtime+size stat 指纹）：rulesFor 命中缓存不重读
 *   文件、绕开写方法的直写经指纹失效、同尺寸覆盖（WAL 回滚）经 invalidateCardRegex 可见、
 *   文件缺失且卡无正则时兜底重编译只跑一次（不收敛不复发）；
 * - loadBinding 自愈的读-改-写竞态：落盘前复读，磁盘已被换卡覆盖则丢弃本次自愈；
 * - workspace：拒绝会把工作区根移出 characters/ 的非法 cardId；
 * - 会话副作用队列：同会话严格串行、不同会话互不阻塞、失败后仍可继续；
 * - compressOldestMemories：idle 期异步压缩——最旧批次合并为一条并归档、
 *   无模型/空批次/合并失败均不动记忆库；先落合并条目再归档——write 失败时批次原样
 *   保留可重试，archive 失败时新旧并存不丢事实（archive 恢复后重试可收敛）；
 * - 面板/服务层写路径（saveJournal/saveCharacter/saveCharacterLorebook/deleteCharacterLorebook/
 *   saveChatLorebook）：turn 进行中（openFloors 有本会话楼层）也不记 WAL，
 *   回退楼层不会把用户编辑改回旧值；turn 内经 withFloor 派生实例的工具写入仍记 WAL（对照）；
 * - plainWorkspace：floor 恒为 null 的工作区句柄；idle 期记忆压缩在同卡楼层开启时也不记 WAL；
 * - assetFileId 冲突检测：不同显示名净化成同一文件 id 时另起 -2 后缀（世界书/预设/人设），
 *   同名再保存与预设/人设改名仍是编辑（不 fork）；
 * - saveRegexRules 逐条结构校验：字段缺失/类型错误的规则抛错不落盘。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { standingFingerprint } from '../src/core/standingPin.js'
import type { CharacterCard, PromptPreset, RegexRule } from '../src/core/types.js'
import { loadBinding, saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { compressOldestMemories } from '../src/node/memoryMaintenance.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { MemoryStore } from '../src/state/memory.js'
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

function makeRegexRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'r1',
    name: '规则一',
    find: 'a',
    replace: 'b',
    enabled: true,
    scopes: ['output'],
    timing: ['render'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: 'user',
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

  it('人设解析缓存：savePersona / deletePersona 后读到新值', async () => {
    await state.savePersona({ id: 'p1', name: '旅人', description: '风尘仆仆', avatar: null })
    expect((await state.loadPersona('p1'))?.name).toBe('旅人')
    // savePersona bump persona:<id> → 缓存失效
    await state.savePersona({ id: 'p1', name: '游侠', description: '换了名字', avatar: null })
    expect((await state.loadPersona('p1'))?.name).toBe('游侠')
    expect((await state.resolvePersona('p1'))?.name).toBe('游侠')
    await state.deletePersona('p1')
    expect(await state.loadPersona('p1')).toBeNull()
  })

  it('人设文件名净化：读写与修订号键共用一个 id', async () => {
    await state.savePersona({ id: '我的 人设', name: '甲', description: '', avatar: null })
    // 落盘 id 被净化，按原始名与净化名都能读到（loadPersona 内部走 assetFileId）
    expect((await state.loadPersona('我的 人设'))?.name).toBe('甲')
    expect((await state.loadPersona('我的_人设'))?.id).toBe('我的_人设')
    await state.savePersona({ id: '我的 人设', name: '乙', description: '', avatar: null })
    expect((await state.loadPersona('我的 人设'))?.name).toBe('乙')
  })

  it('全局正则解析缓存：saveRegexRules 后读到新规则，损坏文件回退空数组', async () => {
    expect(await state.listRegexRules()).toEqual([])
    await state.saveRegexRules([makeRegexRule()])
    expect(await state.listRegexRules()).toHaveLength(1)
    await state.saveRegexRules([])
    expect(await state.listRegexRules()).toEqual([])

    // 绕开写方法把文件写坏：解析失败回退空数组，不抛错打崩组装
    const fsRaw = await import('node:fs/promises')
    await state.saveRegexRules([]) // bump 修订号让缓存失效
    await fsRaw.writeFile(join(root, 'regex', 'rules.json'), '{broken', 'utf8')
    expect(await state.listRegexRules()).toEqual([])
  })

  it('saveRegexRules 逐条结构校验：字段缺失/类型错误的规则抛错不落盘', async () => {
    await state.saveRegexRules([makeRegexRule()])
    // 合法 JSON 但缺 scopes/timing/enabled（旧面板数据形状）：落盘会在渲染/组装时才炸，必须挡在写盘边界
    const legacy = [{ id: 'r2', name: '旧规则', find: 'a', replace: 'b', scopes: [], timings: [], disabled: false } as never]
    await expect(state.saveRegexRules(legacy)).rejects.toThrow(/第 1 条正则规则/)
    await expect(state.saveRegexRules([makeRegexRule({ find: '' })])).rejects.toThrow(/find/)
    await expect(state.saveRegexRules([makeRegexRule({ scopes: ['nope'] as never })])).rejects.toThrow(/scopes/)
    await expect(state.saveRegexRules([makeRegexRule({ timing: ['nope'] as never })])).rejects.toThrow(/timing/)
    await expect(state.saveRegexRules([makeRegexRule({ enabled: 1 as never })])).rejects.toThrow(/enabled/)
    await expect(state.saveRegexRules([makeRegexRule({ substituteRegex: 9 as never })])).rejects.toThrow(/substituteRegex/)
    await expect(state.saveRegexRules([makeRegexRule({ minDepth: '0' as never })])).rejects.toThrow(/minDepth/)
    // 全部失败后旧文件原样保留
    expect(await state.listRegexRules()).toEqual([makeRegexRule()])
  })

  it('卡级正则解析缓存：缓存命中后 rulesFor 不再重读文件', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard({
      regexScripts: [{ scriptName: 's1', findRegex: '/foo/g', replaceString: 'bar', placement: [2] }],
    }))
    const binding = makeBinding({ cardId, presetId: null })
    const first = await state.rulesFor(binding) // 预热缓存
    expect(first.some((r) => r.source === 'card')).toBe(true)

    const ws = await state.workspace(cardId)
    const original = ws.fs.readText.bind(ws.fs)
    let reads = 0
    const spy = vi.spyOn(ws.fs, 'readText').mockImplementation(async (path: string) => {
      if (path === 'assets/regex-scripts.json') reads++
      return original(path)
    })
    const again = await state.rulesFor(binding)
    spy.mockRestore()
    expect(again).toEqual(first)
    expect(reads).toBe(0)
  })

  it('卡级正则缓存：绕开 TavernState 直写文件后指纹失效，读到新值', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard({
      regexScripts: [{ scriptName: 's1', findRegex: '/foo/g', replaceString: 'bar', placement: [2] }],
    }))
    const binding = makeBinding({ cardId, presetId: null })
    expect((await state.rulesFor(binding)).some((r) => r.source === 'card')).toBe(true)

    // 导入路径的 plainFs 直写不走本类写方法，靠 stat 指纹（size 变化）捕获
    const ws = await state.workspace(cardId)
    await ws.fs.writeText('assets/regex-scripts.json', '[]\n')
    expect(await state.rulesFor(binding)).toEqual([])
  })

  it('卡级正则缓存：同尺寸覆盖（模拟 WAL 回滚写回）经 invalidateCardRegex 后可见', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard({
      regexScripts: [{ scriptName: 's1', findRegex: '/foo/g', replaceString: 'bar', placement: [2] }],
    }))
    const binding = makeBinding({ cardId, presetId: null })
    await state.rulesFor(binding) // 预热缓存

    // 等长覆盖：size 不变，mtime 可能落在同一刻度内，指纹兜不住，回滚路径靠手动作废
    const ws = await state.workspace(cardId)
    const raw = (await ws.fs.readText('assets/regex-scripts.json'))!
    await ws.fs.writeText('assets/regex-scripts.json', raw.replace('bar', 'baz'))
    state.invalidateCardRegex(cardId)
    expect((await state.rulesFor(binding)).some((r) => r.replace === 'baz')).toBe(true)
  })

  it('卡级正则缓存：文件缺失且卡无正则时兜底重编译只跑一次（不收敛不复发）', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard()) // regexScripts: []
    // 删掉编译产物模拟旧导入；兜底重编译出 [] 不写回文件
    const ws = await state.workspace(cardId)
    await ws.fs.delete('assets/regex-scripts.json')
    const binding = makeBinding({ cardId, presetId: null })

    const loadSpy = vi.spyOn(state, 'loadCharacter')
    expect(await state.rulesFor(binding)).toEqual([])
    expect(await state.rulesFor(binding)).toEqual([]) // missing 指纹命中缓存，不再读卡重编译
    expect(loadSpy).toHaveBeenCalledTimes(1)
    loadSpy.mockRestore()
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
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
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
    expect(hits.map((h) => h.entry.body)).toEqual(expect.arrayContaining(['艾莉丝委托铁匠重铸断剑，三天后交货', '艾莉丝把断剑交给了铁匠']))
    const summary = hits.find((hit) => !hit.entry.archived)!
    expect(summary.entry.tags).toContain('compressed')
    expect(summary.entry.tags).toEqual(expect.arrayContaining(['关系', '物品', '约定']))
    expect(summary.entry.keys).toEqual(expect.arrayContaining(['艾莉丝', '断剑', '铁匠']))
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

  it('合并条目落盘失败时抛错，批次不归档、可原样重试（不丢事实）', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const ws = await state.workspace(cardId)
    await ws.memory.write({ body: '旧记忆一' })
    await ws.memory.write({ body: '旧记忆二' })

    // 压缩走 plainWorkspace 的独立 MemoryStore 实例，故障注入要打原型
    const spy = vi.spyOn(MemoryStore.prototype, 'write').mockRejectedValue(new Error('disk full'))
    await expect(
      compressOldestMemories(state, mockStreamLlm('合并结果'), cardId, 'p', 'm'),
    ).rejects.toThrow('disk full')
    spy.mockRestore()

    // 批次仍在活跃库、没有被归档，下次压缩原样重试（同刻写入次序不定，排序后比较）
    expect((await ws.memory.oldest(10)).map((e) => e.body).sort()).toEqual(['旧记忆一', '旧记忆二'])
  })

  it('归档失败时合并条目已落盘，新旧并存不丢事实；archive 恢复后重试收敛', async () => {
    const { cardId } = await importCard(join(root, 'characters'), makeCard())
    const ws = await state.workspace(cardId)
    await ws.memory.write({ body: '旧记忆一' })
    await ws.memory.write({ body: '旧记忆二' })

    // 同上：压缩用的是 plainWorkspace 的实例，故障注入打原型
    const spy = vi.spyOn(MemoryStore.prototype, 'archive').mockRejectedValue(new Error('io error'))
    await expect(
      compressOldestMemories(state, mockStreamLlm('合并结果'), cardId, 'p', 'm'),
    ).rejects.toThrow('io error')
    spy.mockRestore()

    // 最坏情形：新（合并条目）旧（批次残余）并存
    expect((await ws.memory.oldest(10)).map((e) => e.body).sort()).toEqual(['合并结果', '旧记忆一', '旧记忆二'])

    // 重试把最旧批次（含上次积压的合并条目）再合并归档一次，收敛为一条，不丢事实
    const retry = await compressOldestMemories(state, mockStreamLlm('再次合并'), cardId, 'p', 'm')
    expect(retry).toEqual({ merged: '再次合并', archived: 3 })
    expect((await ws.memory.stats()).count).toBe(1)
  })
})

describe('面板写路径不记 WAL', () => {
  it('turn 进行中（openFloors 有本会话楼层）面板编辑不写入楼层快照，回退不改回', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    const ws = await state.workspace(cardId)
    // 模拟 onTurnStart：楼层开在 WAL 上，openFloors 记 entry；共享句柄 floor 恒为 null
    await ws.wal.beginFloor('s1#t1')
    state.openFloors.set('s1', { cardId, floor: 's1#t1' })

    await state.saveJournal(cardId, '面板编辑后的日志')
    await state.saveCharacter(cardId, { description: '新描述' })
    await state.saveCharacterLorebook(cardId, { entries: [{ keys: ['剑'], content: '断剑' }] })
    await state.saveChatLorebook(cardId, { entries: { '1': { key: ['门'], content: '门后' } } })
    await state.deleteCharacterLorebook(cardId)

    // 用户编辑照常落盘
    expect(await state.getJournal(cardId)).toBe('面板编辑后的日志')
    // 但 state/wal/ 下没有任何新快照（一旦误记 WAL，record 会 append 出 records.jsonl）
    const walDir = join(root, 'characters', cardId, 'state', 'wal')
    await expect(readFile(join(walDir, 's1_t1', 'records.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // 提交并回滚该楼层：无记录可回放，面板编辑原样保留
    await ws.wal.commitFloor('s1#t1')
    state.openFloors.delete('s1')
    expect(await ws.wal.rollbackFloor('s1#t1', join(root, 'characters', cardId))).toEqual([])
    expect(await state.getJournal(cardId)).toBe('面板编辑后的日志')
  })

  it('对照：turn 内经 withFloor 派生实例的工具写入仍记 WAL', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    const ws = await state.workspace(cardId)
    await ws.wal.beginFloor('s1#t1')
    state.openFloors.set('s1', { cardId, floor: 's1#t1' })
    // 工具写路径（tools.ts resolveCtx）：共享句柄 withFloor 派生实例，快照记进本会话楼层
    const scoped = ws.fs.withFloor(state.openFloors.get('s1')!.floor)
    await scoped.writeText('journal.md', '工具写入')
    await ws.wal.commitFloor('s1#t1')
    const records = await readFile(join(root, 'characters', cardId, 'state', 'wal', 's1_t1', 'records.jsonl'), 'utf8')
    expect(records.trim().split('\n')).toHaveLength(1)
  })

  it('idle 期记忆压缩在同卡楼层开启时也不记 WAL（plainWorkspace，floor 恒 null）', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    // 同卡另一会话正在生成中：楼层已开未提交
    const ws = await state.workspace(cardId)
    await ws.wal.beginFloor('s9#t3')
    state.openFloors.set('s9', { cardId, floor: 's9#t3' })

    const plain = await state.plainWorkspace(cardId)
    expect(plain.fs.currentFloor).toBeNull()
    await plain.memory.write({ body: '旧记忆一' })
    await plain.memory.write({ body: '旧记忆二' })
    const llm = {
      stream: vi.fn(async function* () {
        yield { type: 'text-delta' as const, text: '合并结果' }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      }),
    } as unknown as LlmRuntime
    const result = await compressOldestMemories(state, llm, cardId, 'p', 'm')
    expect(result).toEqual({ merged: '合并结果', archived: 2 })

    // 压缩的写入（合并条目 + 归档 + index.json）全部落在楼层之外
    const walDir = join(root, 'characters', cardId, 'state', 'wal')
    await expect(readFile(join(walDir, 's9_t3', 'records.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    state.openFloors.delete('s9')
    await ws.wal.commitFloor('s9#t3')
  })
})

describe('assetFileId 净化冲突检测', () => {
  it('世界书：不同显示名净化成同一 id 时另起 -2；同名再保存与面板回存仍是编辑', async () => {
    // 「主线 设定」与「主线?设定」都净化成「主线_设定」：后者不得静默覆盖前者
    expect(await state.saveLorebook('主线 设定', { entries: { '1': { key: ['剑'], content: '断剑' } } })).toBe('主线_设定')
    expect(await state.saveLorebook('主线?设定', { entries: { '2': { key: ['门'], content: '门后' } } })).toBe('主线_设定-2')
    expect((await state.listLorebooks()).sort()).toEqual(['主线_设定', '主线_设定-2'])
    // 前者内容原样保留
    expect((await state.loadLorebookEntries('主线_设定', 'global')).map((e) => e.content)).toEqual(['断剑'])
    expect((await state.loadLorebookEntries('主线_设定-2', 'global')).map((e) => e.content)).toEqual(['门后'])

    // 同名再保存 = 编辑：仍落在原 id（首次保存时已把传入名补进文件的 name 字段）
    expect(await state.saveLorebook('主线 设定', { entries: {} })).toBe('主线_设定')
    expect(await state.listLorebooks()).toHaveLength(2)

    // 面板编辑回存：name 传列表给的文件 id，json 带着首次落盘的 name → 同一资产，不 fork
    const json = await state.loadLorebookJson('主线_设定-2')
    expect(await state.saveLorebook('主线_设定-2', json)).toBe('主线_设定-2')
    expect(await state.listLorebooks()).toHaveLength(2)
  })

  it('世界书：无 name 字段的旧文件按文件 id 兜底判身份（面板回存不 fork）', async () => {
    // 模拟本功能之前落盘的无 name 文件
    const fsRaw = await import('node:fs/promises')
    await fsRaw.mkdir(join(root, 'library', 'lorebooks'), { recursive: true })
    await fsRaw.writeFile(join(root, 'library', 'lorebooks', 'legacy_book.json'), JSON.stringify({ entries: {} }), 'utf8')
    // 面板按文件 id 回存：身份兜底为文件 id，判为编辑
    expect(await state.saveLorebook('legacy_book', { entries: { '1': { key: ['x'], content: 'y' } } })).toBe('legacy_book')
    expect(await state.listLorebooks()).toEqual(['legacy_book'])
    // 回存后 name 已补齐，后续按 name 判身份
    expect((await state.loadLorebookJson('legacy_book')) as Record<string, unknown>).toMatchObject({ name: 'legacy_book' })
  })

  it('预设：identifier 净化撞车另起 -2；改名（identifier 不变）是编辑', async () => {
    const preset = { name: '预设甲', identifier: '我的 预设', entries: [] } as PromptPreset
    expect(await state.savePreset(preset)).toBe('我的_预设')
    // 改名不改 identifier：编辑，不 fork（预设身份是 identifier，显示名可改）
    expect(await state.savePreset({ ...preset, name: '预设乙' })).toBe('我的_预设')
    expect((await state.loadPreset('我的_预设'))?.name).toBe('预设乙')
    expect(await state.listPresets()).toEqual(['我的_预设'])
    // 另一个 identifier 净化后撞车：另起 -2，两份都在
    expect(await state.savePreset({ name: '预设丙', identifier: '我的?预设', entries: [] } as PromptPreset)).toBe('我的_预设-2')
    expect((await state.listPresets()).sort()).toEqual(['我的_预设', '我的_预设-2'])
    expect((await state.loadPreset('我的_预设'))?.name).toBe('预设乙')
  })

  it('人设：同 id 改名是编辑（文件内 id 为落盘时改写过的净化 id）', async () => {
    expect(await state.savePersona({ id: '旅人 甲', name: '甲', description: '', avatar: null })).toBe('旅人_甲')
    expect(await state.savePersona({ id: '旅人 甲', name: '甲（改名）', description: '新描述', avatar: null })).toBe('旅人_甲')
    expect((await state.loadPersona('旅人_甲'))?.name).toBe('甲（改名）')
    expect(await state.listPersonas()).toHaveLength(1)
  })
})
