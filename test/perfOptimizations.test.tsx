/**
 * 性能与交互优化回归：验证增量 JSON token 计量与裁剪、BM25 权重缓存纪元、世界书扩深短路、
 * MVU 命令 UTF-8 字节计数、记忆批量归并与回滚展开、服务端展示正则合批与单项故障隔离，
 * 以及客户端共享窗口事件分发、无头像跳过、角色分页与设置子组惰性加载的业务等价性。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assetOutputTokens,
  budgetAssetFiles,
  budgetAssetIndex,
  budgetPresetCatalog,
  clipAssetJsonText,
} from '../src/core/assetRead.js'
import { Bm25Index } from '../src/core/bm25.js'
import { hideIncompleteHtml, presentRenderedOutput } from '../src/core/displaySanitize.js'
import { createHelperMvuCommandCodec } from '../src/core/helperMvuCommands.js'
import { helperJson } from '../src/core/helperRuntime.js'
import { budgetLoreCatalog, clipLoreContents } from '../src/core/loreQuery.js'
import { markdownCodeScanner } from '../src/core/markdownCode.js'
import { countJsonStringTokenChars, countTokenChars, estimateTokens } from '../src/core/tokenize.js'
import {
  DEFAULT_WI_SETTINGS,
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type PromptPreset,
  type WorldInfoEntry,
  type WorldInfoGlobalSettings,
} from '../src/core/types.js'
import { evaluateWorldInfo } from '../src/core/worldbook.js'
import { TavernConfigSchema, resolveConfig, type TavernConfigRaw, type TavernSettingsScope } from '../src/node/config.js'
import { disposeIdleComputeWorkers } from '../src/node/isolated.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { expandAffectedMemories } from '../src/state/memoryRollback.js'
import { MemoryStore } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import type { CharacterSummary, TavernRemote } from '../src/client/types.js'
import { Btn, Tabs } from '../src/client/util.js'
import { subscribeKeyedWindowEvent } from '../src/client/windowEvents.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>
  ),
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div>{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
}))

const mounted: ReactTestRenderer[] = []
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  await disposeIdleComputeWorkers()
})

function makeLoreEntry(overrides: Partial<WorldInfoEntry> & Pick<WorldInfoEntry, 'uid'>): WorldInfoEntry {
  const source = overrides.source ?? 'character'
  const sourceRef = overrides.sourceRef ?? 'test-book'
  return {
    key: `${source}:${sourceRef}:${overrides.uid}`,
    comment: overrides.uid,
    source,
    sourceRef,
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    content: `内容:${overrides.uid}`,
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
    useGroupScoring: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: true,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
    ...overrides,
  }
}

describe('JSON 字符串 token 增量统计与预算裁剪', () => {
  it('countJsonStringTokenChars 与 JSON.stringify 真实序列化字符分类完全一致（含控制字符、代理对与孤立代理项）', () => {
    const samples = [
      '',
      'plain ascii 12345',
      '中文与标点：，。！？「」【】',
      'quotes " and slash \\ and controls \b\t\n\f\r\u0000\u001f',
      'emoji 🎭🚀𠀀 mixed 中文',
      'lone-high-\ud800-end',
      'lone-low-\udc00-middle',
      'reversed-\udc00\ud800-pair-\ud83d\ude80',
    ]
    for (const sample of samples) {
      expect(countJsonStringTokenChars(sample)).toEqual(countTokenChars(JSON.stringify(sample)))
    }
  })

  it('clipAssetJsonText 在不同预算下不超出上限且不截出半个代理对', () => {
    const text = '序章🎭'.repeat(120) + '\n"转义"\t结尾'
    const full = clipAssetJsonText(text, assetOutputTokens(text))
    expect(full).toEqual({ text, truncated: false, tokens: estimateTokens(text) })

    for (const budget of [1, 2, 5, 9, 10, 11, 99, 100, 101, 250]) {
      const clipped = clipAssetJsonText(text, budget)
      expect(clipped.tokens).toBe(estimateTokens(clipped.text))
      expect(assetOutputTokens(clipped.text)).toBeLessThanOrEqual(budget)
      expect(text.startsWith(clipped.text.replace(/…（已截断）$/, ''))).toBe(true)
      if (clipped.text.length > 0) {
        const tailCode = clipped.text.charCodeAt(clipped.text.length - 1)
        expect(tailCode >= 0xd800 && tailCode <= 0xdbff).toBe(false)
      }
    }
  })

  it('资产目录与世界书检索预算在位数跳变与超大中间项跳过时与完整 JSON token 精确对齐', () => {
    const preset: PromptPreset = {
      identifier: 'preset-main',
      name: '测试预设',
      entries: [
        { identifier: 'small-a', name: '短条目甲', enabled: true, role: 'system', position: 'relative', depth: 0, order: 10, content: '短正文甲', marker: false },
        { identifier: 'huge-' + 'x'.repeat(240), name: '超长标识条目', enabled: true, role: 'user', position: 'in-chat', depth: 2, order: 20, content: '长正文'.repeat(50), marker: false },
        { identifier: 'small-b', name: '短条目乙🎭', enabled: true, role: 'assistant', position: 'relative', depth: 0, order: 30, content: '', marker: true, markerId: 'chatHistory' },
      ],
    }
    for (const budget of [90, 99, 100, 101, 140, 200, 1000]) {
      const res = budgetPresetCatalog(preset, budget)
      expect(res.tokensUsed).toBe(assetOutputTokens({ preset: res }))
      expect(res.tokensUsed).toBeLessThanOrEqual(budget)
    }
    const skippedMid = budgetPresetCatalog(preset, 240)
    expect(skippedMid.truncated).toBe(true)
    expect(skippedMid.entries.map((item) => item.identifier)).toEqual(['small-a', 'small-b'])

    const filePaths = Array.from({ length: 24 }, (_, i) => `assets/chapter-${i}.md`)
    for (const budget of [65, 99, 100, 105, 220]) {
      const res = budgetAssetFiles(filePaths, budget)
      expect(res.tokensUsed).toBe(
        assetOutputTokens({
          files: res.files,
          fileCount: res.count,
          filesOmitted: res.omitted,
          filesTruncated: res.truncated,
          filesTokensUsed: res.tokensUsed,
        }),
      )
      expect(res.tokensUsed).toBeLessThanOrEqual(budget)
    }

    const indexSource = {
      updatedAt: '2026-01-02T03:04:05Z',
      files: filePaths.slice(0, 10).map((path, i) => ({
        path,
        summary: `章节摘要 ${i} "引号" 与中文说明`,
        tokens: 30 + i,
      })),
    }
    for (const budget of [95, 100, 150, 320]) {
      const res = budgetAssetIndex(indexSource, filePaths, budget)
      expect(res).not.toBeNull()
      expect(res!.tokensUsed).toBe(assetOutputTokens({ index: res }))
      expect(res!.tokensUsed).toBeLessThanOrEqual(budget)
    }

    const loreEntries: WorldInfoEntry[] = [
      makeLoreEntry({
        uid: 'lore-1',
        comment: '灯塔守则',
        keys: ['灯塔', '守夜'],
        content: '守夜人每晚整点巡视灯室。\n'.repeat(30),
      }),
      makeLoreEntry({
        uid: 'lore-2',
        source: 'global',
        comment: '雾笛信号',
        keys: ['雾笛', ...Array.from({ length: 30 }, (_, i) => `扩展触发词_${i}`)],
        content: '两长一短代表风暴逼近。\n'.repeat(25),
        order: 90,
      }),
    ]
    for (const budget of [95, 100, 150, 260, 800]) {
      const cat = budgetLoreCatalog(loreEntries, budget)
      expect(cat.tokensUsed).toBe(assetOutputTokens(cat))
      expect(cat.tokensUsed).toBeLessThanOrEqual(budget)

      const read = clipLoreContents(loreEntries, budget)
      expect(read.tokensUsed).toBe(assetOutputTokens(read))
      expect(read.tokensUsed).toBeLessThanOrEqual(budget)
    }
  })
})

describe('BM25 相似度缓存纪元与世界书扩深短路', () => {
  it('Bm25Index.similarity 在增删改与清空后精确更新权重且结果与全新建索引完全一致', () => {
    const live = new Bm25Index<string>()
    live.add({ id: 'a', text: '灯塔 守夜人 在 暴风雨 夜晚 点亮 雾灯', keys: ['灯塔', '雾灯'], ts: 1, data: 'a' })
    live.add({ id: 'b', text: '港口 船长 检查 蒸汽 锅炉 与 罗盘', keys: ['港口', '罗盘'], ts: 2, data: 'b' })
    live.add({ id: 'c', text: '守夜人 记录 潮汐 水位 与 风向', keys: ['守夜人', '潮汐'], ts: 3, data: 'c' })

    const first = live.similarity('守夜人 点亮 灯塔 雾灯', { topK: 3 })
    const second = live.similarity('守夜人 点亮 灯塔 雾灯', { topK: 3 })
    expect(second).toEqual(first)

    live.add({ id: 'a', text: '灯塔 已经 停用 改为 自动 信标', keys: ['灯塔', '信标'], ts: 4, data: 'a2' })
    live.remove('b')

    const fresh = new Bm25Index<string>()
    fresh.add({ id: 'c', text: '守夜人 记录 潮汐 水位 与 风向', keys: ['守夜人', '潮汐'], ts: 3, data: 'c' })
    fresh.add({ id: 'a', text: '灯塔 已经 停用 改为 自动 信标', keys: ['灯塔', '信标'], ts: 4, data: 'a2' })

    const liveHits = live.similarity('灯塔 自动 信标 守夜人', { topK: 5 })
    const freshHits = fresh.similarity('灯塔 自动 信标 守夜人', { topK: 5 })
    expect(liveHits.map((h) => ({ id: h.id, data: h.data, score: h.score }))).toEqual(
      freshHits.map((h) => ({ id: h.id, data: h.data, score: h.score })),
    )

    live.clear()
    expect(live.similarity('灯塔')).toEqual([])
  })

  it('evaluateWorldInfo 在 minActivations 扩深时保持固定 scanDepth 与概率失败不重掷语义', () => {
    const settings: WorldInfoGlobalSettings = {
      ...DEFAULT_WI_SETTINGS,
      scanDepth: 1,
      minActivations: 2,
      maxScanDepth: 5,
      recursiveScan: false,
      includeNames: false,
    }

    let randomCalls = 0
    const result = evaluateWorldInfo({
      entries: [
        // 固定只扫最近 1 条：即使扩深到历史第 0 条（含古籍），也不应被错误激活
        makeLoreEntry({ uid: 'fixed-miss', keys: ['古籍'], scanDepth: 1 }),
        // 概率 50% 且首轮掷出 0.95 失败：扩深循环中不能再次消耗随机数或复活
        makeLoreEntry({ uid: 'prob-fail', keys: ['海风'], probability: 50, useProbability: true }),
        // 跟随默认深度：初始深度 1 未命中，扩深到 3 时命中历史第 0 条
        makeLoreEntry({ uid: 'expanded-hit', keys: ['古籍'], scanDepth: null }),
        // 最新消息直接命中
        makeLoreEntry({ uid: 'recent-hit', keys: ['海风'], scanDepth: null }),
      ],
      messages: [
        { role: 'user', content: '书架深处藏着一本古籍' },
        { role: 'assistant', content: '走廊里很安静' },
        { role: 'user', content: '窗外吹来海风' },
      ],
      settings,
      timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 4096,
      estimateTokens: (s) => s.length,
      random: () => {
        randomCalls += 1
        return 0.95
      },
    })

    expect(result.activated.map((a) => a.entry.uid).sort()).toEqual(['expanded-hit', 'recent-hit'])
    expect(randomCalls).toBe(1)
  })
})

describe('MVU 命令编解码与 HTML 扫描边界', () => {
  it('createHelperMvuCommandCodec 准确统计多字节与代理对 UTF-8 长度并执行集合删除与设置', () => {
    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)
    const target = {
      hp: 100,
      tags: ['勇敢', '谨慎', '好奇'],
      bag: { key: 1, lantern: 2 },
      note: '',
    }
    const commands = codec.parse(
      `<UpdateVariable>\n_.set('note', '篝火🎭');\n_.delete('tags', '谨慎');\n_.delete('bag', 'key');\n</UpdateVariable>`,
    )
    const applied = codec.apply(target, commands)
    expect(applied.stat_data).toEqual({
      hp: 100,
      tags: ['勇敢', '好奇'],
      bag: { lantern: 2 },
      note: '篝火🎭',
    })
    // 超过 256 KiB UTF-8 的多字节输入必须被拒绝（80_000 个 4 字节 emoji > 262_144 B）
    expect(() => codec.parse('🎭'.repeat(80_000))).toThrow(/256/)
  })

  it('hideIncompleteHtml 与 presentRenderedOutput 保留代码块内尖括号并隐藏尾部未闭合 HTML', () => {
    const fenced = '说明：\n```html\n<div class="code-only">未闭合也没关系\n```\n正文继续'
    expect(hideIncompleteHtml(fenced)).toEqual({ text: fenced })

    const streaming = '台词前半段\n<div class="status-card"><span>加载中'
    expect(hideIncompleteHtml(streaming)).toEqual({ text: '台词前半段\n', pendingHtml: true })

    const complete = '台词\n<div class="card">面板</div>'
    const presented = presentRenderedOutput(complete, true)
    expect(presented.htmls).toEqual(['<div class="card">面板</div>'])
    expect(presented.text).toBe('台词')
  })
})

describe('记忆批量合并、回滚展开与服务端展示正则批处理', () => {
  let root = ''
  let paths: TavernPaths

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-perf-opt-'))
    paths = {
      root,
      characters: join(root, 'characters'),
      lorebooks: join(root, 'lorebooks'),
      presets: join(root, 'presets'),
      personas: join(root, 'personas'),
      regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions'),
    }
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('MemoryStore 批量读取、乐观校验归并与回滚展开保持完整谱系', async () => {
    const fs = new WorkspaceFs(join(root, 'story-mem'), null)
    const store = new MemoryStore(fs)
    const m1 = await store.write({ body: '主角在旧灯塔发现了铜钥匙。', tags: ['线索'], keys: ['铜钥匙'] })
    const m2 = await store.write({ body: '铜钥匙打开了地下储藏室的铁门。', tags: ['线索'], keys: ['储藏室'] })
    const initialStats = await store.stats()
    expect(initialStats.count).toBe(2)
    expect(initialStats.tokens).toBeGreaterThan(0)

    const merged = await store.mergeBatch([m1, m2], '主角用旧灯塔的铜钥匙打开了地下储藏室。', 'compress')
    expect(merged).toBe(2)
    const activeAfterMerge = await store.list()
    expect(activeAfterMerge).toHaveLength(1)
    expect(activeAfterMerge[0]!.body).toContain('地下储藏室')

    await expandAffectedMemories(fs.root, [`memory/${m1.id}.md`])
    const restored = await store.list()
    expect(restored.map((e) => e.id).sort()).toEqual([m1.id, m2.id].sort())
  })

  it('TavernService.renderOutputTexts 合批执行展示正则，且单条模板未提交错误不影响同批其它气泡', async () => {
    const sessionId = 'session-render-batch-opt'
    const state = new TavernState(paths, () => resolveConfig({ interactiveCards: true }))
    await state.init()
    const session = Session.create(sessionId as Session['id'])
    const host = {
      reflect: { provide: () => {} },
      get: () => undefined,
      sessions: { get: (id: string) => (id === sessionId ? session : undefined) },
      logger: { warn: () => {} },
    } as unknown as Context
    const cfg = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
    const settingsScope: TavernSettingsScope = {
      get: () => cfg,
      revision: () => 0,
      update: async () => {},
    }
    const service = new TavernService(host, state, settingsScope)

    await service.saveRegexRules({
      rules: [
        {
          id: 'rule-mask',
          name: '替换暗号',
          find: '/\\[MARKER:([^\\]]+)\\]/g',
          replace: '【标记：$1】',
          enabled: true,
          scopes: ['output'],
          timing: ['render'],
          minDepth: null,
          maxDepth: null,
          substituteRegex: 0,
          source: 'user',
        },
      ],
    })
    const card = await state.createCharacter('守夜人')
    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      greetingIndex: 0,
      interactiveCards: true,
      helperMvu: false,
      createdAt: new Date(0).toISOString(),
    })

    const batch = await service.renderOutputTexts({
      sessionId,
      items: [
        { text: '第一层：[MARKER:北塔]' },
        // 非开场白消息含未物化 EJS 时必须单项报错，不能拖垮前后两条正常气泡
        { text: '损坏层：<%= 1 + 1 %>', messageId: 99 },
        { text: '第三层：[MARKER:雾笛] <div class="panel">状态正常</div>' },
      ],
    })

    expect(batch.items).toHaveLength(3)
    expect(batch.items[0]).toMatchObject({ ok: true, value: { text: '第一层：【标记：北塔】' } })
    expect(batch.items[1]).toMatchObject({ ok: false })
    expect(batch.items[2]).toMatchObject({
      ok: true,
      value: { text: '第三层：【标记：雾笛】', htmls: ['<div class="panel">状态正常</div>'] },
    })
  })
})

describe('客户端事件共享、角色无头像跳过与分页、设置页惰性加载', () => {
  it('subscribeKeyedWindowEvent 同事件名只注册一个底层监听器，并在退订完毕后移除', () => {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const fakeWindow = {
      addEventListener: vi.fn((type: string, fn: (event: Event) => void) => {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(fn)
      }),
      removeEventListener: vi.fn((type: string, fn: (event: Event) => void) => {
        listeners.get(type)?.delete(fn)
      }),
      dispatchEvent: (event: Event) => {
        for (const fn of listeners.get(event.type) ?? []) fn(event)
        return true
      },
    }
    vi.stubGlobal('window', fakeWindow)
    try {
      let hitsA = 0
      let hitsB = 0
      const unsubA = subscribeKeyedWindowEvent('dsh-tavern:test-evt', 'key-a', true, () => { hitsA += 1 })
      const unsubB = subscribeKeyedWindowEvent('dsh-tavern:test-evt', 'key-b', false, () => { hitsB += 1 })
      expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(1)

      fakeWindow.dispatchEvent(new CustomEvent('dsh-tavern:test-evt', { detail: 'key-a' }))
      expect([hitsA, hitsB]).toEqual([1, 0])

      fakeWindow.dispatchEvent(new CustomEvent('dsh-tavern:test-evt'))
      expect([hitsA, hitsB]).toEqual([2, 0])

      unsubA()
      expect(fakeWindow.removeEventListener).not.toHaveBeenCalled()
      unsubB()
      expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('CharactersSection 跳过无头像卡的 getAvatar 请求，并在超过 24 张卡时按页展示', async () => {
    const items: CharacterSummary[] = Array.from({ length: 30 }, (_, index) => ({
      cardId: `opt-card-${index}`,
      name: `角色${index}`,
      hasAvatar: index === 2,
      hasCharacterBook: false,
      characterBookName: null,
      characterBookEntryCount: 0,
    }))
    const getAvatar = vi.fn(async ({ cardId }: { cardId: string }) => ({
      ok: true as const,
      value: { dataUrl: `data:image/png;base64,${cardId}` },
    }))
    const remote = {
      listCharacters: async () => ({ ok: true as const, value: { items } }),
      getAvatar,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<CharactersSection remote={remote} />)
    })
    mounted.push(view)

    const renderedCards = () =>
      view.root.findAll(
        (node) =>
          typeof node.type === 'string'
          && typeof node.props.className === 'string'
          && node.props.className.split(' ').includes('dsh-tavern-charCard'),
      )

    expect(renderedCards()).toHaveLength(24)
    expect(getAvatar).toHaveBeenCalledTimes(1)
    expect(getAvatar).toHaveBeenCalledWith({ cardId: 'opt-card-2' })

    const moreBtn = view.root.findAllByType(Btn).find((b) => b.props.children === '显示更多角色')
    expect(moreBtn).toBeDefined()
    await act(async () => moreBtn!.props.onClick())
    expect(renderedCards()).toHaveLength(30)
    expect(getAvatar).toHaveBeenCalledTimes(1)
  })

  it('SettingsSection 首屏停留在界面组时不预拉预设/世界书/人设/数据目录，切入对应分组才按需拉取', async () => {
    const cfg = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
    const getSettings = vi.fn(async () => ({ ok: true as const, value: { settings: cfg } }))
    const getDataInfo = vi.fn(async () => ({ ok: true as const, value: { dataHome: '/tmp/tavern' } }))
    const listPresets = vi.fn(async () => ({ ok: true as const, value: { items: [] } }))
    const listLorebooks = vi.fn(async () => ({ ok: true as const, value: { items: [] } }))
    const listPersonas = vi.fn(async () => ({ ok: true as const, value: { items: [] } }))

    const remote = {
      getSettings,
      getDataInfo,
      listPresets,
      listLorebooks,
      listPersonas,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<SettingsSection remote={remote} />)
    })
    mounted.push(view)

    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(listPresets).not.toHaveBeenCalled()
    expect(listLorebooks).not.toHaveBeenCalled()
    expect(listPersonas).not.toHaveBeenCalled()
    expect(getDataInfo).not.toHaveBeenCalled()

    await act(async () => {
      view.root.findByType(Tabs).props.onChange('defaults')
    })
    expect(listPresets).toHaveBeenCalledTimes(1)
    expect(listLorebooks).toHaveBeenCalledTimes(1)
    expect(listPersonas).toHaveBeenCalledTimes(1)
    expect(getDataInfo).not.toHaveBeenCalled()

    await act(async () => {
      view.root.findByType(Tabs).props.onChange('cards')
    })
    expect(getDataInfo).toHaveBeenCalledTimes(1)

    await act(async () => {
      view.root.findByType(Tabs).props.onChange('defaults')
    })
    expect(listPresets).toHaveBeenCalledTimes(1)
  })
})
