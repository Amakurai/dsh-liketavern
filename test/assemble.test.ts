/**
 * Prompt 组装管线单测。
 * 覆盖：relative 骨架定序、marker 全替换、unknown-marker/unknown-macro 日志、
 * in-chat 深度注入（含同 depth order 升序、depth 0 落位）、世界书 @D role 映射、
 * 卡片 system_prompt/post_history_instructions 落位、预算裁剪（记忆先于历史、
 * 历史裁最旧）、system 输出合并、standing/turnContext 分流（记忆变化不改 standing）、
 * setvar 条目省略 / getvar 代入、{{lastusermessage}} 走 turn 不打穿 standing、
 * 预设 prompt 正则只包最新用户句、常驻世界书进 standing、EJS 脚本跳过注入、
 * 本轮 setvar 不泄漏进 standing getvar、runtime context 快照不当成 lastUserMessage、
 * prompt 正则的纯函数性、历史 {{user}}/{{char}} 展开、第三方预设缺少私有 marker 时的动态层兜底、
 * 世界状态按 keys 触发且不与世界书位置重复注入。
 */
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset, splitExampleMessages, type AssembleInput } from '../src/core/assemble.js'
import {
  EMPTY_TIMER_STATE,
  Marker,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type CharacterCard,
  type ChatMessage,
  type PresetEntry,
  type PromptPreset,
  type RegexRule,
  type WIActivation,
  type WIEngineResult,
  type WorldDelta,
  type WorldInfoEntry,
} from '../src/core/types.js'

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: 'Alice',
    description: 'DESC {{user}}',
    personality: 'PERS',
    scenario: 'SCEN',
    firstMes: 'FIRST',
    alternateGreetings: [],
    mesExample: '<START>\n{{user}}: hi\n{{char}}: hello\n<START>\n{{user}}: bye\n{{char}}: see you',
    systemPrompt: 'SYS {{char}}',
    postHistoryInstructions: 'POST-HIST',
    creatorNotes: '',
    creator: '',
    characterVersion: '',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: null,
    depthPrompt: null,
    ...overrides,
  }
}

function makeWiEntry(partial: Partial<WorldInfoEntry> & { key: string }): WorldInfoEntry {
  return {
    uid: partial.key,
    source: 'global',
    sourceRef: 'book',
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    comment: '',
    content: '',
    constant: false,
    enabled: true,
    order: 100,
    position: WIPosition.BeforeCharDefs,
    depth: 4,
    role: WIRole.System,
    outletName: '',
    probability: 100,
    useProbability: false,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
    ...partial,
  }
}

const act = (entry: WorldInfoEntry): WIActivation => ({ entry, matchedKeys: [], via: 'constant', recursionLevel: 0 })

function wiOf(
  byPosition: Partial<Record<WIPosition, WIActivation[]>>,
  outlets: Record<string, WIActivation[]> = {},
): WIEngineResult {
  return {
    activated: [],
    byPosition,
    outlets,
    log: [],
    budget: { limit: 0, used: 0, overflowed: false },
    timerState: EMPTY_TIMER_STATE,
  }
}

function presetEntry(partial: Partial<PresetEntry> & Pick<PresetEntry, 'identifier'>): PresetEntry {
  return {
    name: partial.identifier,
    enabled: true,
    role: 'system',
    position: 'relative',
    depth: 4,
    order: 100,
    content: '',
    marker: false,
    ...partial,
  }
}

const MAIN_EXPANDED = "Write Alice's next reply in a fictional roleplay between Alice and Bob."
const EXAMPLE_1 = 'Bob: hi\nAlice: hello'
const EXAMPLE_2 = 'Bob: bye\nAlice: see you'

/** 默认输入：defaultPreset（jailbreak 填 'JB'）+ 全字段卡片 + 两条历史。 */
function makeInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  const preset = defaultPreset()
  const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
  if (jb) jb.content = 'JB'
  return {
    preset,
    card: makeCard(),
    personaDescription: 'PERSONA',
    history: [
      { role: 'user', content: 'h0' },
      { role: 'assistant', content: 'h1' },
    ],
    wi: null,
    memories: [],
    worldDeltas: [],
    macroCtx: { char: 'Alice', user: 'Bob' },
    regexRules: [],
    estimateTokens: (t) => t.length,
    budget: { maxTokens: 100000, reserveForOutput: 0 },
    ...overrides,
  }
}

const contents = (msgs: ChatMessage[]): string[] => msgs.map((m) => m.content)

// ---------------------------------------------------------------------------
// 骨架与 marker
// ---------------------------------------------------------------------------

describe('relative 骨架与 marker 替换', () => {
  it('relative 条目按 order 升序落在历史前，jailbreak 落在历史后；marker 全替换', () => {
    const wi = wiOf({
      [WIPosition.BeforeCharDefs]: [act(makeWiEntry({ key: 'wib', content: 'WIB' }))],
      [WIPosition.AfterCharDefs]: [act(makeWiEntry({ key: 'wia', content: 'WIA' }))],
    })
    const deltas: WorldDelta[] = [
      { id: '1', ts: '', type: 'add', ref: null, content: 'DELTA {{char}}', keys: [], order: 100, sourceRange: '', expires: null },
    ]
    const res = assemblePrompt(makeInput({ wi, memories: ['MEM {{user}}'], worldDeltas: deltas }))
    expect(contents(res.messages)).toEqual([
      'SYS Alice', // 卡片 system_prompt 最前
      MAIN_EXPANDED, // main
      'WIB', // worldInfoBefore
      'PERSONA', // personaDescription
      'DESC Bob', // charDescription（宏已展开）
      'PERS', // charPersonality
      'SCEN', // scenario
      'MEM Bob', // agentMemory
      'DELTA Alice', // worldState
      'WIA', // worldInfoAfter
      EXAMPLE_1, // dialogueExamples 两块
      EXAMPLE_2,
      'h0', // chatHistory
      'h1',
      'JB', // chatHistory 之后的 jailbreak
      'POST-HIST', // 卡片 post_history_instructions 尾部
    ])
    // 历史之后没有别的 relative 内容插到 jailbreak 前
    expect(res.messages[0]!.role).toBe('system')
  })

  it('splitExampleMessages 按 <START> 切块并去空白空块', () => {
    expect(splitExampleMessages('<START>\na\n<START>\nb\n')).toEqual(['a', 'b'])
    expect(splitExampleMessages('')).toEqual([])
  })

  it('marker 内容为空时不产生消息（卡片字段留空即跳过）', () => {
    const card = makeCard({ description: '  ', personality: '', scenario: '', mesExample: '', systemPrompt: '', postHistoryInstructions: '' })
    const res = assemblePrompt(makeInput({ card }))
    const cs = contents(res.messages)
    expect(cs).not.toContain('DESC Bob')
    expect(cs).not.toContain('PERS')
    expect(cs).not.toContain('SCEN')
    expect(cs).toEqual([MAIN_EXPANDED, 'PERSONA', 'h0', 'h1', 'JB'])
  })

  it('未知 markerId 记 unknown-marker 日志（relative 与 in-chat 两种）', () => {
    const preset = defaultPreset()
    preset.entries.push(
      presetEntry({ identifier: 'bogus', marker: true, markerId: 'not-a-marker', order: 95 }),
      presetEntry({ identifier: 'bad-in-chat', marker: true, markerId: Marker.ChatHistory, position: 'in-chat', depth: 1 }),
    )
    const res = assemblePrompt(makeInput({ preset }))
    const kinds = res.log.filter((l) => l.kind === 'unknown-marker').map((l) => l.detail)
    expect(kinds).toContain('not-a-marker')
    expect(kinds.some((d) => d.includes('in-chat 位置不支持 marker'))).toBe(true)
  })

  it('未支持宏记 unknown-macro，同一宏多次出现只记一次', () => {
    const preset = defaultPreset()
    preset.entries.push(
      presetEntry({ identifier: 'm1', content: '{{foo}}', order: 95 }),
      presetEntry({ identifier: 'm2', content: '{{foo}} and {{bar}}', order: 96 }),
    )
    const res = assemblePrompt(makeInput({ preset }))
    const macroLogs = res.log.filter((l) => l.kind === 'unknown-macro').map((l) => l.detail)
    expect(macroLogs).toEqual(['{{foo}}', '{{bar}}'])
    // 宏保留原样
    expect(contents(res.messages)).toContain('{{foo}}')
  })

  it('第三方预设缺少私有 marker 时，在 chatHistory 前自动注入记忆与世界状态', () => {
    const preset: PromptPreset = {
      name: 'ST 导入预设',
      identifier: 'st-imported',
      entries: [
        presetEntry({ identifier: 'main', content: 'MAIN', order: 10 }),
        presetEntry({ identifier: 'history', marker: true, markerId: Marker.ChatHistory, order: 20 }),
        presetEntry({ identifier: 'tail', content: 'TAIL', order: 30 }),
      ],
    }
    const delta = { id: 'd1', ts: '', type: 'add' as const, ref: null, content: 'STATE-A', keys: [], order: 100, sourceRange: '', expires: null }
    const res = assemblePrompt(makeInput({ preset, memories: ['MEM-A'], worldDeltas: [delta] }))

    expect(contents(res.messages)).toEqual(['SYS Alice', 'MAIN', 'MEM-A', 'STATE-A', 'h0', 'h1', 'TAIL', 'POST-HIST'])
    expect(res.turnContext).toContain('MEM-A')
    expect(res.turnContext).toContain('STATE-A')
    expect(res.log.filter((entry) => entry.kind === 'auto-marker')).toHaveLength(2)
  })

  it('显式私有 marker 保持权威，不会产生兜底重复注入', () => {
    const res = assemblePrompt(makeInput({ memories: ['ONLY-MEM'] }))
    expect(contents(res.messages).filter((content) => content === 'ONLY-MEM')).toHaveLength(1)
    expect(res.log.some((entry) => entry.kind === 'auto-marker')).toBe(false)
  })

  it('世界状态：无 keys 常驻，有 keys 仅命中后注入，且不在 worldInfo 位置重复', () => {
    const activeDelta: WorldDelta = {
      id: 'd-active', ts: '', type: 'update', ref: 'old', content: '城门已经关闭', keys: ['城门'], order: 100, sourceRange: '', expires: null,
    }
    const inactiveDelta: WorldDelta = {
      id: 'd-inactive', ts: '', type: 'add', ref: null, content: '密室里有宝箱', keys: ['密室'], order: 100, sourceRange: '', expires: null,
    }
    const globalDelta: WorldDelta = {
      id: 'd-global', ts: '', type: 'invalidate', ref: 'old-rule', content: '旧宵禁规则不再有效', keys: [], order: 100, sourceRange: '', expires: null,
    }
    const activeEntry = makeWiEntry({
      key: 'delta:world-delta:d-active',
      uid: activeDelta.id,
      source: 'delta',
      content: '【当前状态·更新】城门已经关闭',
      keys: ['城门'],
      position: WIPosition.AfterCharDefs,
    })
    const activation = { ...act(activeEntry), via: 'keyword' as const }
    const wi = wiOf({ [WIPosition.AfterCharDefs]: [activation] })
    wi.activated = [activation]

    const res = assemblePrompt(makeInput({ wi, worldDeltas: [activeDelta, inactiveDelta, globalDelta] }))
    expect(contents(res.messages).filter((content) => content.includes('城门已经关闭'))).toHaveLength(1)
    expect(res.turnContext).toContain('【当前状态·更新】城门已经关闭')
    expect(res.turnContext).toContain('【当前状态·已失效】旧宵禁规则不再有效')
    expect(res.turnContext).not.toContain('密室里有宝箱')
  })

  it('兜底动态层变化不改变 standing 字节', () => {
    const preset: PromptPreset = {
      name: '无私有 marker',
      identifier: 'plain',
      entries: [
        presetEntry({ identifier: 'main', content: 'MAIN', order: 10 }),
        presetEntry({ identifier: 'history', marker: true, markerId: Marker.ChatHistory, order: 20 }),
      ],
    }
    const a = assemblePrompt(makeInput({ preset, memories: ['MEM-A'] }))
    const b = assemblePrompt(makeInput({ preset, memories: ['MEM-B'] }))
    expect(a.standing).toBe(b.standing)
    expect(a.standing).not.toContain('MEM-A')
    expect(a.turnContext).toContain('MEM-A')
    expect(b.turnContext).toContain('MEM-B')
  })
})

// ---------------------------------------------------------------------------
// 深度注入
// ---------------------------------------------------------------------------

describe('深度注入', () => {
  it('in-chat 条目按 depth 插入（depth 1 = 最后一条之前），同 depth 按 order 升序', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(
      presetEntry({ identifier: 'inj-b', position: 'in-chat', depth: 1, order: 20, content: 'INJ-B' }),
      presetEntry({ identifier: 'inj-a', position: 'in-chat', depth: 1, order: 10, content: 'INJ-A' }),
    )
    const history: ChatMessage[] = [
      { role: 'user', content: 'h0' },
      { role: 'assistant', content: 'h1' },
      { role: 'user', content: 'h2' },
    ]
    const res = assemblePrompt(makeInput({ preset, history }))
    const cs = contents(res.messages)
    const slice = cs.slice(cs.indexOf('h0'), cs.indexOf('JB'))
    expect(slice).toEqual(['h0', 'h1', 'INJ-A', 'INJ-B', 'h2'])
  })

  it('depth 0 落在历史之后，且先于 AN bottom 与 jailbreak（现状语义：tail = depth0 → AN bottom → afterHistory）', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(presetEntry({ identifier: 'inj0', position: 'in-chat', depth: 0, order: 5, content: 'INJ-0' }))
    const wi = wiOf({ [WIPosition.AuthorNoteBottom]: [act(makeWiEntry({ key: 'anb', content: 'ANB' }))] })
    const res = assemblePrompt(makeInput({ preset, wi }))
    const cs = contents(res.messages)
    const tail = cs.slice(cs.indexOf('h1') + 1)
    expect(tail).toEqual(['INJ-0', 'ANB', 'JB', 'POST-HIST'])
  })

  it('AN top 置于历史之前（beforeHistory 末尾）', () => {
    const wi = wiOf({ [WIPosition.AuthorNoteTop]: [act(makeWiEntry({ key: 'ant', content: 'ANT' }))] })
    const res = assemblePrompt(makeInput({ wi }))
    const cs = contents(res.messages)
    expect(cs[cs.indexOf('h0') - 1]).toBe('ANT')
  })

  it('世界书 @D 注入的 role 映射：0→system 1→user 2→assistant', () => {
    const wi = wiOf({
      [WIPosition.AtDepth]: [
        act(makeWiEntry({ key: 'd0', content: 'D-SYS', depth: 1, role: WIRole.System, order: 10 })),
        act(makeWiEntry({ key: 'd1', content: 'D-USER', depth: 1, role: WIRole.User, order: 20 })),
        act(makeWiEntry({ key: 'd2', content: 'D-ASST', depth: 1, role: WIRole.Assistant, order: 30 })),
      ],
    })
    const res = assemblePrompt(makeInput({ wi }))
    const idx = contents(res.messages).indexOf('D-SYS')
    const injected = res.messages.slice(idx, idx + 3)
    expect(injected.map((m) => m.content)).toEqual(['D-SYS', 'D-USER', 'D-ASST'])
    expect(injected.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    // depth 1 = 最后一条历史之前
    expect(contents(res.messages).indexOf('D-SYS')).toBeGreaterThan(contents(res.messages).indexOf('h0'))
    expect(contents(res.messages).indexOf('D-ASST')).toBeLessThan(contents(res.messages).indexOf('h1'))
  })

  it('世界书 @D 宏展开为空时不插入空消息', () => {
    const empty = act(makeWiEntry({ key: 'empty-depth', content: '{{setvar::x::1}}{{trim}}', position: WIPosition.AtDepth }))
    const res = assemblePrompt(makeInput({ wi: wiOf({ [WIPosition.AtDepth]: [empty] }) }))
    expect(res.messages.some((message) => message.content === '')).toBe(false)
  })

  it('outlet 内容经 {{outlet::Name}} 注入并展开', () => {
    const wi = wiOf({}, { stats: [act(makeWiEntry({ key: 'o', content: 'HP 10 {{char}}' }))] })
    const preset = defaultPreset()
    preset.entries.push(presetEntry({ identifier: 'panel', content: '面板:{{outlet::stats}}/{{outlet::missing}}', order: 95 }))
    const res = assemblePrompt(makeInput({ preset, wi }))
    expect(contents(res.messages)).toContain('面板:HP 10 Alice/')
  })
})

// ---------------------------------------------------------------------------
// 预算裁剪
// ---------------------------------------------------------------------------

describe('预算裁剪', () => {
  const budgetPreset: PromptPreset = {
    name: 't',
    identifier: 't',
    entries: [
      presetEntry({ identifier: 'main', content: 'X', order: 10 }), // 1 token
      presetEntry({ identifier: 'mem', marker: true, markerId: Marker.AgentMemory, order: 15 }),
      presetEntry({ identifier: 'hist', marker: true, markerId: Marker.ChatHistory, order: 20 }),
    ],
  }
  const pad = (s: string) => s + 'x'.repeat(10 - s.length) // 每条历史 10 tokens
  const history: ChatMessage[] = [
    { role: 'user', content: pad('h0') },
    { role: 'assistant', content: pad('h1') },
    { role: 'user', content: pad('h2') },
    { role: 'assistant', content: pad('h3') },
    { role: 'user', content: pad('h4') },
  ]
  const memory = 'M'.repeat(30) // 30 tokens

  it('记忆先于历史被裁；历史从最旧开始裁且保留最新用户消息；trimmedSections 记录', () => {
    // tokensBefore = 1(main) + 30(mem) + 50(history) = 81；预算 31
    const res = assemblePrompt(
      makeInput({ preset: budgetPreset, card: null, personaDescription: '', memories: [memory], history, budget: { maxTokens: 31, reserveForOutput: 0 } }),
    )
    expect(res.stats.tokensBefore).toBe(81)
    expect(res.stats.trimmedSections).toEqual(['agentMemory', 'history', 'history'])
    expect(contents(res.messages)).not.toContain(memory)
    // 最旧两条被裁，最新用户消息保留
    expect(contents(res.history)).toEqual([pad('h2'), pad('h3'), pad('h4')])
    expect(res.stats.tokensAfter).toBe(31)
    expect(res.log.filter((l) => l.kind === 'trim')).toHaveLength(3)
  })

  it('reserveForOutput 计入预算扣减', () => {
    const res = assemblePrompt(
      makeInput({ preset: budgetPreset, card: null, personaDescription: '', memories: [], history, budget: { maxTokens: 51, reserveForOutput: 10 } }),
    )
    // 可用 41：1 + 50 = 51 → 裁一条最旧历史
    expect(res.stats.trimmedSections).toEqual(['history'])
    expect(contents(res.history)).toEqual([pad('h1'), pad('h2'), pad('h3'), pad('h4')])
  })

  it('动态层之后依次裁示例、角色定义，最后才裁历史', () => {
    const preset: PromptPreset = {
      name: 'trim-order',
      identifier: 'trim-order',
      entries: [
        presetEntry({ identifier: 'desc', marker: true, markerId: Marker.CharDescription, order: 10 }),
        presetEntry({ identifier: 'examples', marker: true, markerId: Marker.DialogueExamples, order: 20 }),
        presetEntry({ identifier: 'history', marker: true, markerId: Marker.ChatHistory, order: 30 }),
      ],
    }
    const card = makeCard({
      description: 'D'.repeat(10),
      personality: '',
      scenario: '',
      mesExample: `<START>${'E'.repeat(10)}`,
      systemPrompt: '',
      postHistoryInstructions: '',
    })
    const history = [
      { role: 'user' as const, content: 'U'.repeat(10) },
      { role: 'assistant' as const, content: 'A'.repeat(10) },
    ]
    const res = assemblePrompt(makeInput({
      preset,
      card,
      personaDescription: '',
      history,
      budget: { maxTokens: 20, reserveForOutput: 0 },
    }))
    expect(res.stats.trimmedSections).toEqual(['dialogueExamples', 'characterDefinitions'])
    expect(contents(res.history)).toEqual(history.map((message) => message.content))
  })
})

// ---------------------------------------------------------------------------
// system 输出与纯函数性
// ---------------------------------------------------------------------------

describe('system 输出', () => {
  it('历史前内容与尾部注入并入 system 且不为空，历史不进入 system', () => {
    const res = assemblePrompt(makeInput())
    expect(res.system.length).toBeGreaterThan(0)
    expect(res.system).toContain('SYS Alice')
    expect(res.system).toContain(MAIN_EXPANDED)
    expect(res.system).toContain('JB')
    expect(res.system).toContain('POST-HIST')
    expect(res.system).not.toContain('h0')
  })

  it('standing 不含世界书/记忆；只改记忆时 standing 字节级不变', () => {
    const wi = wiOf({
      [WIPosition.BeforeCharDefs]: [act(makeWiEntry({ key: 'wib', content: 'WIB' }))],
    })
    const a = assemblePrompt(makeInput({ wi, memories: ['MEM-A'] }))
    const b = assemblePrompt(makeInput({ wi, memories: ['MEM-B'] }))
    expect(a.standing).toBe(b.standing)
    expect(a.standing).toContain(MAIN_EXPANDED)
    expect(a.standing).toContain('SYS Alice')
    expect(a.standing).not.toContain('WIB')
    expect(a.standing).not.toContain('MEM-A')
    expect(a.turnContext).toContain('WIB')
    expect(a.turnContext).toContain('MEM-A')
    expect(b.turnContext).toContain('MEM-B')
    expect(a.system).toContain('WIB')
  })

  it('setvar 条目展开后不进骨架，getvar 处变成真正规则', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(
      presetEntry({ identifier: 'set-words', content: '{{setvar::wordsCloud::不少于1500}}{{trim}}', order: 5 }),
      presetEntry({ identifier: 'use-words', content: '剧情{{getvar::wordsCloud}}字', order: 6 }),
    )
    const res = assemblePrompt(makeInput({ preset }))
    expect(res.standing).toContain('剧情不少于1500字')
    expect(res.standing).not.toContain('setvar')
    expect(res.standing).not.toContain('getvar')
    expect(contents(res.messages)).not.toContain('')
  })

  it('{{lastusermessage}} 进 turnContext；只改用户句时 standing 不变', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(
      presetEntry({
        identifier: 'wrap-user',
        position: 'in-chat',
        depth: 0,
        order: 1,
        content: '<最新互动>\n{{lastusermessage}}\n</最新互动>',
      }),
    )
    const a = assemblePrompt(makeInput({ preset, history: [{ role: 'user', content: '你好' }] }))
    const b = assemblePrompt(makeInput({ preset, history: [{ role: 'user', content: '换一句' }] }))
    expect(a.standing).toBe(b.standing)
    expect(a.standing).not.toContain('你好')
    expect(a.turnContext).toContain('<最新互动>\n你好\n</最新互动>')
    expect(b.turnContext).toContain('<最新互动>\n换一句\n</最新互动>')
  })

  it('世界书常驻进 standing；关键词命中进 turn；EJS 脚本不注入', () => {
    const constant = act(makeWiEntry({ key: 'const', content: 'CONST-LORE', constant: true }))
    const script = act(makeWiEntry({
      key: 'ejs',
      content: '<%_ const s = getvar("stat_data"); _%>\n<beginners_guide>NO</beginners_guide>',
      constant: true,
    }))
    const hitA = { ...act(makeWiEntry({ key: 'hit', content: 'HIT-A', constant: false })), via: 'keyword' as const }
    const hitB = { ...act(makeWiEntry({ key: 'hit', content: 'HIT-B', constant: false })), via: 'keyword' as const }
    const a = assemblePrompt(makeInput({ wi: wiOf({ [WIPosition.BeforeCharDefs]: [constant, script, hitA] }) }))
    const b = assemblePrompt(makeInput({ wi: wiOf({ [WIPosition.BeforeCharDefs]: [constant, script, hitB] }) }))
    expect(a.standing).toBe(b.standing)
    expect(a.standing).toContain('CONST-LORE')
    expect(a.standing).not.toContain('HIT-A')
    expect(a.standing).not.toContain('beginners_guide')
    expect(a.standing).not.toContain('<%')
    expect(a.turnContext).toContain('HIT-A')
    expect(b.turnContext).toContain('HIT-B')
    expect(a.turnContext).not.toContain('CONST-LORE')
    expect(a.turnContext).toContain('已跳过')
    expect(a.log.some((l) => l.kind === 'dropped-script')).toBe(true)
  })

  it('本轮 setvar 不泄漏进 standing 的 getvar', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB-{{getvar::leak}}'
    preset.entries.push(
      presetEntry({ identifier: 'set-leak', content: '{{setvar::leak::{{lastusermessage}}}}{{trim}}', order: 5 }),
    )
    const a = assemblePrompt(makeInput({ preset, history: [{ role: 'user', content: '你好' }] }))
    const b = assemblePrompt(makeInput({ preset, history: [{ role: 'user', content: '换一句' }] }))
    expect(a.standing).toBe(b.standing)
    expect(a.standing).toContain('JB-')
    expect(a.standing).not.toContain('你好')
    expect(a.standing).not.toContain('换一句')
  })

  it('runtime context 快照不当成 {{lastusermessage}}', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(
      presetEntry({
        identifier: 'wrap-user',
        position: 'in-chat',
        depth: 0,
        order: 1,
        content: '<最新互动>\n{{lastusermessage}}\n</最新互动>',
      }),
    )
    const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nWIB'
    const res = assemblePrompt(
      makeInput({
        preset,
        history: [
          { role: 'user', content: '真用户' },
          { role: 'user', content: snapshot },
        ],
      }),
    )
    expect(res.turnContext).toContain('<最新互动>\n真用户\n</最新互动>')
    expect(res.turnContext).not.toContain('WIB')
    expect(res.standing).not.toContain('真用户')
    expect(res.standing).not.toContain('Current runtime context')
  })

  it('同轮写入确认不当成 {{lastusermessage}}', () => {
    const preset = defaultPreset()
    const jb = preset.entries.find((e) => e.identifier === 'jailbreak')
    if (jb) jb.content = 'JB'
    preset.entries.push(
      presetEntry({
        identifier: 'wrap-user',
        position: 'in-chat',
        depth: 0,
        order: 1,
        content: '<最新互动>\n{{lastusermessage}}\n</最新互动>',
      }),
    )
    const res = assemblePrompt(
      makeInput({
        preset,
        history: [
          { role: 'user', content: '真用户' },
          { role: 'user', content: '【Tavern 同轮写入】记忆 id=abc 已落盘。' },
        ],
      }),
    )
    expect(res.turnContext).toContain('<最新互动>\n真用户\n</最新互动>')
    expect(res.turnContext).not.toContain('同轮写入')
  })
})

describe('历史身份宏', () => {
  it('开场白里的 {{user}}/{{char}} 展开后再入模', () => {
    const res = assemblePrompt(
      makeInput({
        history: [{ role: 'assistant', content: '我想你了，{{user}}。我是{{char}}。' }],
      }),
    )
    expect(res.history.map((m) => m.content)).toEqual(['我想你了，Bob。我是Alice。'])
  })
})

describe('prompt 作用域正则', () => {
  const rule: RegexRule = {
    id: 'r1',
    name: 'r1',
    find: '/o/g',
    replace: '0',
    enabled: true,
    scopes: ['prompt'],
    timing: ['assemble'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 1,
    source: 'user',
  }

  it('作用于历史副本，输入数组不变（纯函数性）', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'foo' }]
    const res = assemblePrompt(makeInput({ history, regexRules: [rule] }))
    expect(contents(res.history)).toEqual(['f00'])
    expect(history[0]!.content).toBe('foo') // 输入不被改写
    expect(history).toHaveLength(1)
  })

  it('规则编译失败记入 regex-error 日志且不中断组装', () => {
    const bad: RegexRule = { ...rule, id: 'bad', find: '/(unclosed/gi' }
    const res = assemblePrompt(makeInput({ regexRules: [bad] }))
    // 默认输入有两条历史消息，规则对每条各失败一次
    const errors = res.log.filter((l) => l.kind === 'regex-error').map((l) => l.detail)
    expect(errors).toHaveLength(2)
    expect(errors.every((d) => d.startsWith('bad:'))).toBe(true)
    expect(res.messages.length).toBeGreaterThan(0)
  })

  it('非 prompt/assemble 组合点的规则不作用于历史', () => {
    const off: RegexRule = { ...rule, scopes: ['output'], timing: ['render'] }
    const res = assemblePrompt(makeInput({ history: [{ role: 'user', content: 'foo' }], regexRules: [off] }))
    expect(contents(res.history)).toEqual(['foo'])
  })

  it('预设包裹正则只改最新用户句，不改 standing 与 assistant', () => {
    const wrap: RegexRule = {
      id: 'wrap',
      name: '包裹最新指示',
      find: '^([\\s\\S]*)$',
      replace: '<最新互动>\n$1\n</最新互动>',
      enabled: true,
      scopes: ['prompt'],
      timing: ['assemble'],
      minDepth: null,
      maxDepth: 1,
      substituteRegex: 0,
      source: 'preset',
      roles: ['user'],
    }
    const history: ChatMessage[] = [
      { role: 'user', content: '旧的' },
      { role: 'assistant', content: '回' },
      { role: 'user', content: '新的' },
    ]
    const a = assemblePrompt(makeInput({ history, regexRules: [wrap] }))
    expect(contents(a.history)).toEqual(['旧的', '回', '<最新互动>\n新的\n</最新互动>'])
    const next: ChatMessage[] = [...history, { role: 'assistant', content: '又回' }, { role: 'user', content: '下一句' }]
    const b = assemblePrompt(makeInput({ history: next, regexRules: [wrap] }))
    expect(a.standing).toBe(b.standing)
    expect(contents(b.history)).toEqual(['旧的', '回', '新的', '又回', '<最新互动>\n下一句\n</最新互动>'])
  })
})

describe('depth_prompt / 作者注释 / 角色笔记', () => {
  it('depth_prompt 预览插历史且并入 turnContext，不进 standing', () => {
    const card = makeCard({ depthPrompt: { prompt: 'DP-{{char}}', depth: 1, role: 'system' } })
    const res = assemblePrompt(makeInput({ card }))
    expect(contents(res.messages)).toContain('DP-Alice')
    expect(res.turnContext).toContain('DP-Alice')
    expect(res.standing).not.toContain('DP-Alice')
  })

  it('会话作者注释与角色笔记进 turn 不进 standing', () => {
    const res = assemblePrompt(makeInput({ authorNote: 'AN-{{user}}', journalText: 'J-note' }))
    expect(res.turnContext).toContain('【作者注释】AN-Bob')
    expect(res.turnContext).toContain('【角色笔记】J-note')
    expect(res.standing).not.toContain('作者注释')
    expect(res.standing).not.toContain('角色笔记')
  })
})
