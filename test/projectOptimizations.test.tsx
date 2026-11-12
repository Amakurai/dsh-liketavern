/**
 * 全栈性能与交互健壮性回归测试：
 * - 世界书 minActivations 增量扩深：无主键深度增量剪枝与 selective 次键跨深度组合一致；
 * - WorldDeltaStore 跨实例缓存一致性与 TavernState 角色/剧情句柄池独立淘汰上限；
 * - 客户端流式高频重绘：useMarkdownLabels 引用稳定、useContinuationStream 瞬态分片零历史重扫、
 *   window message 单监听器按 source 路由；
 * - 样式与面板交互：prefers-reduced-motion 覆盖聊天气泡与操作条、世界书条目键盘按钮触发器、
 *   正则脏草稿放弃确认框、记忆面板跨剧情切换复用角色列表与长列表增量分页。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_WI_SETTINGS,
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type MemoryEntry,
  type RegexRule,
  type WorldInfoEntry,
} from '../src/core/types.js'
import { evaluateWorldInfo } from '../src/core/worldbook.js'
import { resolveConfig } from '../src/node/config.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { createBlankCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { WorldDeltaStore } from '../src/state/worlddelta.js'
import { useContinuationStream } from '../src/client/continuationStream.js'
import { setTavernLocale, useMarkdownLabels } from '../src/client/i18n.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { ensureTavernStyles } from '../src/client/styles.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { Btn, ConfirmDialog, Select } from '../src/client/util.js'
import { subscribeWindowMessage } from '../src/client/windowEvents.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode; disabled?: boolean; onClick?: (e: { stopPropagation: () => void }) => void }) => (
    <button disabled={props.disabled} onClick={() => props.onClick?.({ stopPropagation: () => {} })}>{props.children}</button>
  ),
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => (
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null
  ),
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })

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
    content: partial.key,
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

describe('世界书 minActivations 增量扩深', () => {
  it('扩深扫描同时正确激活深层单主键条目与浅层主键+深层次键 selective 条目', () => {
    const entries: WorldInfoEntry[] = [
      makeWiEntry({ key: 'deep-primary', keys: ['ancient-relic'], content: '深层主键命中' }),
      makeWiEntry({
        key: 'split-selective',
        keys: ['harbor'],
        secondaryKeys: ['lighthouse'],
        selective: true,
        selectiveLogic: WISelectiveLogic.AndAny,
        content: '跨深度主次键同时满足',
      }),
      makeWiEntry({ key: 'never-hit', keys: ['nonexistent-token'], content: '永不命中' }),
    ]
    const messages = [
      { role: 'user' as const, content: 'We saw an ancient-relic near the old cliff.' },
      { role: 'assistant' as const, content: 'The lighthouse keeper warned us at dusk.' },
      { role: 'user' as const, content: 'Nothing special happened on the road.' },
      { role: 'assistant' as const, content: 'We arrived at the harbor safely.' },
    ]
    const result = evaluateWorldInfo({
      entries,
      messages,
      settings: {
        ...DEFAULT_WI_SETTINGS,
        scanDepth: 1,
        minActivations: 2,
        maxScanDepth: 4,
      },
      timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 4000,
      reservedTokens: 0,
      estimateTokens: () => 10,
      random: () => 0.5,
    })
    const keys = result.activated.map((item) => item.entry.key)
    expect(keys).toContain('deep-primary')
    expect(keys).toContain('split-selective')
    expect(keys).not.toContain('never-hit')
  })
})

describe('状态缓存与工作区句柄池隔离', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-opt-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('WorldDeltaStore 跨实例共享目录缓存，append 与 revoke 立即对另一实例可见', async () => {
    const fsA = new WorkspaceFs(root)
    const fsB = new WorkspaceFs(root)
    const storeA = new WorldDeltaStore(fsA)
    const storeB = new WorldDeltaStore(fsB)

    expect(await storeB.list()).toEqual([])
    const added = await storeA.append({
      type: 'add',
      ref: null,
      content: '城门已封锁',
      keys: ['城门'],
      order: 100,
      sourceRange: 'turn-1',
      expires: null,
    })
    const seenAfterAppend = await storeB.list()
    expect(seenAfterAppend).toHaveLength(1)
    expect(seenAfterAppend[0]?.id).toBe(added.id)
    expect(seenAfterAppend[0]?.revoked).toBeUndefined()

    expect(await storeA.revoke(added.id)).toBe(true)
    expect(await storeB.list()).toEqual([])
    const seenWithRevoked = await storeB.list({ includeRevoked: true })
    expect(seenWithRevoked[0]?.revoked).toBe(true)
  })

  it('TavernState 遍历超过 64 张角色卡工作区不会逐出已缓存的剧情工作区句柄', async () => {
    const paths: TavernPaths = {
      root,
      characters: join(root, 'characters'),
      lorebooks: join(root, 'library', 'lorebooks'),
      presets: join(root, 'library', 'presets'),
      personas: join(root, 'personas'),
      regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions'),
    }
    const state = new TavernState(paths, () => resolveConfig({}))
    await state.init()

    const cardIds: string[] = []
    for (let i = 0; i < 70; i++) {
      const ws = await importCard(paths.characters, createBlankCard(`Card ${i}`))
      cardIds.push(ws.cardId)
    }

    const storyId = await state.forkStory(
      {
        sessionId: 'session-anchor',
        cardId: cardIds[0]!,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        authorNote: '',
        injectJournal: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
      'session-anchor',
      async () => {},
    )
    const storyHandleBefore = await state.storyWorkspace(cardIds[0]!, storyId)

    for (const id of cardIds) {
      await state.workspace(id)
    }

    const storyHandleAfter = await state.storyWorkspace(cardIds[0]!, storyId)
    expect(storyHandleAfter).toBe(storyHandleBefore)
  })
})

describe('客户端流式重绘、消息分发与交互健壮性', () => {
  const mounted: ReactTestRenderer[] = []

  async function render(node: ReactNode): Promise<ReactTestRenderer> {
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(node)
    })
    mounted.push(view)
    return view
  }

  beforeEach(() => {
    setTavernLocale('zh')
  })

  afterEach(async () => {
    for (const view of mounted.splice(0)) {
      await act(async () => view.unmount())
    }
    vi.unstubAllGlobals()
  })

  it('useMarkdownLabels 在同一语言重绘间保持稳定引用，切换语言后即时更新', async () => {
    const seen: Array<ReturnType<typeof useMarkdownLabels>> = []
    let bump!: () => void
    function Probe() {
      const [, setTick] = useState(0)
      bump = () => setTick((n) => n + 1)
      const labels = useMarkdownLabels()
      seen.push(labels)
      return <span>{labels.code.copyLabel}</span>
    }

    await render(<Probe />)
    await act(async () => bump())
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])

    await act(async () => setTavernLocale('en'))
    expect(seen.at(-1)).not.toBe(seen[0])
    expect(seen.at(-1)?.code.copyLabel).not.toBe(seen[0]?.code.copyLabel)
  })

  it('useContinuationStream 在流式 transient chunk 追加时不重扫完整 entries 历史', async () => {
    let historicalReads = 0
    const baseEvent = { type: 'user/message', seq: 1, turn: 1, content: 'hello' } as unknown as SessionEvent
    const historicalEntry = {
      type: 'event' as const,
      get event() {
        historicalReads++
        return baseEvent
      },
    }
    const listeners = new Set<() => void>()
    let currentWindow: SessionEventWindow = {
      entries: [historicalEntry],
      hasMore: false,
      revision: 1,
      change: { kind: 'reset' },
    }
    const source: SessionEventSource = {
      getSnapshot: () => currentWindow,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }

    function StreamProbe(props: { text: string }) {
      const out = useContinuationStream(source, 1, 2, props.text)
      return <span>{out.text}</span>
    }

    const view = await render(<StreamProbe text="首段" />)
    const readsAfterInit = historicalReads
    expect(readsAfterInit).toBeGreaterThan(0)

    const transientChunk = {
      type: 'transient' as const,
      event: { type: 'assistant/live-chunk', seq: 2, turn: 1 } as unknown as Extract<
        SessionEventWindow['entries'][number],
        { type: 'transient' }
      >['event'],
    }
    await act(async () => {
      currentWindow = {
        entries: [historicalEntry, transientChunk],
        hasMore: false,
        revision: 2,
        change: { kind: 'append', entries: [transientChunk] },
      }
      for (const fn of listeners) fn()
    })
    await act(async () => view.update(<StreamProbe text="首段续写" />))

    expect(historicalReads).toBe(readsAfterInit)
    expect(JSON.stringify(view.toJSON())).toContain('首段续写')
  })

  it('subscribeWindowMessage 在 window 上只注册单个 message 监听器并按 source 精确路由', () => {
    const target = new EventTarget()
    const addSpy = vi.spyOn(target, 'addEventListener')
    const removeSpy = vi.spyOn(target, 'removeEventListener')
    vi.stubGlobal('window', target)

    const frameA = { id: 'a' }
    const frameB = { id: 'b' }
    const receivedA: unknown[] = []
    const receivedB: unknown[] = []

    const offA = subscribeWindowMessage(frameA, (e) => receivedA.push(e.data))
    const offB = subscribeWindowMessage(frameB, (e) => receivedB.push(e.data))
    expect(addSpy).toHaveBeenCalledTimes(1)

    const msgForB = new Event('message')
    Object.defineProperties(msgForB, { source: { value: frameB }, data: { value: 'hello-b' } })
    target.dispatchEvent(msgForB)

    expect(receivedA).toEqual([])
    expect(receivedB).toEqual(['hello-b'])

    offA()
    expect(removeSpy).not.toHaveBeenCalled()
    offB()
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('全局样式表为聊天气泡与操作条提供 accent 变量与 prefers-reduced-motion 覆盖', async () => {
    const styleNodes: Array<{ id: string; textContent: string }> = []
    vi.stubGlobal('document', {
      getElementById: (id: string) => styleNodes.find((n) => n.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (el: { id: string; textContent: string }) => styleNodes.push(el) },
    })
    ensureTavernStyles()
    const css = styleNodes[0]?.textContent ?? ''
    expect(css).toContain('.dsh-tavern-ui,.dsh-tavern-speech,.dsh-tavern-actionGroup{')
    expect(css).toContain('.dsh-tavern-speech *')
    expect(css).toContain('.dsh-tavern-actionGroup *')
    expect(css).toContain('.dsh-tavern-entryTrigger{')

    const stylesSource = await readFile(join(process.cwd(), 'src', 'client', 'styles.ts'), 'utf8')
    expect(stylesSource).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('LorebookEditor 条目头部渲染独立键盘可聚焦触发按钮并维护 aria-expanded', async () => {
    const entryA = makeWiEntry({ key: 'entry-1', comment: '港口守则', keys: ['港口'] })
    const entryB = makeWiEntry({ key: 'entry-2', comment: '灯塔日志', keys: ['灯塔'] })
    const remote = {} as unknown as TavernRemote
    const view = await render(
      <LorebookEditor
        remote={remote}
        target={{ kind: 'library', name: '港口' }}
        entries={[entryA, entryB]}
        revision="rev-1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    const firstTrigger = () => view.root.findAllByProps({ className: 'dsh-tavern-entryTrigger' })[0]!
    expect(firstTrigger().type).toBe('button')
    expect(firstTrigger().props['aria-expanded']).toBe(false)

    await act(async () => firstTrigger().props.onClick({ stopPropagation: () => {} }))
    expect(firstTrigger().props['aria-expanded']).toBe(true)
  })

  it('RegexSection 有未保存修改时点击放弃更改先弹确认框，取消保留草稿、确认后重拉', async () => {
    const initial: RegexRule = {
      id: 'rule-1',
      name: '初始规则',
      find: 'foo',
      replace: 'bar',
      enabled: true,
      scopes: ['output'],
      timing: ['render'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'user',
    }
    const listRegexRules = vi.fn(async () => ok({ rules: [structuredClone(initial)], revision: 'rev-1' }))
    const remote = {
      listRegexRules,
      listPresets: async () => ok({ items: [] }),
    } as unknown as TavernRemote

    const view = await render(<RegexSection remote={remote} />)
    const nameInput = view.root.findAllByType('input')[0]!
    await act(async () => nameInput.props.onChange({ target: { value: '未保存的新名字' } }))

    const discardBtn = view.root.findAllByType(Btn).find((b) => b.props.children === '放弃更改并刷新')!
    await act(async () => discardBtn.props.onClick())

    const openDialog = () => view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)
    expect(openDialog()).toBeDefined()
    expect(listRegexRules).toHaveBeenCalledTimes(1)

    await act(async () => openDialog()!.props.onCancel())
    expect(openDialog()).toBeUndefined()
    expect(view.root.findAllByType('input')[0]!.props.value).toBe('未保存的新名字')

    await act(async () => discardBtn.props.onClick())
    await act(async () => openDialog()!.props.onConfirm())
    expect(listRegexRules).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByType('input')[0]!.props.value).toBe('初始规则')
  })

  it('MemorySection 切换剧情不重复拉取角色与剧情列表，超过 50 条记忆按页增量渲染', async () => {
    const memoriesMany: MemoryEntry[] = Array.from({ length: 65 }, (_, i) => ({
      id: `mem-${i + 1}`,
      created: '2026-01-01',
      updated: '2026-01-01',
      body: `记忆正文 ${i + 1}`,
      tags: [],
      keys: [],
      sourceRange: 'turn-1',
    }))
    const listCharacters = vi.fn(async () => ok({
      items: [{ cardId: 'card-1', name: '守望者', hasAvatar: false, hasCharacterBook: false }],
    }))
    const listStories = vi.fn(async () => ok({
      items: [
        { id: 'story-a', createdAt: '2026-01-01T00:00:00Z', sessionId: 'sess-a' },
        { id: 'story-b', createdAt: '2026-01-02T00:00:00Z', sessionId: 'sess-b' },
      ],
    }))
    const getMemories = vi.fn(async ({ storyId }: { cardId: string; storyId?: string }) => (
      ok({ items: storyId === 'story-b' ? memoriesMany : memoriesMany.slice(0, 3) })
    ))
    const remote = {
      listCharacters,
      listStories,
      getMemories,
      getWorldDeltas: async () => ok({ items: [] }),
      getJournal: async () => ok({ text: '', revision: 'j-1' }),
      getStoryRecovery: async () => ok({ floors: [] }),
    } as unknown as TavernRemote

    const view = await render(
      <MemorySection remote={remote} initialContext={{ cardId: 'card-1', storyId: 'story-a' }} />,
    )
    expect(listCharacters).toHaveBeenCalledTimes(1)
    expect(listStories).toHaveBeenCalledTimes(1)

    // 切换到 story-b：不应重新请求 listCharacters 或 listStories
    const storySelect = view.root.findAllByType(Select)[1]!
    await act(async () => storySelect.props.onChange('story-b'))
    expect(listCharacters).toHaveBeenCalledTimes(1)
    expect(listStories).toHaveBeenCalledTimes(1)

    // 65 条记忆首屏渲染 50 条（外加底部 1 张 is-compose 卡片），并提供「加载更多（剩余 15 条）」
    const renderedMemos = () => view.root.findAll((node) => node.type === 'div' && node.props.className === 'dsh-tavern-memo')
    expect(renderedMemos()).toHaveLength(50)
    const loadMoreBtn = view.root.findAllByType(Btn).find((b) => String(b.props.children).includes('加载更多（剩余 15 条）'))
    expect(loadMoreBtn).toBeDefined()

    await act(async () => loadMoreBtn!.props.onClick())
    expect(renderedMemos()).toHaveLength(65)
  })
})
