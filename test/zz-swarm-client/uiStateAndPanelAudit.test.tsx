/**
 * 客户端状态隔离、原型键碰撞防护、草稿守卫、正则词法扫描与面板前向兼容回归测试：
 * - HelperScriptEditor / HelperScripts：导入脚本 id 为 toString / constructor 等 Object.prototype 同名键时不读取原生函数、不误判就绪或空转重置
 * - MemorySection：恢复未保存手札草稿后，在 getJournal 挂起或报错期间切换角色/剧情仍触发草稿确认守卫，不静默丢弃草稿
 * - splitRegexListText / ListInput / LineListInput：遵循 ECMAScript 字符类语义（[^] / [] 闭合、[\]] 转义）与接近上限时的尾随 flags，外部重置后不复活旧尾随分隔符草稿
 * - TavernHeaderChip：abandonHelperMvu 在途期间锁定全部表单控件，卸载时自动释放锁；绑定加载报错重试先失效缓存绕开挂起 Promise
 * - TavernHeroCharacter：角色详情加载失败重试先失效缓存；宿主芯片行脱离 DOM 时不向孤儿节点渲染 portal 并在新行挂载后自动重挂
 * - PresetsSection / CharactersSection / AboutSection / cache.ts：预设导入与删除递增显示修订；未知兼容性/状态枚举前向兼容不崩溃；缓存同步异常清理且满容量优先淘汰已结算项
 */
import { useState, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedAvatar,
  cachedCharacterDetail,
  cachedSessionBinding,
  invalidateCharacter,
  invalidateSessionBinding,
} from '../../src/client/cache.js'
import { HelperMvuAbandonAction, TavernHeaderChip, defaultBinding } from '../../src/client/chip.js'
import { getDisplaySettingsRevision } from '../../src/client/displayPrefs.js'
import { HelperScriptEditor } from '../../src/client/helperScriptEditor.js'
import { HelperScripts } from '../../src/client/helperScripts.js'
import { scriptStatusStore } from '../../src/client/helperScriptStatus.js'
import { TavernHeroCharacter } from '../../src/client/hero.js'
import { setTavernLocale, t } from '../../src/client/i18n.js'
import { AboutSection } from '../../src/client/panel/about.js'
import { CharactersSection } from '../../src/client/panel/characters.js'
import { MemorySection } from '../../src/client/panel/memory.js'
import { PresetsSection } from '../../src/client/panel/presets.js'
import type { CharacterDetail, CharacterInspect, Envelope, TavernRemote } from '../../src/client/types.js'
import {
  Btn,
  ConfirmDialog,
  FileBtn,
  LineListInput,
  ListInput,
  Select,
  Toggle,
  splitRegexListText,
} from '../../src/client/util.js'
import { MAX_WI_KEY_CHARS } from '../../src/core/worldbook.js'
import type { HelperSnapshot } from '../../src/core/helperRuntime.js'
import { parseHelperScriptTrees } from '../../src/core/helperScripts.js'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const portalCalls: Array<{ container: unknown }> = []
vi.mock('react-dom', () => ({
  createPortal: (node: ReactNode, container: unknown) => {
    portalCalls.push({ container })
    return <div data-portal-attached="">{node}</div>
  },
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; onClose?: () => void; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p>{props.text}</p>,
  IconArchiveOutlineMedium: () => null,
  IconBranchOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronLeftOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string, code = 'test-err') => ({ ok: false as const, error: { code, message } })
const tavernUseSessions = <T,>(selector: (state: { byId: Record<string, { projectionValues?: { agentPreset?: string | null } } | undefined> }) => T): T =>
  selector({
    byId: {
      's-chip-lock': { projectionValues: { agentPreset: 'tavern' } },
      's-hero': { projectionValues: { agentPreset: 'tavern' } },
    },
  })

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map(textOf).join('')
}

const mounted: ReactTestRenderer[] = []
let winTarget: EventTarget

beforeEach(() => {
  portalCalls.length = 0
  winTarget = Object.assign(new EventTarget(), {
    sessionStorage: { getItem: () => 'swarm-ui-tab', setItem() {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
  vi.stubGlobal('window', winTarget)
  setTavernLocale('zh')
})

afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTavernLocale('zh')
})

describe('客户端状态、原型键安全、草稿守卫与前向兼容回归', () => {
  it('HelperScriptEditor 与 HelperScripts 在脚本 id 为 toString / constructor 时不命中 Object.prototype，且导出错误消息无冗余前缀', async () => {
    const trees = parseHelperScriptTrees([
      { id: 'toString', type: 'script', name: '原型同名脚本', enabled: true, content: 'console.log(1)', data: { hp: 42 } },
      { id: 'constructor', type: 'script', name: '构造器同名脚本', enabled: true, content: 'console.log(2)', data: { mp: 7 } },
    ])
    const remote = {
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ updatedAt: 'now' })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    let editorView!: ReactTestRenderer
    await act(async () => {
      editorView = create(
        <HelperScriptEditor
          remote={remote}
          library={{ target: { type: 'global' }, revision: 'rev-1', trees }}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      )
    })
    mounted.push(editorView)

    const dataTextarea = editorView.root.findAllByType('textarea').find((el) => el.props['aria-label'] === t('speech.scriptData'))
    expect(dataTextarea).toBeDefined()
    expect(dataTextarea!.props.value).toBe('{\n  "hp": 42\n}')
    expect(String(dataTextarea!.props.value)).not.toContain('native code')

    // 填入非法 JSON 后点导出：错误提示应经 describeError 输出纯中文文案，不含 "Error: " 前缀
    await act(async () => {
      dataTextarea!.props.onChange({ target: { value: '{broken' } })
    })
    const exportBtn = editorView.root.findAllByType(Btn).find((b) => textOf(b) === t('speech.scriptExport'))
    await act(async () => {
      exportBtn!.props.onClick()
    })
    const alertNode = editorView.root.findAll((node) => node.props.role === 'alert')[0]
    expect(alertNode).toBeDefined()
    expect(textOf(alertNode!)).not.toMatch(/^Error:\s/)
    expect(textOf(alertNode!)).toContain('原型同名脚本')

    // HelperScripts 挂载 id='toString' 与 'constructor' 的脚本时，初始状态必须是 loading 而非被原型属性污染
    const snapshot: HelperSnapshot = {
      storyId: 'story-proto',
      historyRevision: 'rev-proto',
      currentMessageId: 0,
      writable: true,
      scopes: {},
      messages: [{ message_id: 0, role: 'assistant', name: '角色', message: 'hi', data: {}, extra: {}, is_hidden: false }],
    }
    const frames: Array<{ postMessage: ReturnType<typeof vi.fn> }> = []
    const scriptRemote = {
      getHelperScriptBundle: vi.fn(async () => ok({
        enabled: true,
        cardId: 'card-proto',
        storyId: 'story-proto',
        revision: 'rev-1',
        trees,
        libraries: [{ target: { type: 'character' as const, cardId: 'card-proto' }, revision: 'rev-1', trees }],
        messageId: 0,
        snapshot,
        helperMvu: false,
        whitelist: [],
      })),
      openHelperFrame: vi.fn(async () => ok({ token: 'tok-proto' })),
      closeHelperFrame: vi.fn(async () => ok({ ok: true })),
    } as unknown as TavernRemote

    let scriptsView!: ReactTestRenderer
    await act(async () => {
      scriptsView = create(
        <HelperScripts remote={scriptRemote} sessionId="s-proto" cardId="card-proto" />,
        {
          createNodeMock: (el) => {
            if (el.type !== 'iframe') return null
            const frameWin = { postMessage: vi.fn() }
            frames.push(frameWin)
            return { contentWindow: frameWin }
          },
        },
      )
    })
    mounted.push(scriptsView)

    const initialRuntime = scriptStatusStore.getSnapshot().find((item) => item.sessionId === 's-proto')
    expect(initialRuntime?.state).toBe('running')
    expect(initialRuntime?.scripts.map((s) => ({ id: s.id, state: s.state }))).toEqual([
      { id: 'toString', state: 'loading' },
      { id: 'constructor', state: 'loading' },
    ])

    // 两个脚本连接并汇报 helperScriptReady(true) 后才转为 ready
    await act(async () => {
      for (const [idx, frameWin] of frames.entries()) {
        const rt = `rt-proto-${idx}`
        winTarget.dispatchEvent(Object.assign(new Event('message'), { source: frameWin, data: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: rt } }))
        winTarget.dispatchEvent(Object.assign(new Event('message'), { source: frameWin, data: { source: 'dsh-tavern-card', action: 'helperScriptReady', runtimeId: rt, ok: true } }))
      }
    })
    const readyRuntime = scriptStatusStore.getSnapshot().find((item) => item.sessionId === 's-proto')
    expect(readyRuntime?.scripts.every((s) => s.state === 'ready')).toBe(true)
  })

  it('MemorySection 在恢复了未保存手札草稿且 getJournal 仍在加载或已失败时，切换角色受草稿守卫保护', async () => {
    const contextKey = `memory:context:${JSON.stringify(['card-1', 'story-1'])}`
    const journalDeferred = createDeferred<Envelope<{ text: string; revision: string }>>()
    const deleteEditorDraft = vi.fn(async () => ok({ deleted: true }))
    const remote = {
      getEditorDraft: vi.fn(async () => ok({
        draft: {
          updatedAt: '2026-11-25T00:00:00Z',
          value: {
            version: 1 as const,
            fields: {
              'memory:cardId': 'card-1',
              'memory:storyId': 'story-1',
              [`${contextKey}:tab`]: 'journal',
              [`${contextKey}:journalText`]: '尚未落盘的珍贵剧情笔记',
              [`${contextKey}:journalRevision`]: 'rev-j1',
              [`${contextKey}:journalUnsaved`]: true,
            },
          },
        },
      })),
      saveEditorDraft: vi.fn(async () => ok({ updatedAt: 'now' })),
      deleteEditorDraft,
      listCharacters: vi.fn(async () => ok({
        items: [
          { cardId: 'card-1', name: '角色甲', hasAvatar: false, hasCharacterBook: false, tags: [], creator: '' },
          { cardId: 'card-2', name: '角色乙', hasAvatar: false, hasCharacterBook: false, tags: [], creator: '' },
        ],
      })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listStories: vi.fn(async () => ok({ items: [{ id: 'story-1', sessionId: 's-1', createdAt: '2026-11-25T00:00:00Z' }] })),
      getMemories: vi.fn(async () => ok({ items: [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: [] })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      getJournal: vi.fn(() => journalDeferred.promise),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <MemorySection remote={remote} initialContext={{ cardId: 'card-1', storyId: 'story-1', cardName: '角色甲' }} initialTab="journal" />,
      )
    })
    mounted.push(view)

    // getJournal 尚未返回（status === 'loading'），此时尝试切换角色必须弹出放弃未保存更改确认框
    const charSelect = view.root.findAllByType(Select)[0]!
    expect(charSelect.props.value).toBe('card-1')
    await act(async () => {
      charSelect.props.onChange('card-2')
    })
    const openConfirms = view.root.findAllByType(ConfirmDialog).filter((d) => d.props.open)
    expect(openConfirms).toHaveLength(1)
    expect(view.root.findAllByType(Select)[0]!.props.value).toBe('card-1')

    // 取消切换后，即使 getJournal 返回错误信封，再次切换仍继续保护未保存草稿
    await act(async () => {
      openConfirms[0]!.props.onCancel()
      journalDeferred.resolve(fail('磁盘暂时不可读'))
    })
    await act(async () => {
      view.root.findAllByType(Select)[0]!.props.onChange('card-2')
    })
    expect(view.root.findAllByType(ConfirmDialog).filter((d) => d.props.open)).toHaveLength(1)
    expect(deleteEditorDraft).not.toHaveBeenCalled()
  })

  it('splitRegexListText 遵循 ECMAScript [^] / [\\]] 语义与上限处 flags，且 ListInput / LineListInput 在外部切换后不复活旧分隔草稿', async () => {
    expect(splitRegexListText('/foo[^]*bar/, /baz[a,b]/, /[\\],]/gi, 普通词')).toEqual([
      '/foo[^]*bar/',
      '/baz[a,b]/',
      '/[\\],]/gi',
      '普通词',
    ])

    const nearMaxBody = 'a'.repeat(MAX_WI_KEY_CHARS - 2)
    const nearMaxToken = `/${nearMaxBody}/gim`
    expect(splitRegexListText(`${nearMaxToken}, 尾项`)).toEqual([nearMaxToken, '尾项'])

    function DualLists() {
      const [items, setItems] = useState<string[]>(['alpha', 'beta'])
      const [lines, setLines] = useState<string[]>(['stop-1', 'stop-2'])
      return (
        <div>
          <ListInput value={items} onChange={setItems} />
          <LineListInput value={lines} onChange={setLines} />
          <button type="button" data-switch="other" onClick={() => { setItems(['gamma']); setLines(['other']) }} />
          <button type="button" data-switch="back" onClick={() => { setItems(['alpha', 'beta']); setLines(['stop-1', 'stop-2']) }} />
        </div>
      )
    }

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<DualLists />)
    })
    mounted.push(view)

    const input = view.root.findByType('input')
    const textarea = view.root.findByType('textarea')

    // 输入带尾随分隔符与空白的中间态文本，编辑期间应原样保留
    await act(async () => {
      input.props.onChange({ target: { value: 'alpha, beta,   ' } })
      textarea.props.onChange({ target: { value: 'stop-1\nstop-2\n\n  ' } })
    })
    expect(view.root.findByType('input').props.value).toBe('alpha, beta,   ')
    expect(view.root.findByType('textarea').props.value).toBe('stop-1\nstop-2\n\n  ')

    // 外部切到其它条目再切回 ['alpha', 'beta']：内部草稿已同步，不得复活旧尾随逗号/空行
    const toOther = view.root.find((n) => n.props['data-switch'] === 'other')
    const toBack = view.root.find((n) => n.props['data-switch'] === 'back')
    await act(async () => {
      toOther.props.onClick()
    })
    expect(view.root.findByType('input').props.value).toBe('gamma')
    expect(view.root.findByType('textarea').props.value).toBe('other')

    await act(async () => {
      toBack.props.onClick()
    })
    expect(view.root.findByType('input').props.value).toBe('alpha, beta')
    expect(view.root.findByType('textarea').props.value).toBe('stop-1\nstop-2')
  })

  it('TavernHeaderChip 在放弃 MVU 飞行期间禁用全部绑定控件并在卸载时释放锁，且绑定加载失败重试会失效缓存', async () => {
    invalidateSessionBinding('s-chip-lock')
    invalidateCharacter('card-lock')
    const abandonDeferred = createDeferred<Envelope<{ abandoned: boolean }>>()
    let bindingAttempt = 0
    let pendingBinding!: Promise<Envelope<{ binding: ReturnType<typeof defaultBinding> | null; conversationStarted: boolean }>>

    const remote = {
      getSessionBinding: vi.fn(() => {
        bindingAttempt++
        if (bindingAttempt === 1) {
          // 模拟首次请求悬挂（尚未超过 20s PENDING_TTL_MS），但 useLoader 超时后用户点重试
          pendingBinding = new Promise(() => {})
          return pendingBinding
        }
        return Promise.resolve(ok({
          binding: { ...defaultBinding('s-chip-lock', 'card-lock'), storyId: 'story-lock', helperMvu: true },
          conversationStarted: true,
        }))
      }),
      getCharacterDetail: vi.fn(async () => ok({
        cardId: 'card-lock',
        revision: 'rev-lock',
        name: '守门人',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '你好',
        alternateGreetings: ['备选'],
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        creator: '',
        characterVersion: '1',
        tags: [],
        spec: 'chara_card_v2',
        hasCharacterBook: false,
        characterBookName: '',
        characterBookEntryCount: 0,
        hasAvatar: false,
        depthPrompt: null,
        extensions: {},
      } satisfies CharacterDetail)),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
      listCharacters: vi.fn(async () => ok({ items: [{ cardId: 'card-lock', name: '守门人', hasAvatar: false, hasCharacterBook: false, tags: [], creator: '' }] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: ['主世界'] })),
      abandonHelperMvu: vi.fn(() => abandonDeferred.promise),
    } as unknown as TavernRemote

    vi.useFakeTimers()
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<TavernHeaderChip remote={remote} sessionId="s-chip-lock" sessions={{ open() {} }} useSessions={tavernUseSessions} />)
    })
    mounted.push(view)

    // 先推进首次绑定读取超时，使头部芯片退出 loading 态并可点击打开弹窗
    const baseNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 19_995)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    const seatBtn = view.root.findByType('button')
    await act(async () => {
      seatBtn.props.onClick()
    })

    // 点击绑定错误上的「重试」必须先 invalidateSessionBinding，从而真正发出第 2 次 getSessionBinding
    const retryBtn = view.root.findAllByType(Btn).find((b) => textOf(b) === t('action.retry'))
    expect(retryBtn).toBeDefined()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await act(async () => {
      retryBtn!.props.onClick()
    })
    expect(bindingAttempt).toBeGreaterThanOrEqual(2)
    expect(view.root.findAllByType(Select).length).toBeGreaterThan(0)

    // 触发「放弃等待中的 MVU 任务」并确认，abandonHelperMvu 处于飞行中
    const abandonSection = view.root.findByType(HelperMvuAbandonAction)
    const openAbandonBtn = abandonSection.findByType(Btn)
    await act(async () => {
      openAbandonBtn.props.onClick()
    })
    const confirmAbandon = abandonSection.findByType(ConfirmDialog)
    await act(async () => {
      confirmAbandon.props.onConfirm()
    })

    // 所有 Select 与 Toggle 都必须因 locked=true 而禁用（防止弹层菜单绕过 fieldset 修改草稿）
    for (const sel of view.root.findAllByType(Select)) {
      expect(sel.props.disabled).toBe(true)
    }
    for (const tog of view.root.findAllByType(Toggle)) {
      expect(tog.props.disabled).toBe(true)
    }

    // 请求完成后自动恢复可编辑
    await act(async () => {
      abandonDeferred.resolve(ok({ abandoned: true }))
    })
    expect(view.root.findAllByType(Select)[0]!.props.disabled).toBe(false)
  })

  it('TavernHeroCharacter 在角色详情报错重试时失效缓存，且在宿主芯片行被替换脱离连接时不会向断连节点渲染 portal', async () => {
    invalidateSessionBinding('s-hero')
    invalidateCharacter('card-hero')
    let detailCalls = 0
    let boundCard = false
    const remote = {
      getSettings: vi.fn(async () => ok({ settings: { defaults: { presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null } } })),
      setSessionBinding: vi.fn(async () => {
        boundCard = true
        return ok({ saved: true })
      }),
      getSessionBinding: vi.fn(async () => ok({
        binding: boundCard ? defaultBinding('s-hero', 'card-hero') : null,
        conversationStarted: false,
        userName: '旅人',
      })),
      clearSessionBinding: vi.fn(async () => ok({ cleared: false })),
      listCharacters: vi.fn(async () => ok({ items: [{ cardId: 'card-hero', name: '星野', hasAvatar: false, hasCharacterBook: false, tags: [], creator: '' }] })),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, htmls: [], interactiveCards: true })),
      getCharacterDetail: vi.fn(() => {
        detailCalls++
        if (detailCalls === 1) return new Promise<Envelope<CharacterDetail>>(() => {})
        return Promise.resolve(ok({
          cardId: 'card-hero',
          revision: 'rev-hero',
          name: '星野',
          description: '',
          personality: '',
          scenario: '',
          firstMes: '早安，{{user}}。',
          alternateGreetings: [],
          mesExample: '',
          systemPrompt: '',
          postHistoryInstructions: '',
          creatorNotes: '',
          creator: '',
          characterVersion: '1',
          tags: [],
          spec: 'chara_card_v2',
          hasCharacterBook: false,
          characterBookName: '',
          characterBookEntryCount: 0,
          hasAvatar: false,
          depthPrompt: null,
          extensions: {},
        } satisfies CharacterDetail))
      }),
    } as unknown as TavernRemote

    class FakeElement {
      tagName = 'DIV'
      nodeType = 1
      isConnected = true
      prevRow: FakeElement | null = null
      get previousElementSibling() { return this.prevRow }
      get parentElement() { return null }
      closest(sel: string) { return sel === '[data-composer-seat]' ? seatEl : null }
      contains() { return false }
      querySelector(sel: string) { return sel === 'button[aria-haspopup="menu"]' ? {} : null }
      querySelectorAll() { return [] }
      getAttributeNames() { return [] }
      getAttribute() { return null }
      hasAttribute() { return false }
    }
    const seatEl = new FakeElement()
    const row1 = new FakeElement()
    const row2 = new FakeElement()
    const dockEl = new FakeElement()
    dockEl.prevRow = row1

    const observers = new Set<() => void>()
    vi.stubGlobal('HTMLElement', FakeElement)
    vi.stubGlobal('MutationObserver', class {
      private readonly cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe() { observers.add(this.cb) }
      disconnect() { observers.delete(this.cb) }
    })

    vi.useFakeTimers()
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <TavernHeroCharacter
          remote={remote}
          sessionId="s-hero"
          sessions={{ open() {} }}
          session={{ blank: true, promptAttempted: false }}
          useSessions={tavernUseSessions}
        />,
        { createNodeMock: (el) => (el.props['data-tavern-hero-root'] !== undefined ? dockEl : null) },
      )
    })
    mounted.push(view)
    expect(portalCalls.at(-1)?.container === row1).toBe(true)

    // 打开选角器并选择角色「星野」
    const seatBtn = view.root.findByType('button')
    await act(async () => {
      seatBtn.props.onClick()
    })
    const pickItemBtn = view.root.findAllByType('button').find((b) => textOf(b).includes('星野'))
    expect(pickItemBtn).toBeDefined()
    await act(async () => {
      pickItemBtn!.props.onClick()
    })

    // 模拟宿主重绘替换了芯片行：旧 row1.isConnected 变为 false：
    // 在同步重渲染帧即使尚未收到 MutationObserver 回调，也不会把 chip 渲染进已断连的 row1；
    // MutationObserver 触发后立即重挂到新的 row2。
    row1.isConnected = false
    dockEl.prevRow = row2
    await act(async () => {
      for (const trigger of [...observers]) trigger()
    })
    expect(portalCalls.at(-1)?.container === row2).toBe(true)

    // 即使旧 row2 仍保持 connected（仍在 seat 其它位置），只要 dock 前插入了新芯片行 row3，MutationObserver 也立即重挂到 row3
    const row3 = new FakeElement()
    dockEl.prevRow = row3
    await act(async () => {
      for (const trigger of [...observers]) trigger()
    })
    expect(portalCalls.at(-1)?.container === row3).toBe(true)

    // 模拟 Windows 定时器轻微早到导致 getCharacterDetail 超时后点击重试：必须失效缓存发出第 2 次请求
    const baseNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(baseNow + 19_995)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    const retryDetail = view.root.findAllByType(Btn).find((b) => textOf(b) === t('action.retry'))
    expect(retryDetail).toBeDefined()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await act(async () => {
      retryDetail!.props.onClick()
    })
    expect(detailCalls).toBe(2)
    expect(textOf(view.root)).toContain('早安，旅人。')
  })

  it('PresetsSection 导入/删除递增显示修订，CharactersSection / AboutSection 对未知枚举值前向兼容，cache.ts 兜住同步异常并保持严格 LRU 容量淘汰', async () => {
    // 1. cache.ts：同步发起 load 且同步抛错不残留脏槽位；满容量 128 项按严格 LRU 淘汰（含悬挂请求），迟到回包不覆盖新值
    let syncThrowCalls = 0
    const throwRemote = {
      getAvatar: () => {
        syncThrowCalls++
        if (syncThrowCalls === 1) throw new Error('transport not ready')
        return Promise.resolve(ok({ dataUrl: 'data:image/png;base64,AA==' }))
      },
    } as unknown as TavernRemote
    const syncFailed = cachedAvatar(throwRemote, 'card-sync')
    expect(syncThrowCalls).toBe(1)
    await expect(syncFailed).rejects.toThrow('transport not ready')
    await expect(cachedAvatar(throwRemote, 'card-sync')).resolves.toEqual(ok({ dataUrl: 'data:image/png;base64,AA==' }))

    const inFlight = createDeferred<Envelope<{ dataUrl: string | null }>>()
    let inflightCalls = 0
    const capRemote = {
      getAvatar: ({ cardId }: { cardId: string }) => {
        if (cardId === 'inflight-0') {
          inflightCalls++
          if (inflightCalls === 1) return inFlight.promise
          return Promise.resolve(ok({ dataUrl: 'url:fresh-inflight-0' }))
        }
        return Promise.resolve(ok({ dataUrl: `url:${cardId}` }))
      },
    } as unknown as TavernRemote
    const firstPending = cachedAvatar(capRemote, 'inflight-0')
    expect(inflightCalls).toBe(1)
    for (let i = 1; i <= 130; i++) {
      await cachedAvatar(capRemote, `settled-${i}`)
    }
    // 超过 128 容量后严格按 LRU 淘汰悬挂项，重试不会永久卡在旧 pending，且旧请求迟到回包不覆盖新缓存
    const retryPending = cachedAvatar(capRemote, 'inflight-0')
    expect(inflightCalls).toBe(2)
    expect(retryPending).not.toBe(firstPending)
    await expect(retryPending).resolves.toEqual(ok({ dataUrl: 'url:fresh-inflight-0' }))
    inFlight.resolve(ok({ dataUrl: 'url:stale-inflight-0' }))
    await expect(firstPending).resolves.toEqual(ok({ dataUrl: 'url:stale-inflight-0' }))
    await expect(cachedAvatar(capRemote, 'inflight-0')).resolves.toEqual(ok({ dataUrl: 'url:fresh-inflight-0' }))

    // 2. PresetsSection：导入与删除预设均递增 displaySettingsRevision
    const revBefore = getDisplaySettingsRevision()
    const presetRemote = {
      listPresets: vi.fn(async () => ok({ items: [{ id: 'p-1', name: '预设一', entryCount: 1, regexCount: 1 }] })),
      getSettings: vi.fn(async () => ok({ settings: { defaults: { presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null } } })),
      importPreset: vi.fn(async () => ok({ id: 'p-2', name: '预设二', warnings: [] })),
      deletePreset: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    let presetView!: ReactTestRenderer
    await act(async () => {
      presetView = create(<PresetsSection remote={presetRemote} />)
    })
    mounted.push(presetView)

    const importFileBtn = presetView.root.findByType(FileBtn)
    await act(async () => {
      await importFileBtn.props.onFile(new File(['{"name":"预设二"}'], 'preset2.json', { type: 'application/json' }))
    })
    const revAfterImport = getDisplaySettingsRevision()
    expect(revAfterImport).toBeGreaterThan(revBefore)

    const deleteIconBtn = presetView.root.findAllByType('button').find((b) => b.props['aria-label'] === t('presets.delete'))
    await act(async () => {
      deleteIconBtn!.props.onClick({ stopPropagation() {} })
    })
    const confirmDelete = presetView.root.findAllByType(ConfirmDialog).find((d) => d.props.open)
    expect(confirmDelete).toBeDefined()
    await act(async () => {
      confirmDelete!.props.onConfirm()
    })
    expect(getDisplaySettingsRevision()).toBeGreaterThan(revAfterImport)

    // 3. CharactersSection & AboutSection：服务端返回新版未知兼容性代码或状态枚举时不崩溃
    vi.stubGlobal('FileReader', class {
      result = 'data:application/json;base64,e30='
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() { this.onload?.() }
    })
    const unknownInspect = {
      name: '未来角色',
      hasAvatar: false,
      hasCharacterBook: false,
      characterBookName: '',
      entryCount: 0,
      compatibility: {
        version: 1,
        complete: true,
        scannedChars: 12,
        findings: [
          {
            code: 'futureQuantumBridge' as unknown as CharacterInspect['compatibility']['findings'][number]['code'],
            status: 'review',
            count: 2,
            locations: ['first_mes'],
          },
        ],
      },
    } satisfies CharacterInspect

    const charRemote = {
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ updatedAt: 'now' })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listArchivedCharacters: vi.fn(async () => ok({ items: [] })),
      inspectCharacter: vi.fn(async () => ok(unknownInspect)),
    } as unknown as TavernRemote

    let charView!: ReactTestRenderer
    await act(async () => {
      charView = create(<CharactersSection remote={charRemote} />)
    })
    mounted.push(charView)
    await act(async () => {
      await charView.root.findByType(FileBtn).props.onFile(new File(['{}'], 'future.json', { type: 'application/json' }))
    })
    expect(textOf(charView.root)).toContain('futureQuantumBridge')

    const aboutRemote = {
      getPluginAbout: vi.fn(async () => ok({
        version: '0.2.2',
        hostVersion: '0.3.0',
        expectedHostVersion: '*',
        hostCompatibility: 'future-tier' as unknown as 'compatible',
        sourceCheckout: false,
        desktopHost: false,
      })),
      checkPluginUpdate: vi.fn(async () => ok({
        status: 'current',
        versionStatus: 'staged-rollout' as unknown as 'current',
        hostCompatibility: 'future-tier' as unknown as 'compatible',
        currentVersion: '0.2.2',
        latestVersion: '0.3.0-next',
        requiredHostVersion: '*',
        releaseUrl: 'https://example.com/release',
      })),
    } as unknown as TavernRemote

    let aboutView!: ReactTestRenderer
    await act(async () => {
      aboutView = create(<AboutSection remote={aboutRemote} />)
    })
    mounted.push(aboutView)
    const checkBtn = aboutView.root.findAllByType(Btn).find((b) => textOf(b) === t('about.check'))
    await act(async () => {
      await checkBtn!.props.onClick()
    })
    expect(textOf(aboutView.root)).toContain('future-tier')
    expect(textOf(aboutView.root)).toContain('0.3.0-next')

    // cachedSessionBinding 基本契约核验（避免未使用导入）
    const bindRemote = {
      getSessionBinding: vi.fn(async () => ok({ binding: null, conversationStarted: false })),
    } as unknown as TavernRemote
    await expect(cachedSessionBinding(bindRemote, 's-smoke')).resolves.toMatchObject({ ok: true })
  })
})
