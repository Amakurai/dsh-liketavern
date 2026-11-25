/**
 * 角色卡相关客户端 UI 审计修复回归测试（Bug #1–#10）：
 * - #1: TavernHeaderChip 与 CardDataSettings 正确展示已收纳角色名与内嵌书，不暴露原始 cardId，且草稿支持切回原已收纳角色
 * - #2: TavernHeaderChip 在 getSessionBinding 失败时展示错误态与重试入口，不伪装未绑定覆盖原绑定
 * - #3: TavernHeaderChip.insertGreeting 成功后失效缓存、重载绑定、广播 BINDING_CHANGED_EVENT 并刷新宿主会话列表
 * - #4: HeroCharacterSession 在 bindingLoader.reload 期间保留当前绑定，切开场白不卸载预览卡片、不丢失键盘焦点
 * - #5: HeroCharacterSession 收到外部 BINDING_CHANGED_EVENT 时取消本会话自动清扫，避免误删头部 chip 刚保存的绑定
 * - #6: CharacterDetailDialog 仅按可编辑字段判脏，保存时结束恢复态并同步裁剪后的备选开场白，不误报未保存
 * - #7: CharactersSection.onImportFile 前置拦截 0 字节文件与超过 24 MiB 的 JSON 文件
 * - #8: CharactersSection 空列表态下不与 SearchEmpty 同时渲染
 * - #9: CharactersSection 导入预检弹窗经 onClose 关闭时同步清除失败错误，不泄漏到主页面
 * - #10: depthPrompt 清空重填保留 depth/role、altGreetings 文案修正、Hero 空白开场白显示空提示而非空白预览
 * - #11: MemorySection 加载已收纳角色并在下拉与剧情头展示「…（已收纳）」，绝不暴露原始 cardId 或通用「角色」
 * - #12: CharacterCard 移除外层 role="button" 嵌套交互按钮，点击卡片打开详情、点击收纳不触发详情弹窗
 */
import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT } from '../src/client/actions.js'
import { invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { PersistentEditor } from '../src/client/draftPersistence.js'
import { TavernHeroCharacter } from '../src/client/hero.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { en as charactersEn, zh as charactersZh } from '../src/client/locales/characters.js'
import { CardDataSettings, SessionTransfer } from '../src/client/panel/cardData.js'
import { CharactersSection, editableCharacterSnapshot } from '../src/client/panel/characters.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { markSessionView } from '../src/client/sessionViews.js'
import type { ArchivedCharacterSummary, CharacterDetail, CharacterInspect, CharacterSummary, Envelope, SessionBinding, TavernRemote } from '../src/client/types.js'
import { Btn, ConfirmDialog, Dialog, Err, FileBtn, NumInput, SearchEmpty, SearchInput, Select, Tabs, fileToBase64 } from '../src/client/util.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => createElement('button', props),
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? createElement('div', { role: 'dialog' }, props.children, props.footer) : null,
  Tooltip: (props: { children?: ReactNode }) => createElement(Fragment, null, props.children),
  Toast: (props: { text: string }) => createElement('div', { role: 'status' }, props.text),
  Menu: (props: { anchor?: ReactNode }) => createElement(Fragment, null, props.anchor),
  IconArchiveOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronLeftOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))
vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/client/util.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/util.js')>(),
  fileToBase64: vi.fn(async (file: File) => Buffer.from(await file.arrayBuffer()).toString('base64')),
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string, code = 'audit-err'): Envelope<never> => ({ ok: false, error: { code, message } })

const mounted: ReactTestRenderer[] = []
const cleanups: Array<() => void> = []
let winEvents: EventTarget

function textOf(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return node.children.map((child) => textOf(child)).join('')
}

function makeSummary(cardId: string, name: string, overrides: Partial<CharacterSummary> = {}): CharacterSummary {
  return {
    cardId,
    name,
    creator: '',
    tags: [],
    hasAvatar: false,
    hasCharacterBook: false,
    characterBookName: null,
    characterBookEntryCount: 0,
    ...overrides,
  }
}

function makeArchivedSummary(cardId: string, name: string, overrides: Partial<ArchivedCharacterSummary> = {}): ArchivedCharacterSummary {
  return {
    ...makeSummary(cardId, name, overrides),
    archivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeDetail(cardId: string, name: string, overrides: Partial<CharacterDetail> = {}): CharacterDetail {
  return {
    cardId,
    revision: 'a'.repeat(64),
    name,
    description: '初始描述',
    personality: '',
    scenario: '',
    firstMes: '你好，旅人。',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: '',
    characterVersion: '1.0',
    tags: [],
    spec: 'chara_card_v2',
    hasCharacterBook: false,
    characterBookName: null,
    characterBookEntryCount: 0,
    hasAvatar: false,
    depthPrompt: null,
    extensions: {},
    ...overrides,
  }
}

function makeInspect(name: string): CharacterInspect {
  return {
    name,
    hasAvatar: false,
    hasCharacterBook: false,
    characterBookName: null,
    entryCount: 0,
    compatibility: {
      findings: [],
      truncated: false,
    },
  }
}

function tavernSessionsHook(sessionId: string) {
  const state = { byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } }
  return <T,>(selector: (s: typeof state) => T): T => selector(state)
}

async function mount(node: ReactNode): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer
  await act(async () => {
    view = create(node)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  mounted.push(view)
  return view
}

beforeEach(() => {
  setTavernLocale('zh')
  vi.clearAllMocks()
  const storage = new Map<string, string>([['dsh-tavern-editor-owner', 'audit-card-ui-owner']])
  winEvents = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  })
  vi.stubGlobal('window', winEvents)
  vi.stubGlobal('document', {
    body: {},
    documentElement: {},
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: () => [],
  })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
})

afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => view.unmount())
  }
  while (cleanups.length > 0) cleanups.pop()!()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setTavernLocale('zh')
})

describe('Bug #1: 已收纳角色绑定展示、内嵌世界书与草稿切回', () => {
  it('TavernHeaderChip 绑定已收纳角色时显示卡名与内嵌书，且切换草稿后可切回原角色不暴露 cardId', async () => {
    const sessionId = 'session-archived-chip'
    const archivedId = 'arc-snow-99'
    const activeId = 'active-lighthouse-1'
    invalidateSessionBinding(sessionId)
    invalidateCharacter(archivedId)
    invalidateCharacter(activeId)

    const binding: SessionBinding = {
      ...defaultBinding(sessionId, archivedId),
      cardName: '雪原旅人',
      storyId: 'story-snow',
      greetingIndex: 2,
      helperMvu: true,
    }
    const archivedSummary = makeArchivedSummary(archivedId, '雪原旅人', {
      hasCharacterBook: true,
      characterBookName: '雪原典籍',
      characterBookEntryCount: 5,
    })
    const activeSummary = makeSummary(activeId, '灯塔')
    const archivedDetail = makeDetail(archivedId, '雪原旅人', {
      hasCharacterBook: true,
      characterBookName: '雪原典籍',
      characterBookEntryCount: 5,
    })

    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false })),
      getCharacterDetail: vi.fn(async ({ cardId }: { cardId: string }) => ok(cardId === archivedId ? archivedDetail : makeDetail(activeId, '灯塔'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters: vi.fn(async () => ok({ items: [activeSummary] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [archivedSummary] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
      setSessionBinding: vi.fn(async () => ok({ saved: true })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeaderChip, {
      remote,
      sessionId,
      sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) },
      useSessions: tavernSessionsHook(sessionId),
    }))

    await act(async () => {
      view.root.findByType(TavernSeatChip).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const selects = view.root.findAllByType(Select)
    const charSelect = selects[0]!
    const mainLoreSelect = selects.find((s) =>
      (s.props.options as Array<{ value: string }>).some((o) => o.value === '@dsh/no-main-worldbook'),
    )!

    // 字符下拉显示带已收纳标记的卡名，绝不暴露原始 cardId
    const charLabel = textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))
    expect(charLabel).toBe(t('characters.archivedName', { name: '雪原旅人' }))
    expect(charLabel).not.toContain(archivedId)

    // 内嵌世界书准确显示名称与条数
    const embeddedOption = (mainLoreSelect.props.options as Array<{ value: string; label: string }>).find((o) => o.value === '')!
    expect(embeddedOption.label).toBe(t('chip.embeddedBook.withCount', { name: '雪原典籍', count: 5 }))

    // 切到活跃卡后，原已收纳卡仍在下拉中且内嵌书同步切为无
    await act(async () => {
      charSelect.props.onChange(activeId)
    })
    const afterSwitchCharSelect = view.root.findAllByType(Select)[0]!
    expect((afterSwitchCharSelect.props.options as Array<{ value: string; label: string }>).some((o) => o.value === archivedId)).toBe(true)
    const afterSwitchMainLore = view.root.findAllByType(Select).find((s) =>
      (s.props.options as Array<{ value: string }>).some((o) => o.value === '@dsh/no-main-worldbook'),
    )!
    expect((afterSwitchMainLore.props.options as Array<{ value: string; label: string }>).find((o) => o.value === '')!.label).toBe(
      t('chip.embeddedBook.none'),
    )
    expect(textOf(view.root)).toContain(t('draft.unsaved'))

    // 切回原已收纳卡：恢复内嵌书、故事归属并取消未保存脏态
    await act(async () => {
      afterSwitchCharSelect.props.onChange(archivedId)
    })
    const afterBackMainLore = view.root.findAllByType(Select).find((s) =>
      (s.props.options as Array<{ value: string }>).some((o) => o.value === '@dsh/no-main-worldbook'),
    )!
    expect((afterBackMainLore.props.options as Array<{ value: string; label: string }>).find((o) => o.value === '')!.label).toBe(
      t('chip.embeddedBook.withCount', { name: '雪原典籍', count: 5 }),
    )
    expect(textOf(view.root)).not.toContain(t('draft.unsaved'))
  })

  it('TavernHeaderChip 在缺少 listArchivedCharacters 的旧远端上仍从 detail 回退卡名与内嵌书', async () => {
    const sessionId = 'session-archived-fallback'
    const archivedId = 'arc-legacy-77'
    invalidateSessionBinding(sessionId)
    invalidateCharacter(archivedId)

    const binding = defaultBinding(sessionId, archivedId)
    const archivedDetail = makeDetail(archivedId, '旧宿主收纳卡', {
      hasCharacterBook: true,
      characterBookName: '旧典籍',
      characterBookEntryCount: 3,
    })
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false })),
      getCharacterDetail: vi.fn(async () => ok(archivedDetail)),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeaderChip, {
      remote,
      sessionId,
      sessions: { open: vi.fn() },
      useSessions: tavernSessionsHook(sessionId),
    }))
    await act(async () => {
      view.root.findByType(TavernSeatChip).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const charSelect = view.root.findAllByType(Select)[0]!
    expect(textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))).toBe('旧宿主收纳卡')
    expect(textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))).not.toContain(archivedId)
    const mainLore = view.root.findAllByType(Select).find((s) =>
      (s.props.options as Array<{ value: string }>).some((o) => o.value === '@dsh/no-main-worldbook'),
    )!
    expect((mainLore.props.options as Array<{ value: string; label: string }>).find((o) => o.value === '')!.label).toBe(
      t('chip.embeddedBook.withCount', { name: '旧典籍', count: 3 }),
    )
  })

  it('CardDataSettings 加载已收纳角色并显示卡名，可查看与导出已收纳角色的剧情', async () => {
    const sessionId = 'session-carddata-archived'
    const archivedId = 'arc-data-88'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const remote = {
      getSessionBinding: vi.fn(async () => ok({
        binding: { ...defaultBinding(sessionId, archivedId), cardName: '深海观察者', storyId: 'story-arc-1' },
        userName: '旅人',
        canSwipeGreeting: false,
        conversationStarted: true,
      })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('active-1', '港口灯塔')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [makeArchivedSummary(archivedId, '深海观察者')] })),
      listStories: vi.fn(async ({ cardId }: { cardId: string }) => ok({
        items: cardId === archivedId
          ? [{ id: 'story-arc-1', sessionId, createdAt: '2026-01-01T00:00:00.000Z', migrated: false }]
          : [],
      })),
      listSessionImportWorkspaces: vi.fn(async () => ok({ items: [] })),
      getHelperEventState: vi.fn(async () => ok({
        storyId: 'story-arc-1',
        historyRevision: 'rev-1',
        messages: [{ seq: 2, message_id: 0, role: 'assistant' as const }],
        writable: true,
        closedThrough: 2,
      })),
      getHelperSnapshot: vi.fn(async () => ok({
        storyId: 'story-arc-1',
        historyRevision: 'rev-1',
        currentMessageId: 0,
        writable: true,
        scopes: {},
        messages: [{ message_id: 0, role: 'assistant' as const, name: '深海观察者', message: '你好', data: {}, extra: {}, is_hidden: false }],
      })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CardDataSettings, { remote }))
    const charSelect = view.root.findAllByType(Select)[0]!
    const selectedLabel = textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))
    expect(selectedLabel).toBe(t('characters.archivedName', { name: '深海观察者' }))
    expect(selectedLabel).not.toContain(archivedId)
    expect(view.root.findByType(SessionTransfer).props.sessionId).toBe(sessionId)
  })

  it('CardDataSettings 兼容缺少 listArchivedCharacters 的远端，预填已收纳卡时不暴露原始 cardId', async () => {
    const sessionId = 'session-carddata-compat'
    const archivedId = 'arc-compat-66'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const remote = {
      getSessionBinding: vi.fn(async () => ok({
        binding: { ...defaultBinding(sessionId, archivedId), cardName: '旧兼容卡名', storyId: 'story-c1' },
        userName: '旅人',
        canSwipeGreeting: false,
        conversationStarted: true,
      })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listStories: vi.fn(async () => ok({ items: [] })),
      listSessionImportWorkspaces: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CardDataSettings, { remote }))
    const charSelect = view.root.findAllByType(Select)[0]!
    const selectedLabel = textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))
    expect(selectedLabel).toBe('旧兼容卡名')
    expect(selectedLabel).not.toContain(archivedId)
  })
})

describe('Bug #2: TavernHeaderChip 暴露绑定加载错误而非伪装未绑定', () => {
  it('getSessionBinding 失败时芯片显示错误态，弹窗展示 Err 与重试按钮而不渲染未绑定选角框，重试后恢复真实绑定', async () => {
    const sessionId = 'session-binding-error'
    invalidateSessionBinding(sessionId)
    const realBinding = { ...defaultBinding(sessionId, 'card-real'), cardName: '真实角色' }
    const pendingRetry = Promise.withResolvers<Envelope<{ binding: SessionBinding | null; userName: string; canSwipeGreeting: boolean; conversationStarted: boolean }>>()
    let calls = 0
    const getSessionBinding = vi.fn(() => {
      calls++
      if (calls === 1) return Promise.resolve(fail('绑定存储读取失败'))
      return pendingRetry.promise
    })
    const remote = {
      getSessionBinding,
      getCharacterDetail: vi.fn(async () => ok(makeDetail('card-real', '真实角色'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('card-real', '真实角色')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeaderChip, {
      remote,
      sessionId,
      sessions: { open: vi.fn() },
      useSessions: tavernSessionsHook(sessionId),
    }))

    // 芯片不伪装为「选择角色卡」
    const seatChip = view.root.findByType(TavernSeatChip)
    expect(seatChip.props.label).toBe(t('chip.bindingLoadFailed'))
    expect(seatChip.props.title).toContain('绑定存储读取失败')

    // 打开弹窗：只展示 Err + 重试按钮，绝不渲染未绑定角色选择器
    await act(async () => {
      seatChip.props.onClick()
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    const dialog = view.root.findAllByType(Dialog).find((d) => d.props.title === t('chip.dialog.title'))!
    expect(dialog.findAllByType(Err).some((e) => e.props.message === '绑定存储读取失败')).toBe(true)
    expect(dialog.findAllByType(Select)).toHaveLength(0)

    const retryBtn = dialog.findAllByType(Btn).find((b) => b.props.children === t('action.retry'))!
    expect(retryBtn).toBeDefined()

    // 点击重试且尚未返回时（loading）：依然不能闪烁出未绑定选择器
    await act(async () => {
      retryBtn.props.onClick()
      await Promise.resolve()
    })
    expect(view.root.findAllByType(Dialog).find((d) => d.props.title === t('chip.dialog.title'))!.findAllByType(Select)).toHaveLength(0)

    // 重试返回真实绑定后恢复正常绑定表单与角色名
    await act(async () => {
      pendingRetry.resolve(ok({ binding: realBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(view.root.findByType(TavernSeatChip).props.label).toBe('真实角色')
    const restoredSelect = view.root.findAllByType(Dialog).find((d) => d.props.title === t('chip.dialog.title'))!.findAllByType(Select)[0]!
    expect(restoredSelect.props.value).toBe('card-real')
  })
})

describe('Bug #3: TavernHeaderChip.insertGreeting 同步刷新缓存、事件与会话列表', () => {
  it.each([
    { created: true, conversationStarted: true, shouldNotify: true },
    { created: false, conversationStarted: true, shouldNotify: true },
    { created: false, conversationStarted: false, shouldNotify: false },
  ])('ensureGreeting 返回 created=$created started=$conversationStarted 时同步状态=$shouldNotify', async ({ created, conversationStarted, shouldNotify }) => {
    const sessionId = `session-insert-${String(created)}-${String(conversationStarted)}`
    invalidateSessionBinding(sessionId)
    const binding = defaultBinding(sessionId, 'card-g')
    const getSessionBinding = vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
    const ensureGreeting = vi.fn(async () => ok({ created, conversationStarted }))
    const refresh = vi.fn(async () => {})
    const events: string[] = []
    winEvents.addEventListener(BINDING_CHANGED_EVENT, (ev) => {
      events.push(String((ev as CustomEvent<string>).detail))
    })

    const remote = {
      getSessionBinding,
      ensureGreeting,
      getCharacterDetail: vi.fn(async () => ok(makeDetail('card-g', '开场角色'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('card-g', '开场角色')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeaderChip, {
      remote,
      sessionId,
      sessions: { open: vi.fn(), refresh },
      useSessions: tavernSessionsHook(sessionId),
    }))
    await act(async () => {
      view.root.findByType(TavernSeatChip).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const bindingCallsBefore = getSessionBinding.mock.calls.length
    const insertBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('binding.greeting'))!
    await act(async () => {
      insertBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    expect(ensureGreeting).toHaveBeenCalledExactlyOnceWith({ sessionId })
    if (shouldNotify) {
      expect(events).toEqual([sessionId])
      expect(refresh).toHaveBeenCalledOnce()
      expect(getSessionBinding.mock.calls.length).toBeGreaterThan(bindingCallsBefore)
    } else {
      expect(events).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
      expect(getSessionBinding.mock.calls.length).toBe(bindingCallsBefore)
    }
  })
})

describe('Bug #4 & #5 & #10c: HeroCharacterSession 重载保活、清扫竞态与空白开场白', () => {
  it('Bug #4: 键盘 ←/→ 切开场白触发 bindingLoader.reload 期间保留预览卡片不卸载、不重拉详情', async () => {
    const sessionId = 'session-hero-swipe-keep'
    invalidateCharacter('card-swipe')
    let currentBinding: SessionBinding | null = null
    let holdReload: PromiseWithResolvers<Envelope<{ binding: SessionBinding | null; userName: string; canSwipeGreeting: boolean; conversationStarted: boolean }>> | null = null

    const getSessionBinding = vi.fn(() => {
      if (holdReload) return holdReload.promise
      return Promise.resolve(ok({ binding: currentBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
    })
    const setSessionBinding = vi.fn(async ({ binding }: { binding: SessionBinding }) => {
      currentBinding = binding
      return ok({ saved: true })
    })
    const getCharacterDetail = vi.fn(async () => ok(makeDetail('card-swipe', '多开场角色', {
      firstMes: '开场一',
      alternateGreetings: ['开场二', '开场三'],
    })))
    const remote = {
      getSessionBinding,
      setSessionBinding,
      clearSessionBinding: vi.fn(async () => ok({ cleared: true })),
      getSettings: vi.fn(async () => ok({ settings: { defaults: { cardId: '', presetId: '', personaId: '', lorebookIds: [], characterLorebookId: '' } } })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('card-swipe', '多开场角色')] })),
      getCharacterDetail,
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, html: null, htmls: [], interactiveCards: false })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeroCharacter, {
      remote,
      sessionId,
      sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) },
      session: { blank: true, promptAttempted: false },
      useSessions: tavernSessionsHook(sessionId),
    }))

    // 先外部绑定到 card-swipe 并显示预览
    currentBinding = defaultBinding(sessionId, 'card-swipe')
    await act(async () => {
      winEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const previewBefore = view.root.findByProps({ className: 'dsh-tavern-hero-preview dsh-tavern-rise' })
    expect(textOf(view.root.findByProps({ className: 'dsh-tavern-hero-swipeIdx' }))).toBe('1/3')
    const detailCallsBefore = getCharacterDetail.mock.calls.length

    // 挂起 reload 响应并按 ArrowRight 切到下一条：重载进行中预览节点必须保持挂载且为同一实例
    holdReload = Promise.withResolvers()
    await act(async () => {
      previewBefore.props.onKeyDown({
        key: 'ArrowRight',
        target: previewBefore,
        currentTarget: previewBefore,
        preventDefault: vi.fn(),
      })
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })

    const previewDuringReload = view.root.findByProps({ className: 'dsh-tavern-hero-preview dsh-tavern-rise' })
    expect(previewDuringReload).toBe(previewBefore)
    expect(getCharacterDetail.mock.calls.length).toBe(detailCallsBefore)

    // reload 返回 greetingIndex=1：更新至 2/3 且保持挂载
    const pending = holdReload
    holdReload = null
    await act(async () => {
      pending.resolve(ok({ binding: currentBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(view.root.findByProps({ className: 'dsh-tavern-hero-preview dsh-tavern-rise' })).toBe(previewBefore)
    expect(textOf(view.root.findByProps({ className: 'dsh-tavern-hero-swipeIdx' }))).toBe('2/3')

    // 切到空绑定时 lastBinding 必须同步清零、预览正常卸载
    currentBinding = null
    await act(async () => {
      winEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(view.root.findAllByProps({ className: 'dsh-tavern-hero-preview dsh-tavern-rise' })).toHaveLength(0)
  })

  it.each(['loading', 'error'] as const)('Bug #5: Hero 初始绑定处于 %s 时外部 chip 绑定角色，不会触发自动清扫误删新绑定', async (initialMode) => {
    const sessionId = `session-hero-sweep-race-${initialMode}`
    invalidateCharacter('card-fresh')
    const initialGate = Promise.withResolvers<Envelope<{ binding: SessionBinding | null; userName: string; canSwipeGreeting: boolean; conversationStarted: boolean }>>()
    const freshBinding = { ...defaultBinding(sessionId, 'card-fresh'), cardName: '刚绑定的角色' }
    let callIndex = 0
    const getSessionBinding = vi.fn(() => {
      callIndex++
      if (callIndex === 1) {
        return initialMode === 'loading' ? initialGate.promise : Promise.resolve(fail('首次读取超时'))
      }
      return Promise.resolve(ok({ binding: freshBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
    })
    const clearSessionBinding = vi.fn(async () => ok({ cleared: true }))
    const remote = {
      getSessionBinding,
      clearSessionBinding,
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('card-fresh', '刚绑定的角色')] })),
      getCharacterDetail: vi.fn(async () => ok(makeDetail('card-fresh', '刚绑定的角色'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, html: null, htmls: [], interactiveCards: false })),
    } as unknown as TavernRemote

    const view = await mount(createElement(TavernHeroCharacter, {
      remote,
      sessionId,
      sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) },
      session: { blank: true, promptAttempted: false },
      useSessions: tavernSessionsHook(sessionId),
    }))

    // 模拟用户在 TavernHeaderChip 保存了新绑定并广播 BINDING_CHANGED_EVENT
    await act(async () => {
      winEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      if (initialMode === 'loading') {
        initialGate.resolve(ok({ binding: freshBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
      }
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })

    expect(clearSessionBinding).not.toHaveBeenCalled()
    expect(textOf(view.root)).toContain('刚绑定的角色')
  })

  it('Bug #5 回归对照: 无外部绑定变更事件时，Hero 仍会按原逻辑清扫空白会话上的遗留绑定', async () => {
    const sessionId = 'session-hero-sweep-normal'
    invalidateCharacter('card-stale')
    let currentBinding: SessionBinding | null = defaultBinding(sessionId, 'card-stale')
    const clearSessionBinding = vi.fn(async () => {
      currentBinding = null
      return ok({ cleared: true })
    })
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding: currentBinding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false })),
      clearSessionBinding,
      listCharacters: vi.fn(async () => ok({ items: [makeSummary('card-stale', '旧遗留角色')] })),
      getCharacterDetail: vi.fn(async () => ok(makeDetail('card-stale', '旧遗留角色'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, html: null, htmls: [], interactiveCards: false })),
    } as unknown as TavernRemote

    await mount(createElement(TavernHeroCharacter, {
      remote,
      sessionId,
      sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) },
      session: { blank: true, promptAttempted: false },
      useSessions: tavernSessionsHook(sessionId),
    }))
    expect(clearSessionBinding).toHaveBeenCalledExactlyOnceWith({ sessionId, onlyIfBlank: true })
  })

  it('Bug #10c: Hero 仅含空白字符的开场白显示空提示而非空白 GreetingPreview，且不发 renderOutputText', async () => {
    const check = async (
      sessionId: string,
      cardId: string,
      firstMes: string,
      alternateGreetings: string[],
      greetingIndex: number,
      expectedHintKey: string,
    ) => {
      invalidateCharacter(cardId)
      const renderOutputText = vi.fn(async ({ text }: { text: string }) => ok({ text, html: null, htmls: [], interactiveCards: false }))
      const binding = { ...defaultBinding(sessionId, cardId), greetingIndex }
      const remote = {
        getSessionBinding: vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: true, conversationStarted: false })),
        clearSessionBinding: vi.fn(async () => ok({ cleared: true })),
        listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, '空白开场角色')] })),
        getCharacterDetail: vi.fn(async () => ok(makeDetail(cardId, '空白开场角色', { firstMes, alternateGreetings }))),
        getAvatar: vi.fn(async () => ok({ dataUrl: null })),
        renderOutputText,
      } as unknown as TavernRemote

      // 先让外部绑定生效，避免空白会话自动清扫
      const view = await mount(createElement(TavernHeroCharacter, {
        remote,
        sessionId,
        sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) },
        session: { blank: true, promptAttempted: false },
        useSessions: tavernSessionsHook(sessionId),
      }))
      await act(async () => {
        winEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        for (let i = 0; i < 6; i++) await Promise.resolve()
      })

      expect(renderOutputText).not.toHaveBeenCalled()
      expect(view.root.findAllByProps({ className: 'dsh-tavern-hero-quote' })).toHaveLength(0)
      expect(textOf(view.root)).toContain(t(expectedHintKey))
      const startBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('hero.start'))!
      expect(startBtn.props.disabled).toBe(true)
    }

    await check('session-ws-none', 'card-ws-none', '   \n\t  ', [], 0, 'hero.noGreetingHint')
    await check('session-ws-alt', 'card-ws-alt', '有效主开场', ['   \t '], 1, 'hero.emptyVariantHint')
  })
})

describe('Bug #6 & #10a: CharacterDetailDialog 判脏、保存同步与 depthPrompt 记忆', () => {
  it('editableCharacterSnapshot 忽略服务端派生字段并归一化 depthPrompt', () => {
    const a = makeDetail('c1', '角色', {
      revision: 'rev-1',
      spec: 'chara_card_v1',
      extensions: { custom: 1 },
      characterName: '旧昵称',
      depthPrompt: { prompt: 'p', depth: 3, role: 'user' },
    })
    const b = makeDetail('c1', '角色', {
      revision: 'rev-2',
      spec: 'chara_card_v2',
      extensions: { custom: 1, depth_prompt: { prompt: 'p', depth: 3, role: 'user' } },
      characterName: '新昵称',
      depthPrompt: { role: 'user', depth: 3, prompt: 'p' },
    })
    expect(editableCharacterSnapshot(a)).toBe(editableCharacterSnapshot(b))
  })

  it('保存带首尾空白与空行的 alternateGreetings 且服务端更新 extensions/spec 后，不误报未保存', async () => {
    const cardId = 'card-dirty-fix'
    invalidateCharacter(cardId)
    let serverCard = makeDetail(cardId, '判脏角色', {
      revision: '1'.repeat(64),
      spec: 'chara_card_v1',
      alternateGreetings: ['原备选'],
    })
    const saveCharacter = vi.fn(async (req: { alternateGreetings?: string[]; depthPrompt?: CharacterDetail['depthPrompt'] }) => {
      serverCard = {
        ...serverCard,
        revision: '2'.repeat(64),
        spec: 'chara_card_v2',
        alternateGreetings: req.alternateGreetings ?? serverCard.alternateGreetings,
        depthPrompt: req.depthPrompt ?? null,
        extensions: { ...serverCard.extensions, depth_prompt: req.depthPrompt ?? undefined },
        characterName: '服务端昵称',
      }
      return ok({ cardId, name: serverCard.name, revision: serverCard.revision })
    })
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, serverCard.name)] })),
      getCharacterDetail: vi.fn(async () => ok(structuredClone(serverCard))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      saveCharacter,
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))
    await act(async () => {
      view.root.findByProps({ className: 'dsh-tavern-charCardBody' }).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    // 添加一条空备选开场白并给第一条加首尾空白
    const addBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('characters.detail.addGreeting'))!
    await act(async () => { addBtn.props.onClick() })
    const altAreas = () => view.root.findAllByProps({ className: 'dsh-tavern-greetingEntry' }).map((n) => n.findByType('textarea'))
    await act(async () => {
      altAreas()[0]!.props.onChange({ target: { value: '  清理后的备选  ' } })
    })
    await act(async () => {
      altAreas()[1]!.props.onChange({ target: { value: '   ' } })
    })

    const saveBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('action.save'))!
    expect(saveBtn().props.disabled).toBe(false)
    await act(async () => {
      saveBtn().props.onClick()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })

    expect(saveCharacter).toHaveBeenCalledWith(expect.objectContaining({
      alternateGreetings: ['清理后的备选'],
    }))
    expect(saveBtn().props.disabled).toBe(true)
    expect(textOf(view.root)).not.toContain(t('draft.unsaved'))

    // 关闭弹窗不再触发放弃未保存确认框
    const detailDialog = view.root.findAllByType(Dialog).find((d) => d.props.width === 'xl')!
    await act(async () => { detailDialog.props.onClose() })
    expect(view.root.findAllByType(ConfirmDialog).some((c) => c.props.open)).toBe(false)
  })

  it('恢复草稿在首次加载失败时直接保存成功后，preserveRestored 复位且后续重载不误报未保存', async () => {
    const cardId = 'card-restored-save'
    invalidateCharacter(cardId)
    const restoredDraft = makeDetail(cardId, '恢复角色', {
      revision: '3'.repeat(64),
      description: '已恢复的新描述',
      alternateGreetings: ['  恢复开场  ', ''],
    })
    let serverCard = makeDetail(cardId, '恢复角色', {
      revision: '3'.repeat(64),
      description: '旧描述',
    })
    let detailCalls = 0
    const getCharacterDetail = vi.fn(async () => {
      detailCalls++
      if (detailCalls === 1) return fail('首次详情读取失败')
      return ok(structuredClone(serverCard))
    })
    const saveCharacter = vi.fn(async (req: { description?: string; alternateGreetings?: string[] }) => {
      serverCard = {
        ...serverCard,
        revision: '4'.repeat(64),
        description: req.description ?? serverCard.description,
        alternateGreetings: req.alternateGreetings ?? serverCard.alternateGreetings,
        extensions: { serverTouched: true },
      }
      return ok({ cardId, name: serverCard.name, revision: serverCard.revision })
    })
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, '恢复角色')] })),
      getCharacterDetail,
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      saveCharacter,
      getEditorDraft: vi.fn(async () => ok({
        draft: {
          value: {
            version: 1,
            fields: {
              'characters:detailId': cardId,
              [`characters.detail:${cardId}`]: restoredDraft,
            },
          },
          updatedAt: new Date(0).toISOString(),
        },
      })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const view = await mount(createElement(PersistentEditor, { remote, scope: 'characters' }, createElement(CharactersSection, { remote })))
    const saveBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('action.save'))!
    expect(saveBtn().props.disabled).toBe(false)

    await act(async () => {
      saveBtn().props.onClick()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(saveCharacter).toHaveBeenCalledOnce()
    expect(saveBtn().props.disabled).toBe(true)
    expect(textOf(view.root)).not.toContain(t('draft.unsaved'))
  })

  it('Bug #10a: depthPrompt 清空后再重新输入时恢复用户此前选择的 depth 与 role', async () => {
    const cardId = 'card-depth-memory'
    invalidateCharacter(cardId)
    const card = makeDetail(cardId, '深度角色', { depthPrompt: null })
    const saveCharacter = vi.fn(async () => ok({ cardId, name: card.name, revision: 'b'.repeat(64) }))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, card.name)] })),
      getCharacterDetail: vi.fn(async () => ok(card)),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      saveCharacter,
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))
    await act(async () => {
      view.root.findByProps({ className: 'dsh-tavern-charCardBody' }).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const depthArea = () => {
      const areas = view.root.findAllByType('textarea')
      return areas.find((a) => {
        const labelId = a.props['aria-labelledby'] as string | undefined
        if (!labelId) return false
        return textOf(view.root.findByProps({ id: labelId })) === t('characters.detail.depthPrompt')
      })!
    }

    // 首次输入 -> 修改 depth=2、role='user'
    await act(async () => { depthArea().props.onChange({ target: { value: '第一版深度指令' } }) })
    await act(async () => { view.root.findByType(NumInput).props.onChange(2) })
    await act(async () => { view.root.findByType(Select).props.onChange('user') })

    // 清空正文 -> 深度与角色控件收起
    await act(async () => { depthArea().props.onChange({ target: { value: '' } }) })
    expect(view.root.findAllByType(NumInput)).toHaveLength(0)

    // 重新输入 -> 必须恢复 depth=2、role='user'，不能退回 4 / system
    await act(async () => { depthArea().props.onChange({ target: { value: '第二版深度指令' } }) })
    expect(view.root.findByType(NumInput).props.value).toBe(2)
    expect(view.root.findByType(Select).props.value).toBe('user')

    await act(async () => {
      view.root.findAllByType(Btn).find((b) => b.props.children === t('action.save'))!.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(saveCharacter).toHaveBeenCalledWith(expect.objectContaining({
      depthPrompt: { prompt: '第二版深度指令', depth: 2, role: 'user' },
    }))
  })

  it('Bug #10a: 初始已携带 depthPrompt 的角色清空重填后也保留原有 depth 与 role', async () => {
    const cardId = 'card-depth-loaded'
    invalidateCharacter(cardId)
    const card = makeDetail(cardId, '既有深度角色', {
      depthPrompt: { prompt: '原始深度指令', depth: 7, role: 'assistant' },
    })
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, card.name)] })),
      getCharacterDetail: vi.fn(async () => ok(card)),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      saveCharacter: vi.fn(async () => ok({ cardId, name: card.name, revision: 'c'.repeat(64) })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))
    await act(async () => {
      view.root.findByProps({ className: 'dsh-tavern-charCardBody' }).props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const depthArea = () => view.root.findAllByType('textarea').find((a) => {
      const labelId = a.props['aria-labelledby'] as string | undefined
      return Boolean(labelId) && textOf(view.root.findByProps({ id: labelId })) === t('characters.detail.depthPrompt')
    })!

    await act(async () => { depthArea().props.onChange({ target: { value: '' } }) })
    await act(async () => { depthArea().props.onChange({ target: { value: '替换后的深度指令' } }) })
    expect(view.root.findByType(NumInput).props.value).toBe(7)
    expect(view.root.findByType(Select).props.value).toBe('assistant')
  })
})

describe('Bug #7, #8, #9 & #10b: CharactersSection 导入校验、空态互斥、错误清理与文案', () => {
  it('Bug #7: 前置拒绝 0 字节文件与超过 24 MiB 的 JSON 文件，不调用 fileToBase64 与 inspectCharacter', async () => {
    const inspectCharacter = vi.fn(async () => ok(makeInspect('正常卡')))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [] })),
      inspectCharacter,
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))

    const emptyJson = new File([], 'empty.json', { type: 'application/json' })
    await act(async () => {
      view.root.findByType(FileBtn).props.onFile(emptyJson)
      await Promise.resolve()
    })
    expect(fileToBase64).not.toHaveBeenCalled()
    expect(inspectCharacter).not.toHaveBeenCalled()
    expect(view.root.findAllByType(Err).some((e) => e.props.message === t('characters.fileEmpty'))).toBe(true)

    const emptyPng = new File([], 'empty.png', { type: 'image/png' })
    await act(async () => {
      view.root.findByType(FileBtn).props.onFile(emptyPng)
      await Promise.resolve()
    })
    expect(fileToBase64).not.toHaveBeenCalled()
    expect(inspectCharacter).not.toHaveBeenCalled()

    const hugeJson = new File(['{}'], 'huge.json', { type: 'application/json' })
    Object.defineProperty(hugeJson, 'size', { value: 24 * 1024 * 1024 + 1 })
    await act(async () => {
      view.root.findByType(FileBtn).props.onFile(hugeJson)
      await Promise.resolve()
    })
    expect(fileToBase64).not.toHaveBeenCalled()
    expect(inspectCharacter).not.toHaveBeenCalled()
    expect(view.root.findAllByType(Err).some((e) => e.props.message === t('characters.jsonFileTooLarge', { limit: 24 }))).toBe(true)
  })

  it('Bug #8: 空列表且保留非空搜索词时只渲染空集合状态，不与 SearchEmpty 同时出现', async () => {
    const activeItems = Array.from({ length: 5 }, (_, i) => makeSummary(`c-${i}`, `角色${i}`))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: activeItems })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))
    await act(async () => {
      view.root.findByType(SearchInput).props.onChange('不会命中的关键字')
    })
    // 有卡片但未命中：只显示 SearchEmpty
    expect(view.root.findAllByType(SearchEmpty)).toHaveLength(1)

    // 切到空收纳箱：只显示空收纳箱状态，不渲染 SearchEmpty
    await act(async () => {
      view.root.findByType(Tabs).props.onChange('archived')
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(view.root.findAllByType(SearchEmpty)).toHaveLength(0)
    expect(view.root.findAllByProps({ className: 'dsh-tavern-empty' })).toHaveLength(1)
    expect(textOf(view.root)).toContain(t('characters.archive.emptyTitle'))
  })

  it('Bug #9: 导入预检弹窗失败后经 Dialog.onClose 关闭时同步清除 error，不泄漏到主页面', async () => {
    const inspectCharacter = vi.fn(async () => ok(makeInspect('失败测试卡')))
    const importCharacter = vi.fn(async () => fail('导入时模拟磁盘写满'))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [] })),
      inspectCharacter,
      importCharacter,
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))
    const cardFile = new File([JSON.stringify({ name: '失败测试卡' })], 'fail.json', { type: 'application/json' })
    await act(async () => {
      view.root.findByType(FileBtn).props.onFile(cardFile)
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    const previewDialog = () => view.root.findAllByType(Dialog).find((d) => d.props.title === t('characters.importPreview.title'))
    expect(previewDialog()).toBeDefined()
    const importBtn = previewDialog()!.findAllByType('button').find((b) => textOf(b) === t('characters.importPreview.import'))!
    await act(async () => {
      importBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(previewDialog()!.findAllByType(Err).some((e) => e.props.message === '导入时模拟磁盘写满')).toBe(true)

    // 通过 Dialog.onClose（Esc / 右上角关闭）关闭弹窗：主页面不再残留旧导入报错
    await act(async () => {
      previewDialog()!.props.onClose()
    })
    expect(previewDialog()).toBeUndefined()
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })

  it('Bug #10b: characters.detail.altGreetings 中英文文案已去除过时的「每行一条」说明', () => {
    expect(charactersZh['characters.detail.altGreetings']).toBe('开场白变体')
    expect(charactersEn['characters.detail.altGreetings']).toBe('Alternate greetings')
  })
})

describe('Bug #11: MemorySection 展示与选择已收纳角色', () => {
  it('MemorySection 在下拉与剧情上下文标题中展示已收纳角色「…（已收纳）」，不暴露原始 cardId 或通用「角色」，并支持切换回选', async () => {
    const archivedId = '星野凛-5849b162'
    const activeId = '灯塔-10293847'
    const storyId = 'story-rin-1'
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(activeId, '灯塔')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [makeArchivedSummary(archivedId, '星野凛')] })),
      listStories: vi.fn(async ({ cardId }: { cardId: string }) => ok({
        items: cardId === archivedId
          ? [{ id: storyId, sessionId: 'sess-rin', createdAt: '2026-02-01T00:00:00.000Z', migrated: false }]
          : [],
      })),
      getMemories: vi.fn(async () => ok({ items: [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: [] })),
      getJournal: vi.fn(async () => ok({ text: '', revision: 'rev-j1' })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const view = await mount(createElement(MemorySection, {
      remote,
      initialContext: { cardId: archivedId, storyId },
    }))

    const expectedArchivedLabel = t('characters.archivedName', { name: '星野凛' })
    const charSelect = () => view.root.findAllByType(Select)[0]!
    const selectLabel = () => textOf(charSelect().findByProps({ className: 'dsh-tavern-pillSelectLabel' }))
    const contextHeading = () => textOf(view.root.findByProps({ className: 'dsh-tavern-storyContextTitle' }).findByType('strong'))

    expect(selectLabel()).toBe(expectedArchivedLabel)
    expect(selectLabel()).not.toContain(archivedId)
    expect(selectLabel()).not.toBe(t('memory.character'))
    expect(contextHeading()).toBe(expectedArchivedLabel)
    expect(contextHeading()).not.toContain(archivedId)
    expect(contextHeading()).not.toBe(t('memory.character'))

    // 下拉包含已收纳角色，切去活跃角色后仍可重新选回该已收纳角色
    const options = charSelect().props.options as Array<{ value: string; label: string }>
    expect(options).toContainEqual({ value: archivedId, label: expectedArchivedLabel })

    await act(async () => {
      charSelect().props.onChange(activeId)
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(selectLabel()).toBe('灯塔')
    expect(contextHeading()).toBe('灯塔')

    await act(async () => {
      charSelect().props.onChange(archivedId)
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(selectLabel()).toBe(expectedArchivedLabel)
    expect(contextHeading()).toBe(expectedArchivedLabel)
  })

  it('MemorySection 兼容缺少 listArchivedCharacters 的远端，预填已收纳会话绑定时显示卡名而不暴露 cardId', async () => {
    const sessionId = 'session-memory-archived-compat'
    const archivedId = '星野凛-legacy-01'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const remote = {
      getSessionBinding: vi.fn(async () => ok({
        binding: { ...defaultBinding(sessionId, archivedId), cardName: '星野凛', storyId: 'story-legacy' },
        userName: '旅人',
        canSwipeGreeting: false,
        conversationStarted: true,
      })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listStories: vi.fn(async () => ok({
        items: [{ id: 'story-legacy', sessionId, createdAt: '2026-02-01T00:00:00.000Z', migrated: false }],
      })),
      getMemories: vi.fn(async () => ok({ items: [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: [] })),
      getJournal: vi.fn(async () => ok({ text: '', revision: 'rev-j2' })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const view = await mount(createElement(MemorySection, { remote }))
    const charSelect = view.root.findAllByType(Select)[0]!
    const selectedLabel = textOf(charSelect.findByProps({ className: 'dsh-tavern-pillSelectLabel' }))
    const contextHeading = textOf(view.root.findByProps({ className: 'dsh-tavern-storyContextTitle' }).findByType('strong'))

    expect(selectedLabel).toBe('星野凛')
    expect(selectedLabel).not.toContain(archivedId)
    expect(contextHeading).toBe('星野凛')
    expect(contextHeading).not.toBe(t('memory.character'))
  })
})

describe('Bug #12: CharacterCard 无嵌套交互元素且保留打开与收纳行为', () => {
  function assertNoNestedInteractiveButtons(root: ReactTestInstance) {
    const isInteractiveButton = (node: ReactTestInstance) =>
      typeof node.type === 'string' && (node.type === 'button' || node.props.role === 'button')
    const walk = (node: ReactTestInstance, insideInteractiveButton: boolean) => {
      const currentInteractive = isInteractiveButton(node)
      if (insideInteractiveButton && currentInteractive) {
        throw new Error(`发现嵌套交互按钮：<${String(node.type)} className="${String(node.props.className ?? '')}">`)
      }
      for (const child of node.children) {
        if (typeof child !== 'string') walk(child, insideInteractiveButton || currentInteractive)
      }
    }
    walk(root, false)
  }

  it('活跃卡与收纳箱卡均无嵌套 button / role="button"，点击收纳不触发详情弹窗，点击卡身打开详情', async () => {
    const activeId = 'card-a11y-active'
    const archivedId = 'card-a11y-archived'
    invalidateCharacter(activeId)
    const getCharacterDetail = vi.fn(async () => ok(makeDetail(activeId, '无障碍角色')))
    const archiveCharacter = vi.fn(async () => ok({ archived: true }))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(activeId, '无障碍角色')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [makeArchivedSummary(archivedId, '已收纳无障碍角色')] })),
      getCharacterDetail,
      archiveCharacter,
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CharactersSection, { remote }))

    // 活跃卡：外层 article 不带 role="button"/tabIndex，且内部不存在嵌套交互按钮
    const activeArticle = view.root.findByProps({ className: 'dsh-tavern-charCard' })
    expect(activeArticle.type).toBe('article')
    expect(activeArticle.props.role).toBeUndefined()
    expect(activeArticle.props.tabIndex).toBeUndefined()
    assertNoNestedInteractiveButtons(activeArticle)

    // 点击收纳按钮：触发 archiveCharacter，不触发 getCharacterDetail 或详情弹窗
    const archiveBtn = activeArticle.findByProps({ 'aria-label': t('characters.card.archive') })
    await act(async () => {
      archiveBtn.props.onClick({ stopPropagation: () => {} })
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(archiveCharacter).toHaveBeenCalledExactlyOnceWith({ cardId: activeId })
    expect(getCharacterDetail).not.toHaveBeenCalled()
    expect(view.root.findAllByType(Dialog).filter((d) => d.props.open)).toHaveLength(0)

    // 点击卡身按钮：打开角色详情弹窗
    const bodyBtn = view.root.findByProps({ className: 'dsh-tavern-charCardBody' })
    expect(bodyBtn.type).toBe('button')
    await act(async () => {
      bodyBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(getCharacterDetail).toHaveBeenCalledExactlyOnceWith({ cardId: activeId })
    expect(view.root.findAllByType(Dialog).some((d) => d.props.open && d.props.width === 'xl')).toBe(true)

    // 切到收纳箱：外层 article 同样无嵌套交互按钮，卡身为只读 div
    await act(async () => {
      view.root.findByType(Tabs).props.onChange('archived')
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const archivedArticle = view.root.findByProps({ className: 'dsh-tavern-charCard is-archived' })
    expect(archivedArticle.props.role).toBeUndefined()
    expect(archivedArticle.findByProps({ className: 'dsh-tavern-charCardBody' }).type).toBe('div')
    assertNoNestedInteractiveButtons(archivedArticle)
  })
})
