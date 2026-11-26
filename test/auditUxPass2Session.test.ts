/**
 * 会话与面板实机审计 Pass 2 行为回归测试：
 * 1. TavernHeaderChip「触发日志」子弹窗走真实 Dialog（role="dialog" aria-modal="true"）且日志区可键盘聚焦；
 *    绑定弹窗两个开关（injectJournal / helperMvu）暴露无障碍名称；ConfirmDialog 关闭钮与取消钮文案区分。
 * 2. CardDataSettings 先渲染 StoryVariableSettings（或选剧情提示）再渲染 SessionTransfer；
 *    VariableBackupEditor 在备份框为空/纯空白时隐藏取消按钮，输入后显示并支持放弃清空。
 * 3. MemorySection 嵌入模式（initialContext）省略重复 <h3> 标题、活跃记忆 < 2 时禁用「归并最旧一批」、
 *    记忆与世界状态时间戳本地化展示并保留 ISO title、仅有 1 条已撤销世界状态时即展示状态筛选芯片。
 * 4. AboutSection 兼容说明与链接之间保留空格不粘连（中英双语），以及 styles.ts 的共享样式契约。
 */
import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { AboutSection } from '../src/client/panel/about.js'
import { CardDataSettings, SessionTransfer, StoryVariableSettings, VariableBackupEditor } from '../src/client/panel/cardData.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { ensureTavernStyles } from '../src/client/styles.js'
import type { CharacterDetail, CharacterSummary, Envelope, SessionBinding, TavernRemote } from '../src/client/types.js'
import { Btn, ConfirmDialog, Dialog, Select } from '../src/client/util.js'
import type { MemoryEntry, WorldDelta } from '../src/core/types.js'
import type { PluginAbout } from '../src/node/pluginAbout.js'

/** 忠实还原宿主 Modal 的 ARIA 结构（role="dialog"、aria-modal、aria-label、h2 与关闭钮 aria-label）。 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => createElement('button', props),
  Modal: (props: {
    open: boolean
    title: string
    closeLabel?: string
    description?: string
    onClose?: () => void
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
  }) =>
    props.open
      ? createElement(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title,
            className: props.className,
          },
          createElement(
            'div',
            { className: props.contentClassName },
            createElement(
              'div',
              null,
              createElement('h2', null, props.title),
              createElement('button', { type: 'button', 'aria-label': props.closeLabel, onClick: props.onClose }, '×'),
            ),
            props.description ? createElement('p', null, props.description) : null,
            createElement('div', null, props.children),
          ),
          props.footer ? createElement('div', null, props.footer) : null,
        )
      : null,
  Tooltip: (props: { children?: ReactNode }) => createElement(Fragment, null, props.children),
  Toast: (props: { text: string }) => createElement('div', { role: 'status' }, props.text),
  Menu: (props: { anchor?: ReactNode }) => createElement(Fragment, null, props.anchor),
  IconChevronDownOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })

const mounted: ReactTestRenderer[] = []
const cleanups: Array<() => void> = []
let injectedStyleText = ''

function textOf(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return node.children.map((child) => textOf(child)).join('')
}

function makeSummary(cardId: string, name: string): CharacterSummary {
  return {
    cardId,
    name,
    creator: '',
    tags: [],
    hasAvatar: false,
    hasCharacterBook: false,
    characterBookName: null,
    characterBookEntryCount: 0,
  }
}

function makeDetail(cardId: string, name: string): CharacterDetail {
  return {
    cardId,
    revision: 'a'.repeat(64),
    name,
    description: '',
    personality: '',
    scenario: '',
    firstMes: '你好。',
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
  }
}

function makeMemory(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    body: `记忆正文 ${id}`,
    tags: [],
    keys: [],
    updated: '2026-09-05T14:30:00.000Z',
    archived: false,
    ...overrides,
  }
}

function makeDelta(id: number, overrides: Partial<WorldDelta> = {}): WorldDelta {
  return {
    id,
    type: 'add',
    content: `世界状态变化 ${id}`,
    ref: null,
    keys: [],
    ts: '2026-09-06T08:15:00.000Z',
    revoked: false,
    ...overrides,
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
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  mounted.push(view)
  return view
}

beforeEach(() => {
  setTavernLocale('zh')
  vi.clearAllMocks()
  injectedStyleText = ''
  const storage = new Map<string, string>([['dsh-tavern-editor-owner', 'audit-pass2-owner']])
  const win = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  })
  vi.stubGlobal('window', win)
  const elements = new Map<string, { id: string; textContent: string }>()
  vi.stubGlobal('document', {
    body: {},
    documentElement: {},
    head: {
      appendChild: (el: { id: string; textContent: string }) => {
        elements.set(el.id, el)
        injectedStyleText = el.textContent
      },
    },
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: () => [],
  })
})

afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => view.unmount())
  }
  while (cleanups.length > 0) cleanups.pop()!()
  vi.unstubAllGlobals()
  setTavernLocale('zh')
})

describe('1. HeaderChip 触发日志弹窗、绑定开关无障碍名称与 ConfirmDialog 标签区分', () => {
  it('触发日志子弹窗走真实 Dialog（role="dialog" aria-modal="true"）且绑定开关暴露明确无障碍名称', async () => {
    const sessionId = 'session-pass2-chip'
    const cardId = 'card-pass2-chip'
    invalidateSessionBinding(sessionId)
    invalidateCharacter(cardId)

    const binding: SessionBinding = {
      ...defaultBinding(sessionId, cardId),
      cardName: '雾岛汐',
      storyId: 'story-pass2-1',
      injectJournal: true,
      helperMvu: false,
    }
    const getTriggerLog = vi.fn(async () =>
      ok({ log: { at: '2026-09-05T10:00:00.000Z', lines: ['[WI] 命中 雾港灯塔'] } }),
    )
    const previewPrompt = vi.fn(async () => ok({
      system: 'sys',
      messages: [],
      standing: 'standing',
      turnContext: 'turn',
      logLines: [],
      worldInfoBudget: { used: 0, limit: 1000, overflowed: false },
      assembleBudget: { tokensBefore: 10, tokensAfter: 10, trimmedSections: [] },
      actualRequest: null,
      cacheUsage: { turns: [], total: { steps: 0, hitRate: null, uncachedInput: 0, cacheRead: 0, output: 0 } },
    }))
    const getChatLorebook = vi.fn(async () => ok({ json: { entries: {} }, revision: 'rev-chat-lore' }))
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: true, conversationStarted: true })),
      getCharacterDetail: vi.fn(async () => ok(makeDetail(cardId, '雾岛汐'))),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, '雾岛汐')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
      getTriggerLog,
      previewPrompt,
      getChatLorebook,
      listStories: vi.fn(async () => ok({ items: [{ id: 'story-pass2-1', sessionId, createdAt: '2026-09-05T00:00:00.000Z', migrated: false }] })),
      getMemories: vi.fn(async () => ok({ items: [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: [] })),
      getJournal: vi.fn(async () => ok({ text: '', revision: 'rev-j' })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
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

    // 父级 Tavern 绑定弹窗位于基础层，不挂子弹窗层叠类
    const bindingDialog = view.root.findAllByProps({ role: 'dialog' }).find((d) => d.props['aria-label'] === t('chip.dialog.title'))!
    expect(bindingDialog).toBeDefined()
    expect(String(bindingDialog.props.className)).not.toContain('dsh-tavern-modal-sub')

    // 绑定弹窗中的两个 switch 必须分别拥有显式无障碍标签
    const switches = view.root.findAllByProps({ role: 'switch' })
    expect(switches).toHaveLength(2)
    expect(switches[0]!.props['aria-label']).toBe(t('chip.field.injectJournal'))
    expect(switches[0]!.props.title).toBe(t('chip.field.injectJournal'))
    expect(switches[0]!.props['aria-checked']).toBe(true)
    expect(switches[1]!.props['aria-label']).toBe(t('chip.field.helperMvu'))
    expect(switches[1]!.props.title).toBe(t('chip.field.helperMvu'))
    expect(switches[1]!.props['aria-checked']).toBe(false)

    // 点击「触发日志」打开子弹窗，验证 role="dialog"、aria-modal="true"、dsh-tavern-modal-sub 与可聚焦 pre
    const logBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('binding.triggerLog'))!
    await act(async () => {
      logBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(getTriggerLog).toHaveBeenCalledExactlyOnceWith({ sessionId })
    const logDialogWrapper = view.root.findAllByType(Dialog).find((d) => d.props.title === t('binding.triggerLog') && d.props.open)
    expect(logDialogWrapper).toBeDefined()
    expect(logDialogWrapper!.props.width).toBe('lg')
    expect(logDialogWrapper!.props.layer).toBe('sub')
    const logDialog = view.root.findAllByProps({ role: 'dialog' }).find((d) => d.props['aria-label'] === t('binding.triggerLog'))
    expect(logDialog).toBeDefined()
    expect(logDialog!.props['aria-modal']).toBe('true')
    expect(String(logDialog!.props.className)).toContain('dsh-tavern-modal-sub')
    const pre = logDialog!.findByType('pre')
    expect(pre.props.tabIndex).toBe(0)
    expect(textOf(pre)).toContain('[WI] 命中 雾港灯塔')

    // 关闭触发日志子弹窗，不影响父级 Tavern 绑定弹窗
    const closeLogBtn = logDialog!.findByProps({ 'aria-label': t('action.close') })
    await act(async () => { closeLogBtn.props.onClick() })
    expect(view.root.findAllByProps({ role: 'dialog' }).some((d) => d.props['aria-label'] === t('binding.triggerLog'))).toBe(false)
    expect(view.root.findAllByProps({ role: 'dialog' }).some((d) => d.props['aria-label'] === t('chip.dialog.title'))).toBe(true)

    // 打开「提示词预览」子弹窗：挂 dsh-tavern-modal-sub 以叠在绑定弹窗之上
    const previewBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('binding.preview'))!
    await act(async () => {
      previewBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const previewDialog = view.root.findAllByProps({ role: 'dialog' }).find((d) => d.props['aria-label'] === t('chip.preview.title'))!
    expect(previewDialog).toBeDefined()
    expect(String(previewDialog.props.className)).toContain('dsh-tavern-modal-sub')
    await act(async () => { previewDialog.findByProps({ 'aria-label': t('action.close') }).props.onClick() })

    // 打开「本会话世界书」子弹窗：挂 dsh-tavern-modal-sub 且向 LorebookEditor 传递 hideCloseButton（不渲染重复关闭/返回钮）
    const chatLoreBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('chip.chatLore.edit'))!
    await act(async () => {
      chatLoreBtn.props.onClick()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(getChatLorebook).toHaveBeenCalledExactlyOnceWith({ cardId, storyId: 'story-pass2-1' })
    const chatLoreDialog = view.root.findAllByProps({ role: 'dialog' }).find((d) => d.props['aria-label'] === t('chip.chatLore.title'))!
    expect(chatLoreDialog).toBeDefined()
    expect(String(chatLoreDialog.props.className)).toContain('dsh-tavern-modal-sub')
    const loreEditor = chatLoreDialog.findByType(LorebookEditor)
    expect(loreEditor.props.hideCloseButton).toBe(true)
    const chatLoreBtnLabels = chatLoreDialog.findAllByType(Btn).map((b) => String(b.props.children))
    expect(chatLoreBtnLabels).not.toContain(t('action.close'))
    expect(chatLoreBtnLabels).not.toContain(t('lorebookEditor.back'))
    await act(async () => { chatLoreDialog.findByProps({ 'aria-label': t('action.close') }).props.onClick() })

    // 从绑定弹窗打开「记忆与世界状态」子弹窗：挂 dsh-tavern-modal-sub 且只保留 Dialog 的 <h2>，不重复渲染 <h3>
    const memoryBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('section.memory'))!
    await act(async () => {
      memoryBtn.props.onClick()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    const memoryDialog = view.root.findAllByProps({ role: 'dialog' }).find((d) => d.props['aria-label'] === t('section.memory'))!
    expect(memoryDialog).toBeDefined()
    expect(String(memoryDialog.props.className)).toContain('dsh-tavern-modal-sub')
    expect(memoryDialog.findAllByType('h2').map((h) => textOf(h))).toEqual([t('section.memory')])
    expect(memoryDialog.findAllByType('h3')).toHaveLength(0)
  })

  it('ConfirmDialog 区分右上角关闭按钮（关闭/Close）与底部取消按钮（取消/Cancel），并标记确认弹窗层叠类', async () => {
    for (const locale of ['zh', 'en'] as const) {
      setTavernLocale(locale)
      const onCancel = vi.fn()
      const onConfirm = vi.fn()
      const view = await mount(createElement(ConfirmDialog, {
        open: true,
        title: 'Confirm title',
        description: 'Confirm desc',
        onCancel,
        onConfirm,
      }))
      const dialog = view.root.findByProps({ role: 'dialog' })
      expect(String(dialog.props.className)).toContain('dsh-tavern-modal-confirm')
      const buttons = dialog.findAllByType('button')
      const headerClose = buttons.find((b) => b.props['aria-label'] === t('action.close'))
      const footerCancel = buttons.find((b) => textOf(b) === t('action.cancel'))
      expect(headerClose).toBeDefined()
      expect(footerCancel).toBeDefined()
      expect(headerClose).not.toBe(footerCancel)
      // 不存在第二个标为「取消 / Cancel」的按钮
      const cancelLabeled = buttons.filter((b) => b.props['aria-label'] === t('action.cancel') || textOf(b) === t('action.cancel'))
      expect(cancelLabeled).toHaveLength(1)
    }
  })
})

describe('2. CardDataSettings 分区顺序与 VariableBackupEditor 空态取消按钮', () => {
  function findChildOrder(root: ReactTestInstance, targets: Array<unknown>): number[] {
    const order: number[] = []
    const walk = (node: ReactTestInstance) => {
      const idx = targets.indexOf(node.type)
      if (idx >= 0) order.push(idx)
      for (const child of node.children) {
        if (typeof child !== 'string') walk(child)
      }
    }
    walk(root)
    return order
  }

  it('CardDataSettings 先渲染 StoryVariableSettings，再将 SessionTransfer 排在其下方', async () => {
    const sessionId = 'session-carddata-order'
    const cardId = 'card-data-1'
    const storyId = 'story-data-1'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const remote = {
      getSessionBinding: vi.fn(async () => ok({
        binding: { ...defaultBinding(sessionId, cardId), cardName: '雾岛汐', storyId },
        userName: '旅人',
        canSwipeGreeting: false,
        conversationStarted: true,
      })),
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, '雾岛汐')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listStories: vi.fn(async () => ok({
        items: [{ id: storyId, sessionId, createdAt: '2026-09-05T12:00:00.000Z', migrated: false }],
      })),
      listSessionImportWorkspaces: vi.fn(async () => ok({ items: [] })),
      getHelperEventState: vi.fn(async () => ok({
        storyId,
        historyRevision: 'rev-1',
        messages: [{ seq: 2, message_id: 0, role: 'assistant' as const }],
        writable: true,
        closedThrough: 2,
      })),
      getHelperSnapshot: vi.fn(async () => ok({
        storyId,
        historyRevision: 'rev-1',
        currentMessageId: 0,
        writable: true,
        scopes: { '["chat",""]': { hp: 10 } },
        messages: [],
      })),
    } as unknown as TavernRemote

    const view = await mount(createElement(CardDataSettings, { remote }))
    const order = findChildOrder(view.root, [StoryVariableSettings, SessionTransfer])
    expect(order).toEqual([0, 1])

    // 取消选择剧情后，提示文案仍出现在 SessionTransfer 之前
    const storySelect = view.root.findAllByType(Select)[1]!
    await act(async () => {
      storySelect.props.onChange('')
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    const fullText = textOf(view.root)
    expect(fullText.indexOf(t('settings.cards.variableChooseStory'))).toBeGreaterThan(-1)
    expect(fullText.indexOf(t('sessionArchive.title'))).toBeGreaterThan(fullText.indexOf(t('settings.cards.variableChooseStory')))
  })

  it('VariableBackupEditor 文本框为空或纯空白时隐藏取消按钮，输入后显示并可确认清空', async () => {
    const snapshot = {
      storyId: 'story-backup-1',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: true,
      messages: [],
      scopes: { '["chat",""]': { hp: 1 } },
    }
    const remote = { commitHelperVariables: vi.fn(), getHelperSnapshot: vi.fn() } as unknown as TavernRemote
    const view = await mount(createElement(VariableBackupEditor, {
      remote,
      sessionId: 'session-backup-1',
      messageId: 10,
      snapshot,
      onRefresh: () => {},
    }))

    const findCancel = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('action.cancel'))
    expect(findCancel()).toBeUndefined()

    // 纯空白仍不显示取消按钮
    await act(async () => {
      view.root.findByType('textarea').props.onChange({ target: { value: '   \n\t  ' } })
    })
    expect(findCancel()).toBeUndefined()

    // 输入有效文本后取消按钮出现且可点击
    await act(async () => {
      view.root.findByType('textarea').props.onChange({ target: { value: '{"version":1,"scopes":{}}' } })
    })
    const cancelBtn = findCancel()
    expect(cancelBtn).toBeDefined()
    expect(cancelBtn!.props.disabled).toBe(false)

    // 点击取消触发草稿放弃确认，确认后清空并再次隐藏取消按钮
    await act(async () => { cancelBtn!.props.onClick() })
    const confirmLeave = view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!
    await act(async () => { confirmLeave.props.onConfirm() })
    expect(view.root.findByType('textarea').props.value).toBe('')
    expect(findCancel()).toBeUndefined()
  })
})

describe('3. MemorySection 嵌入去重标题、归并按钮门槛、本地化时间与单条撤销筛选', () => {
  function makeMemoryRemote(options: {
    memories?: MemoryEntry[]
    deltas?: WorldDelta[]
    compressMemories?: TavernRemote['compressMemories']
  } = {}) {
    const cardId = 'card-mem-1'
    const storyId = 'story-mem-1'
    const compressMemories = vi.fn(options.compressMemories ?? (async () => ok({ merged: 2 })))
    const remote = {
      listCharacters: vi.fn(async () => ok({ items: [makeSummary(cardId, '雾岛汐')] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listStories: vi.fn(async () => ok({
        items: [{ id: storyId, sessionId: 'sess-mem-1', createdAt: '2026-09-05T00:00:00.000Z', migrated: false }],
      })),
      getMemories: vi.fn(async () => ok({ items: options.memories ?? [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: options.deltas ?? [] })),
      getJournal: vi.fn(async () => ok({ text: '', revision: 'rev-1' })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      compressMemories,
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote
    return { remote, cardId, storyId, compressMemories }
  }

  it('独立设置面板保留 <h3> 标题，嵌入模式（initialContext）省略重复 <h3> 标题', async () => {
    const { remote, cardId, storyId } = makeMemoryRemote()
    const standalone = await mount(createElement(MemorySection, { remote }))
    expect(standalone.root.findAllByType('h3').map((h) => textOf(h))).toEqual([t('section.memory')])

    const embedded = await mount(createElement(MemorySection, { remote, initialContext: { cardId, storyId } }))
    expect(embedded.root.findAllByType('h3')).toHaveLength(0)
    expect(textOf(embedded.root)).toContain(t('memory.desc'))
  })

  it('活跃记忆少于 2 条时禁用「归并最旧一批」，达到 2 条活跃记忆后启用并可调用压缩', async () => {
    // 0 条记忆 -> 禁用
    const r0 = makeMemoryRemote({ memories: [] })
    const v0 = await mount(createElement(MemorySection, { remote: r0.remote, initialContext: { cardId: r0.cardId, storyId: r0.storyId } }))
    expect(v0.root.findAllByType(Btn).find((b) => b.props.children === t('memory.compressOldest'))!.props.disabled).toBe(true)

    // 1 条活跃 + 2 条已归档（总计 3 条但仅 1 条活跃） -> 仍禁用
    const r1 = makeMemoryRemote({
      memories: [
        makeMemory('m-active-1', { archived: false }),
        makeMemory('m-arc-1', { archived: true }),
        makeMemory('m-arc-2', { archived: true }),
      ],
    })
    const v1 = await mount(createElement(MemorySection, { remote: r1.remote, initialContext: { cardId: r1.cardId, storyId: r1.storyId } }))
    expect(v1.root.findAllByType(Btn).find((b) => b.props.children === t('memory.compressOldest'))!.props.disabled).toBe(true)

    // 2 条活跃记忆 -> 启用且点击触发 compressMemories
    const r2 = makeMemoryRemote({
      memories: [makeMemory('m-1'), makeMemory('m-2')],
    })
    const v2 = await mount(createElement(MemorySection, { remote: r2.remote, initialContext: { cardId: r2.cardId, storyId: r2.storyId } }))
    const compressBtn = v2.root.findAllByType(Btn).find((b) => b.props.children === t('memory.compressOldest'))!
    expect(compressBtn.props.disabled).toBe(false)
    await act(async () => {
      compressBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(r2.compressMemories).toHaveBeenCalledExactlyOnceWith({ cardId: r2.cardId, storyId: r2.storyId })
  })

  it('记忆与世界状态时间戳按本地格式展示并保留原始 ISO title，非法时间字符串安全回退', async () => {
    const isoMemory = '2026-09-05T14:30:00.000Z'
    const isoDelta = '2026-09-06T08:15:00.000Z'
    const badTs = 'not-a-valid-date'
    const { remote, cardId, storyId } = makeMemoryRemote({
      memories: [
        makeMemory('m-iso', { updated: isoMemory }),
        makeMemory('m-bad', { updated: badTs }),
      ],
      deltas: [
        makeDelta(1, { ts: isoDelta }),
        makeDelta(2, { ts: badTs }),
      ],
    })

    const view = await mount(createElement(MemorySection, { remote, initialContext: { cardId, storyId } }))
    const memMetas = view.root.findAllByProps({ className: 'dsh-tavern-memoMeta' })
    expect(memMetas[0]!.props.title).toBe(isoMemory)
    expect(textOf(memMetas[0]!)).toBe(new Date(isoMemory).toLocaleString())
    expect(textOf(memMetas[0]!)).not.toBe(isoMemory)
    expect(memMetas[1]!.props.title).toBe(badTs)
    expect(textOf(memMetas[1]!)).toBe(badTs)

    // 切到世界状态页签检查 d.ts
    const deltaTab = view.root.findAllByType('button').find((b) => textOf(b) === t('memory.tab.delta', { count: 2 }))!
    await act(async () => { deltaTab.props.onClick() })
    const deltaMetas = view.root.findAllByProps({ className: 'dsh-tavern-memoMeta' })
    expect(deltaMetas[0]!.props.title).toBe(isoDelta)
    expect(textOf(deltaMetas[0]!)).toBe(new Date(isoDelta).toLocaleString())
    expect(textOf(deltaMetas[0]!)).not.toBe(isoDelta)
    expect(deltaMetas[1]!.props.title).toBe(badTs)
    expect(textOf(deltaMetas[1]!)).toBe(badTs)
  })

  it('仅有 1 条已撤销世界状态时即展示 全部/生效中/已撤销 筛选芯片并可正常切换过滤', async () => {
    // 仅有 1 条活跃变化时不显示筛选芯片
    const activeOnly = makeMemoryRemote({ deltas: [makeDelta(1, { revoked: false, content: '港口开放' })] })
    const vActive = await mount(createElement(MemorySection, {
      remote: activeOnly.remote,
      initialContext: { cardId: activeOnly.cardId, storyId: activeOnly.storyId },
      initialTab: 'delta',
    }))
    expect(vActive.root.findAllByType('button').some((b) => textOf(b) === t('memory.deltaFilter.revoked', { count: 0 }))).toBe(false)

    // 仅有 1 条已撤销变化时立即展示全部三个筛选芯片
    const revokedOnly = makeMemoryRemote({ deltas: [makeDelta(1, { revoked: true, content: '已撤回的戒严令' })] })
    const vRevoked = await mount(createElement(MemorySection, {
      remote: revokedOnly.remote,
      initialContext: { cardId: revokedOnly.cardId, storyId: revokedOnly.storyId },
      initialTab: 'delta',
    }))
    const allChip = vRevoked.root.findAllByType('button').find((b) => textOf(b) === t('memory.deltaFilter.all', { count: 1 }))
    const activeChip = vRevoked.root.findAllByType('button').find((b) => textOf(b) === t('memory.deltaFilter.active', { count: 0 }))
    const revokedChip = vRevoked.root.findAllByType('button').find((b) => textOf(b) === t('memory.deltaFilter.revoked', { count: 1 }))
    expect(allChip).toBeDefined()
    expect(activeChip).toBeDefined()
    expect(revokedChip).toBeDefined()

    // 切到「生效中 0」隐藏已撤销条目，切回「已撤销 1」重新展示
    await act(async () => { activeChip!.props.onClick() })
    expect(textOf(vRevoked.root)).not.toContain('已撤回的戒严令')
    await act(async () => { revokedChip!.props.onClick() })
    expect(textOf(vRevoked.root)).toContain('已撤回的戒严令')
  })
})

describe('4. AboutSection 兼容说明与链接间距及 styles.ts 共享契约', () => {
  it.each(['en', 'zh'] as const)('AboutSection 在 %s 下兼容说明与链接之间保留空白分隔，无词句粘连', async (locale) => {
    setTavernLocale(locale)
    const info: PluginAbout = {
      version: '0.5.13',
      hostVersion: '0.2.2-rc.5',
      expectedHostVersion: '*',
      hostCompatibility: 'compatible',
      developmentHostVersion: '0.2.2-rc.5',
      repositoryUrl: 'https://github.com/Amakurai/dsh-liketavern',
      releasesUrl: 'https://github.com/Amakurai/dsh-liketavern/releases',
      sourceCheckout: false,
      desktopHost: false,
    }
    const remote = {
      getPluginAbout: vi.fn(async () => ok(info)),
      checkPluginUpdate: vi.fn(),
    } as unknown as TavernRemote

    const view = await mount(createElement(AboutSection, { remote }))
    const rendered = textOf(view.root)
    expect(rendered).toContain(`${t('about.compatibilityPolicy')} ${t('about.compatibilityDetails')}`)
    expect(rendered).not.toContain('limitations.View')
    expect(rendered).not.toContain('记录。查看')
  })

  it('styles.ts 提供 .dsh-tavern-tileTrigger 共享样式、单行顶栏标签与弹窗层级/吸顶规则', () => {
    ensureTavernStyles()
    expect(injectedStyleText).toContain('.dsh-tavern-tileTrigger{appearance:none;border:0;padding:0;margin:0;background:transparent;color:inherit;font:inherit;text-align:left;')
    expect(injectedStyleText).toContain('.dsh-tavern-tileTrigger:focus-visible{')
    expect(injectedStyleText).toContain('.dsh-tavern-tileTrigger:disabled{')
    expect(injectedStyleText).toContain('.dsh-tavern-navPill{appearance:none;height:30px;padding:0 9px;')
    expect(injectedStyleText).toContain('font-size:12.5px;')
    expect(injectedStyleText).toContain('div:has(>.dsh-tavern-modal-sub){z-index:1010}')
    expect(injectedStyleText).toContain('div:has(>.dsh-tavern-modal-confirm){z-index:1020}')
    expect(injectedStyleText).toContain('.dsh-tavern-modalContent>div:first-child:has(>h2){position:sticky;top:0;')
  })
})
