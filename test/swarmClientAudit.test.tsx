/**
 * 客户端层（src/client/**）深度缺陷审计与交互竞态回归测试：
 * - DisplayProjection：StrictMode / 多卡面混排 PlainDetailsFoldView / srcDoc 重建时按最新文档帧收口，动态开启交互卡补发渲染完成事件
 * - SpeechBubble：Markdown 与原生 <details> 折叠混排复制保持文档顺序，全局交互卡/正则/预设显示修订变化即时重渲染气泡与后台脚本
 * - renderOutputBatched / floorActionStateBatched：同批重复请求去重（避免 StrictMode 双发或跨块拆分）、坏项隔离与单条回退异常信封
 * - TavernFloorActions：刷新期间压制历史楼层续写按钮闪烁、全层不可续写时清理旧记录、卸载后分支切换异常隔离
 * - installHelperLiveEvents / HelperMvuRunner：无 detail 全局绑定变更重探测、乱序 settle 队列上限保护、MVU 提交失败按租约退避而非 1Hz 空转
 * - PersistentEditor / 面板编辑器与长列表分页：单子编辑器清理草稿保留未挂载兄弟恢复字段、世界书跨页删除/复制页码同步、删除在途禁打开、正则放弃/导入锁、脚本库切换复位、头部芯片保存期间禁用控件、角色选择器清空复位分页
 */
import { StrictMode, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT, TavernFloorActions } from '../src/client/actions.js'
import { invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { CharacterPicker } from '../src/client/characterPicker.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { setSpeakerHeader } from '../src/client/displayPrefs.js'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { floorActionStateBatched } from '../src/client/floorActionBatch.js'
import { attachHelperEvents } from '../src/client/helperEventRouter.js'
import { installHelperLiveEvents } from '../src/client/helperLiveEvents.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { watchHelperStory } from '../src/client/helperNotifications.js'
import { HelperScriptEditor } from '../src/client/helperScriptEditor.js'
import { HelperScripts } from '../src/client/helperScripts.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import { renderOutputBatched } from '../src/client/renderBatch.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { SpeechBubble } from '../src/client/speech.js'
import { DEFAULT_PROMPT_PREFERENCES, EMPTY_SESSION_DEFAULTS, type CharacterSummary, type Envelope, type TavernRemote, type TavernSettings } from '../src/client/types.js'
import { Btn, CheckChips, ConfirmDialog, FileBtn, SaveBar, SearchEmpty, SearchInput, Select, Tabs, Toggle } from '../src/client/util.js'
import type { HelperMvuWork } from '../src/core/helperMvu.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import { parseHelperScriptTrees } from '../src/core/helperScripts.js'
import type { RegexRule, WorldInfoEntry } from '../src/core/types.js'
import type { RenderedOutput, RenderedOutputBatch, TavernMethodRequests, TavernMethodResults } from '../src/remote.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; onClose?: () => void; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p data-markdown={props.text}>{props.text}</p>,
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
const fail = (message: string, code = 'audit-error') => ({ ok: false as const, error: { code, message } })

type FakeFrame = { postMessage: ReturnType<typeof vi.fn>; runtimeId: string }

const mounted: ReactTestRenderer[] = []
const cleanups: Array<() => void> = []
let windowEvents: EventTarget
let browserStorage: Map<string, string>
let frameSerial = 0

function instanceText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map(instanceText).join('')
}

function makeHelperSnapshot(storyId = 'story-1', currentMessageId = 1): HelperSnapshot {
  return {
    storyId,
    historyRevision: 'rev-1',
    currentMessageId,
    messages: [
      { message_id: 0, name: '旅人', role: 'user', is_hidden: false, message: '你好', data: {}, extra: {} },
      { message_id: 1, name: '灯塔', role: 'assistant', is_hidden: false, message: '回应', data: {}, extra: {} },
    ],
    scopes: {},
    writable: true,
  }
}

function subscribeHostEventCounter(sessionId: string, storyId: string, eventName: string) {
  let deliveries = 0
  const errors: string[] = []
  const runtimeId = `listener-${++frameSerial}`
  const endpoint = attachHelperEvents(sessionId, storyId, (message) => {
    if (message.action === 'helperEventResult' && message.ok === false && typeof message.error === 'string') {
      errors.push(message.error)
      return
    }
    if (message.action === 'helperEventDeliver' && typeof message.deliveryId === 'string') {
      deliveries++
      queueMicrotask(() => {
        endpoint.receive({
          source: 'dsh-tavern-card',
          action: 'helperEventPrepared',
          runtimeId,
          deliveryId: message.deliveryId,
          args: message.args,
        })
      })
      return
    }
    if (message.action === 'helperEventExecute' && typeof message.deliveryId === 'string') {
      queueMicrotask(() => {
        endpoint.receive({
          source: 'dsh-tavern-card',
          action: 'helperEventReply',
          runtimeId,
          deliveryId: message.deliveryId,
          ok: true,
          args: [],
        })
      })
    }
  })
  cleanups.push(() => endpoint.dispose())
  endpoint.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId })
  endpoint.receive({
    source: 'dsh-tavern-card',
    action: 'helperEventSubscribe',
    runtimeId,
    listenerId: `sub-${eventName}`,
    event: eventName,
    once: false,
    position: 'normal',
  })
  return {
    count: () => deliveries,
    errors,
  }
}

function makeBaseSettings(overrides: Partial<TavernSettings> = {}): TavernSettings {
  return {
    locale: 'zh',
    speakerHeader: true,
    interactiveCards: true,
    cardNetworkWhitelist: [],
    defaults: { ...EMPTY_SESSION_DEFAULTS },
    prompts: { ...DEFAULT_PROMPT_PREFERENCES },
    sampling: {
      temperature: null,
      maxTokens: null,
      topP: null,
      frequencyPenalty: null,
      presencePenalty: null,
      stop: [],
      reasoningEffort: null,
    },
    worldInfo: {
      scanDepth: 4,
      tokenBudget: 2048,
      recursionSteps: 2,
      caseSensitive: false,
      matchWholeWords: false,
      useGroupScoring: false,
    },
    memory: {
      autoSummarize: true,
      summarizeEveryTurns: 12,
      maxRecallItems: 6,
      turnTokenBudget: 1024,
    },
    ...overrides,
  }
}

function makeWorldEntry(index: number): WorldInfoEntry {
  const uid = `uid-${index}`
  return {
    key: `global:book:${uid}`,
    uid,
    source: 'global',
    sourceRef: 'book',
    keys: [`key-${index}`],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    comment: `条目-${index}`,
    content: `内容-${index}`,
    constant: false,
    enabled: true,
    order: 100 + index,
    position: 0,
    depth: 4,
    role: 0,
    outletName: '',
    probability: 100,
    useProbability: true,
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
  }
}

function makeRegexRule(index: number): RegexRule {
  return {
    id: `rule-${index}`,
    name: `规则-${index}`,
    find: `foo-${index}`,
    replace: `bar-${index}`,
    enabled: true,
    scopes: ['output'],
    timing: ['render'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: 'user',
  }
}

function makeCharacterSummary(index: number): CharacterSummary {
  return {
    cardId: `card-${index}`,
    name: `角色-${index}`,
    hasAvatar: false,
    hasCharacterBook: false,
    characterBookName: '',
    tags: [],
    creator: '',
    characterVersion: '',
    updatedAt: new Date(0).toISOString(),
  }
}

function postFromFrame(frame: FakeFrame, payload: Record<string, unknown>) {
  const event = new Event('message')
  Object.defineProperties(event, {
    source: { value: frame },
    data: { value: { source: 'dsh-tavern-card', runtimeId: frame.runtimeId, ...payload } },
  })
  windowEvents.dispatchEvent(event)
}

beforeEach(() => {
  frameSerial = 0
  browserStorage = new Map([['dsh-tavern-editor-owner', 'swarm-client-audit-owner']])
  windowEvents = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => browserStorage.set(key, value),
    },
  })
  vi.stubGlobal('window', windowEvents)
  setTavernLocale('zh')
  setSpeakerHeader(true)
})

afterEach(async () => {
  for (const stop of cleanups.splice(0)) stop()
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  setSpeakerHeader(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('聊天气泡、DisplayProjection 生命周期与复制顺序', () => {
  it('StrictMode 下多卡面混排折叠块并在未全部就绪时重绘 srcDoc，必须等全部新文档就绪后才触发一次渲染完成事件', async () => {
    const sessionId = 'session-projection-cycle'
    const storyId = 'story-cycle'
    const snapshot = makeHelperSnapshot(storyId, 1)
    const renderedEvents = subscribeHostEventCounter(sessionId, storyId, 'character_message_rendered')

    const renderedValue: RenderedOutput = {
      text: '',
      parts: [
        { kind: 'html', text: '<html><body><div>第一张卡</div></body></html>' },
        { kind: 'html', text: '<details><summary>推理摘要</summary>\n隐藏细节\n</details>' },
        { kind: 'html', text: '<html><body><div>第二张卡</div></body></html>' },
      ],
      helper: snapshot,
      interactiveCards: true,
      whitelist: [],
      greetings: [],
      greetingIndex: 0,
      canSwipeGreeting: false,
    }
    const remote = {
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      openHelperFrame: vi.fn(async () => ok({ token: 'lease-token' })),
      closeHelperFrame: vi.fn(async () => ok(undefined)),
      renderOutputText: vi.fn(async () => ok(renderedValue)),
    } as unknown as TavernRemote

    const createdFrames: FakeFrame[] = []
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <StrictMode>
          <SpeechBubble remote={remote} sessionId={sessionId} cardId="card-1" name="灯塔" rawText="多段卡面" messageId={1} />
        </StrictMode>,
        {
          createNodeMock: (element) => {
            if (element.type !== 'iframe') return null
            const frame: FakeFrame = { postMessage: vi.fn(), runtimeId: `frame-rt-${++frameSerial}` }
            createdFrames.push(frame)
            queueMicrotask(() => postFromFrame(frame, { action: 'helperEventConnect' }))
            return { contentWindow: frame }
          },
        },
      )
    })
    mounted.push(view)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })

    // 2 张完整 HTML 卡走 iframe，中间纯文本 <details> 走原生折叠视图
    expect(view.root.findAllByType('iframe')).toHaveLength(2)
    expect(view.root.findAllByType('details')).toHaveLength(1)
    const [firstDocFrame0, firstDocFrame2] = createdFrames.slice(-2)
    expect(firstDocFrame0).toBeDefined()
    expect(firstDocFrame2).toBeDefined()

    // 第一张卡先就绪，第二张卡尚未就绪 -> 不能提前触发 character_message_rendered
    await act(async () => {
      postFromFrame(firstDocFrame0!, { action: 'helperFrameReady' })
    })
    expect(renderedEvents.count()).toBe(0)

    // 角色显示名更新触发两张 iframe 的 srcDoc 重新生成与重连（同一 DisplayProjection 实例保持挂载）
    await act(async () => {
      view.update(
        <StrictMode>
          <SpeechBubble remote={remote} sessionId={sessionId} cardId="card-1" name="新灯塔" rawText="多段卡面" messageId={1} />
        </StrictMode>,
      )
    })
    firstDocFrame0!.runtimeId = `frame-rt-${++frameSerial}`
    firstDocFrame2!.runtimeId = `frame-rt-${++frameSerial}`
    await act(async () => {
      postFromFrame(firstDocFrame0!, { action: 'helperEventConnect' })
      postFromFrame(firstDocFrame2!, { action: 'helperEventConnect' })
    })

    // 新文档里第二张卡先就绪，但第一张卡的新文档尚未就绪 -> 旧 seen 记录不能冒充新文档已就绪
    await act(async () => {
      postFromFrame(firstDocFrame2!, { action: 'helperFrameReady' })
    })
    expect(renderedEvents.count()).toBe(0)

    // 第一张卡的新文档也报告就绪后，完整收口并准确触发一次 character_message_rendered
    await act(async () => {
      postFromFrame(firstDocFrame0!, { action: 'helperFrameReady' })
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(renderedEvents.count()).toBe(1)
  })

  it('Markdown 与原生 <details> 混排复制保留完整文档顺序；全局开启交互卡后同气泡新卡面补发渲染事件并联动后台脚本', async () => {
    const sessionId = 'session-copy-and-toggle'
    const storyId = 'story-toggle'
    const snapshot = makeHelperSnapshot(storyId, 1)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const renderedEvents = subscribeHostEventCounter(sessionId, storyId, 'character_message_rendered')

    // 1. 验证 Markdown + <details> + Markdown 混排复制不丢弃折叠块
    const mixedRemote = {
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async () =>
        ok({
          text: '开场台词\n\n收尾台词',
          parts: [
            { kind: 'markdown' as const, text: '开场台词' },
            { kind: 'html' as const, text: '<details><summary>内心独白</summary>\n隐藏线索\n</details>' },
            { kind: 'markdown' as const, text: '收尾台词' },
          ],
          interactiveCards: true,
          whitelist: [],
          greetings: [],
          greetingIndex: 0,
          canSwipeGreeting: false,
        }),
      ),
    } as unknown as TavernRemote

    let copyView!: ReactTestRenderer
    await act(async () => {
      copyView = create(<SpeechBubble remote={mixedRemote} sessionId="copy-only" cardId="card-1" name="灯塔" rawText="混排正文" messageId={2} />)
    })
    mounted.push(copyView)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    const copyBtn = copyView.root.findByProps({ 'aria-label': t('speech.copy') })
    await act(async () => {
      copyBtn.props.onClick({ stopPropagation: () => {} })
    })
    expect(writeText).toHaveBeenCalledWith('开场台词\n\n内心独白\n隐藏线索\n\n收尾台词')

    // 2. 验证全局设置切换 interactiveCards (false -> true) 驱动已挂载 SpeechBubble 与 HelperScripts 刷新并补发新卡渲染完成事件
    let currentSettings = makeBaseSettings({ interactiveCards: false, cascadeDeleteEmbeddedBook: false })
    const trees = parseHelperScriptTrees([{ id: 'bg-1', name: '后台脚本', enabled: true, content: 'window.ready = 1;' }])
    const renderOutputText = vi.fn(async () =>
      ok({
        text: '纯文本降级',
        htmls: ['<html><body><div>动态恢复卡面</div></body></html>'],
        helper: snapshot,
        interactiveCards: currentSettings.interactiveCards,
        whitelist: currentSettings.cardNetworkWhitelist,
        greetings: [],
        greetingIndex: 0,
        canSwipeGreeting: false,
      }),
    )
    const getHelperScriptBundle = vi.fn(async () =>
      ok({
        cardId: 'card-1',
        revision: 'rev-1',
        storyId,
        trees,
        messageId: 1,
        snapshot,
        enabled: currentSettings.interactiveCards,
        whitelist: currentSettings.cardNetworkWhitelist,
      }),
    )
    const updateSettings = vi.fn(async ({ patch }: TavernMethodRequests['updateSettings']) => {
      currentSettings = { ...currentSettings, ...(patch as Partial<TavernSettings>) }
      return ok({ settings: structuredClone(currentSettings) })
    })
    const liveRemote = {
      getSettings: vi.fn(async () => ok({ settings: structuredClone(currentSettings) })),
      getDataInfo: vi.fn(async () => ok({ dataHome: '/tmp/tavern' })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      updateSettings,
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      openHelperFrame: vi.fn(async () => ok({ token: 'lease-live' })),
      closeHelperFrame: vi.fn(async () => ok(undefined)),
      renderOutputText,
      getHelperScriptBundle,
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const frames: FakeFrame[] = []
    let liveView!: ReactTestRenderer
    await act(async () => {
      liveView = create(
        <PersistentEditor remote={liveRemote} scope="panel">
          <SettingsSection remote={liveRemote} />
          <HelperScripts remote={liveRemote} sessionId={sessionId} cardId="card-1" />
          <SpeechBubble remote={liveRemote} sessionId={sessionId} cardId="card-1" name="灯塔" rawText="<html><body><div>动态恢复卡面</div></body></html>" messageId={1} />
        </PersistentEditor>,
        {
          createNodeMock: (element) => {
            if (element.type !== 'iframe') return null
            const frame: FakeFrame = { postMessage: vi.fn(), runtimeId: `toggle-rt-${++frameSerial}` }
            frames.push(frame)
            queueMicrotask(() => postFromFrame(frame, { action: 'helperEventConnect' }))
            return { contentWindow: frame }
          },
        },
      )
    })
    mounted.push(liveView)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })

    // 初始 interactiveCards=false：无 iframe，纯文本降级投影已完成 1 次渲染事件
    expect(liveView.root.findAllByType('iframe')).toHaveLength(0)
    expect(renderedEvents.count()).toBe(1)

    // 切到「卡片与数据」子组，打开全局交互卡开关并点击保存按钮
    await act(async () => {
      liveView.root.findByType(Tabs).props.onChange('cards')
    })
    await act(async () => {
      liveView.root.findAllByType(Toggle)[1]!.props.onChange(true)
    })
    const saveSettingsBtn = liveView.root.findAllByType(Btn).find((b) => b.props.children === t('settings.cards.save'))!
    await act(async () => {
      saveSettingsBtn.props.onClick()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })

    expect(updateSettings).toHaveBeenCalledWith({ patch: { interactiveCards: true } })
    expect(getHelperScriptBundle).toHaveBeenCalledTimes(2)
    expect(renderOutputText).toHaveBeenCalledTimes(2)
    // 后台脚本宿主 iframe + 发言气泡交互卡 iframe 均已挂载
    expect(liveView.root.findAllByType('iframe')).toHaveLength(2)

    // 气泡新挂载的卡面发送 helperFrameReady 后，cycleRef 已随目标变化复位，必须再次发出 character_message_rendered
    for (const frame of frames) {
      await act(async () => {
        postFromFrame(frame, { action: 'helperFrameReady' })
      })
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(renderedEvents.count()).toBe(2)
  })
})

describe('批量渲染与楼层状态批处理竞态隔离', () => {
  it('renderOutputBatched 同窗重复请求自动去重，坏项单点隔离且无批量接口时抛错返回标准错误信封', async () => {
    // 1. 同窗相同 (messageId, text) 只发单条 RPC（模拟 StrictMode 双挂载）
    const singleRender = vi.fn(async () =>
      ok({
        text: '合并结果',
        interactiveCards: false,
        whitelist: [],
        greetings: [],
        greetingIndex: 0,
        canSwipeGreeting: false,
      }),
    )
    const batchSpy = vi.fn()
    const dedupRemote = {
      renderOutputText: singleRender,
      renderOutputTexts: batchSpy,
    } as unknown as TavernRemote

    const [dupA, dupB] = await Promise.all([
      renderOutputBatched(dedupRemote, { sessionId: 's-dedup', text: '相同正文', messageId: 1 }),
      renderOutputBatched(dedupRemote, { sessionId: 's-dedup', text: '相同正文', messageId: 1 }),
    ])
    expect(batchSpy).not.toHaveBeenCalled()
    expect(singleRender).toHaveBeenCalledOnce()
    expect(dupA).toEqual(dupB)

    // 2. 批量返回中单个条目结构损坏时，只让坏条目失败，合法条目照常成功
    const malformedBatch = {
      items: [
        {
          ok: true,
          value: {
            text: '正常气泡',
            interactiveCards: false,
            whitelist: [],
            greetings: [],
            greetingIndex: 0,
            canSwipeGreeting: false,
          },
        },
        null,
      ],
    } as unknown as RenderedOutputBatch
    const partialRemote = {
      renderOutputText: vi.fn(),
      renderOutputTexts: vi.fn(async () => ok(malformedBatch)),
    } as unknown as TavernRemote

    const [goodItem, badItem] = await Promise.all([
      renderOutputBatched(partialRemote, { sessionId: 's-partial', text: '第一条', messageId: 1 }),
      renderOutputBatched(partialRemote, { sessionId: 's-partial', text: '第二条', messageId: 2 }),
    ])
    expect(goodItem.ok).toBe(true)
    expect(badItem.ok).toBe(false)

    // 3. 旧宿主无 renderOutputTexts 且 renderOutputText 同步抛错时返回错误信封而非未捕获异常
    const legacyThrowRemote = {
      renderOutputText: vi.fn(() => {
        throw new Error('网络断连')
      }),
    } as unknown as TavernRemote
    const fallbackRes = await renderOutputBatched(legacyThrowRemote, { sessionId: 's-legacy', text: '测试' })
    expect(fallbackRes).toEqual({ ok: false, error: { code: 'render-failed', message: '网络断连' } })
  })

  it('floorActionStateBatched 在按 32 条切片前先全局去重，避免超长会话双挂载拆成多次重复 RPC', async () => {
    const getFloorActionStates = vi.fn<TavernRemote['getFloorActionStates']>(async ({ messageIds }) =>
      ok({
        items: messageIds.map((id) => ({
          greeting: { isGreeting: false, started: true, swipe: null },
          siblings: { swipe: null },
          canContinue: id === 'm-2',
        })),
      }),
    )
    const remote = { getFloorActionStates } as unknown as TavernRemote

    const calls = Array.from({ length: 80 }, (_, index) =>
      floorActionStateBatched(remote, { sessionId: 's-80', messageId: index % 2 === 0 ? 'm-1' : 'm-2' }),
    )
    const results = await Promise.all(calls)
    expect(getFloorActionStates).toHaveBeenCalledExactlyOnceWith({ sessionId: 's-80', messageIds: ['m-1', 'm-2'] })
    expect(results[0]).toEqual(ok({
      greeting: { isGreeting: false, started: true, swipe: null },
      siblings: { swipe: null },
      canContinue: false,
    }))
    expect(results[1]).toEqual(ok({
      greeting: { isGreeting: false, started: true, swipe: null },
      siblings: { swipe: null },
      canContinue: true,
    }))
  })
})

describe('楼层操作条竞态与卸载安全', () => {
  it('绑定刷新期间历史楼层不闪现续写按钮，全层不可续写时清除旧末层记录，且卸载后兄弟分支切换异常不泄漏副作用', async () => {
    const sessionId = 'session-floor-guard'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const swipe = { turn: 2, index: 0, total: 2, siblings: [sessionId, 'session-sibling-2'] }
    let pendingReload: PromiseWithResolvers<Envelope<TavernMethodResults['getFloorActionStates']>> | null = null
    let callCount = 0
    const getFloorActionStates = vi.fn<TavernRemote['getFloorActionStates']>(({ messageIds }) => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          ok({
            items: messageIds.map((id) => ({
              greeting: { isGreeting: false, started: true, swipe: null },
              siblings: { swipe: id === 'm-2' ? swipe : null },
              canContinue: id === 'm-2',
            })),
          }),
        )
      }
      pendingReload = Promise.withResolvers()
      return pendingReload.promise
    })

    const refreshGate = Promise.withResolvers<void>()
    const remote = {
      getSessionBinding: vi.fn(async () =>
        ok({ binding: defaultBinding(sessionId, 'card-1'), userName: '旅人', canSwipeGreeting: false, conversationStarted: true }),
      ),
      getFloorActionStates,
    } as unknown as TavernRemote
    const sessions = { open: vi.fn(), refresh: vi.fn(() => refreshGate.promise) }
    const useSessions = <T,>(select: (s: { byId: Record<string, { projectionValues: { agentPreset: string } }> }) => T): T =>
      select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <div>
          <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-1" useSessions={useSessions} />
          <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-2" useSessions={useSessions} />
        </div>,
      )
    })
    mounted.push(view)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    expect(view.root.findAllByProps({ 'aria-label': t('actions.continue') })).toHaveLength(1)

    // 触发绑定变更使两层同时进入重新加载（floorState === null）：m-1 绝不能在重拉期间闪现续写按钮
    await act(async () => {
      windowEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
    expect(pendingReload).not.toBeNull()
    expect(view.root.findAllByProps({ 'aria-label': t('actions.continue') })).toHaveLength(1)

    // 返回两层均不可续写（例如新轮次已开启），所有续写按钮必须收起
    await act(async () => {
      pendingReload!.resolve(
        ok({
          items: [
            { greeting: { isGreeting: false, started: true, swipe: null }, siblings: { swipe: null }, canContinue: false },
            { greeting: { isGreeting: false, started: true, swipe: null }, siblings: { swipe }, canContinue: false },
          ],
        }),
      )
    })
    expect(view.root.findAllByProps({ 'aria-label': t('actions.continue') })).toHaveLength(0)

    // 点击切换下一兄弟分支后立即卸载组件，迟到的异常不得触发重载或打开子会话
    const branchNextBtn = view.root.findByProps({ 'aria-label': t('actions.branchNext') })
    await act(async () => {
      branchNextBtn.props.onClick()
    })
    mounted.splice(mounted.indexOf(view), 1)
    await act(async () => {
      view.unmount()
    })
    const callsBeforeReject = getFloorActionStates.mock.calls.length
    await act(async () => {
      refreshGate.reject(new Error('卸载后的分支切换失败'))
    })
    expect(getFloorActionStates.mock.calls.length).toBe(callsBeforeReject)
    expect(sessions.open).not.toHaveBeenCalled()
  })
})

describe('实时宿主事件订阅与 MVU 失败退避', () => {
  it('installHelperLiveEvents 响应无 detail 全局绑定变更重探测，且乱序 settle-assistant 受 MAX_QUEUE 上限保护', async () => {
    const sessionId = 'session-live-events'
    let snapshot: SessionEventWindow = {
      revision: 1,
      hasOlder: false,
      entries: [],
      change: { kind: 'replace' },
    }
    const listeners = new Set<() => void>()
    const eventSource: SessionEventSource = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const emitSnapshot = (next: SessionEventWindow) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    }

    let currentStoryId = 'story-a'
    let holdDispatchGate: PromiseWithResolvers<Envelope<TavernMethodResults['getHelperEventState']>> | null = null
    const getHelperEventState = vi.fn<TavernRemote['getHelperEventState']>(() => {
      if (holdDispatchGate) return holdDispatchGate.promise
      return Promise.resolve(ok({ storyId: currentStoryId, closedThrough: 9999, messages: [] }))
    })

    const storyNotifications: string[] = []
    cleanups.push(watchHelperStory(sessionId, 'story-b', () => storyNotifications.push('story-b')))
    const storyBWatcher = subscribeHostEventCounter(sessionId, 'story-b', 'message_received')

    cleanups.push(markSessionView(sessionId, true))
    const stopLive = installHelperLiveEvents(
      { binding: (id) => (id === sessionId ? { sessionId, eventSource } as NonNullable<ReturnType<NonNullable<Parameters<typeof installHelperLiveEvents>[0]['binding']>>> : undefined) },
      { getHelperEventState },
    )
    cleanups.push(stopLive)

    await act(async () => {
      await Promise.resolve()
    })
    expect(getHelperEventState).toHaveBeenCalledTimes(1)

    // notifyAllSessionBindingsChanged 派发的无 detail 事件也必须触发当前会话重探测 storyId
    currentStoryId = 'story-b'
    await act(async () => {
      windowEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT))
      await Promise.resolve()
    })
    expect(getHelperEventState).toHaveBeenCalledTimes(2)
    expect(storyNotifications).toContain('story-b')

    // 挂起消费中的 dispatch RPC，堆积满 256 个待处理信号后再注入乱序 settle-assistant，必须触发预算上限并安全重置
    holdDispatchGate = Promise.withResolvers()
    let seq = 10
    // 第 1 轮先开始并结束：消费协程拿走 start，队列剩余 1 个 end(turn=1)
    emitSnapshot({
      revision: 2,
      hasOlder: false,
      entries: [],
      change: {
        kind: 'append',
        entries: [
          { type: 'event', event: { type: 'turn/start', seq: ++seq, time: seq, data: { turn: 1 } } as SessionEvent },
          { type: 'event', event: { type: 'turn/end', seq: ++seq, time: seq, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent },
        ],
      },
    })
    // 再塞入 255 条 user/message 使待处理队列刚好达到 MAX_QUEUE (1 + 255 = 256)
    const userEntries = Array.from({ length: 255 }, () => {
      const nextSeq = ++seq
      return {
        type: 'event' as const,
        event: {
          type: 'user/message',
          surfaceOp: 'append',
          seq: nextSeq,
          time: nextSeq,
          data: { role: 'user', content: [{ type: 'text', text: 'x' }] },
        } as unknown as SessionEvent,
      }
    })
    emitSnapshot({
      revision: 3,
      hasOlder: false,
      entries: [],
      change: { kind: 'append', entries: userEntries },
    })
    expect(storyBWatcher.errors).toHaveLength(0)

    // 此时乱序到达 turn=1 的 settle-assistant（走 splice 分支），必须命中 MAX_QUEUE 保护而非越界膨胀
    emitSnapshot({
      revision: 4,
      hasOlder: false,
      entries: [],
      change: {
        kind: 'settle-assistant',
        entry: {
          type: 'event',
          event: {
            type: 'assistant/message',
            surfaceOp: 'append',
            seq: 11,
            time: 11,
            data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } },
          } as unknown as SessionEvent,
        },
      },
    })
    expect(storyBWatcher.errors.some((msg) => msg.includes('待处理预算'))).toBe(true)
    holdDispatchGate.resolve(ok({ storyId: currentStoryId, closedThrough: 9999, messages: [] }))
  })

  it('HelperMvuRunner 在 commitHelperMvuJob 失败但持有未提交结果时按租约续期退避，不触发每秒空转轮询', async () => {
    vi.useFakeTimers()
    const sessionId = 'session-mvu-backoff'
    const storyId = 'story-mvu'
    const snapshot = makeHelperSnapshot(storyId, 1)
    const work: HelperMvuWork = {
      status: 'pending',
      token: 'mvu-lease-token',
      snapshot,
      job: {
        id: 'job-1',
        turn: 1,
        messageId: 1,
        rawText: '更新状态',
      } as NonNullable<HelperMvuWork['job']>,
    }

    const prepareHelperMvuJob = vi.fn<TavernRemote['prepareHelperMvuJob']>(async () => ok(work))
    let shouldFailCommit = true
    const commitHelperMvuJob = vi.fn<TavernRemote['commitHelperMvuJob']>(async () =>
      shouldFailCommit ? fail('剧情锁繁忙') : ok({ status: 'idle' }),
    )
    const remote = { prepareHelperMvuJob, commitHelperMvuJob } as unknown as TavernRemote

    let mvuFrame!: FakeFrame
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<HelperMvuRunner remote={remote} sessionId={sessionId} storyId={storyId} snapshot={snapshot} ready />, {
        createNodeMock: (element) => {
          if (element.type !== 'iframe') return null
          mvuFrame = { postMessage: vi.fn(), runtimeId: 'mvu-rt-1' }
          queueMicrotask(() => {
            postFromFrame(mvuFrame, { action: 'helperEventConnect' })
            postFromFrame(mvuFrame, { action: 'helperMvuReady' })
          })
          return { contentWindow: mvuFrame }
        },
      })
    })
    mounted.push(view)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(prepareHelperMvuJob).toHaveBeenCalledTimes(1)
    const runCall = mvuFrame.postMessage.mock.calls.find((call) => call[0]?.action === 'helperMvuRun')?.[0] as { requestId: string } | undefined
    expect(runCall?.requestId).toBeTruthy()

    // 沙箱计算完成返回结果，但首次 commit 失败
    await act(async () => {
      postFromFrame(mvuFrame, { action: 'helperMvuResult', requestId: runCall!.requestId, ok: true, data: { hp: 9 } })
      await Promise.resolve()
    })
    expect(commitHelperMvuJob).toHaveBeenCalledTimes(1)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('剧情锁繁忙')

    // 推进 5 秒：由于租约续期在 20 秒后，绝不能每秒唤醒空跑 5 次 poll()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(prepareHelperMvuJob).toHaveBeenCalledTimes(1)

    // 到 20 秒续租窗口正常续期 1 次以保住未提交结果的租约
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100)
    })
    expect(prepareHelperMvuJob).toHaveBeenCalledTimes(2)

    // 用户点击重试，直接提交已有结果并恢复就绪
    shouldFailCommit = false
    const retryBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('speech.mvuRetry'))!
    await act(async () => {
      retryBtn.props.onClick()
      await Promise.resolve()
    })
    expect(commitHelperMvuJob).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })
})

describe('持久草稿、面板分页与表单在途互斥保护', () => {
  it('共享 PersistentEditor 中单个子编辑器调用 clearDraft 只清除自身脏态，不误删未挂载子页签的待恢复草稿', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let stored: { value: unknown; updatedAt: string } | null = {
      value: {
        version: 1,
        fields: {
          'eager:text': '当前页脏草稿',
          'lazy:text': '尚未打开页签的草稿',
        },
      },
      updatedAt: new Date(0).toISOString(),
    }
    const draftRemote = {
      getEditorDraft: vi.fn(async () => ok({ draft: structuredClone(stored) })),
      saveEditorDraft: vi.fn(async ({ value }: TavernMethodRequests['saveEditorDraft']) => {
        stored = { value: structuredClone(value), updatedAt: new Date().toISOString() }
        return ok({ saved: true })
      }),
      deleteEditorDraft: vi.fn(async () => {
        stored = null
        return ok({ deleted: true })
      }),
    } as unknown as TavernRemote

    function EagerSubEditor() {
      const [text, setText] = useDraftState('eager:text', '默认')
      const guard = useDraftGuard(text !== '默认')
      return (
        <div>
          <input aria-label="当前页输入" value={text} onChange={(e) => setText(e.target.value)} />
          <button
            data-action="discard-eager"
            onClick={() => {
              setText('默认')
              guard.clearDraft()
            }}
          >
            放弃当前页
          </button>
        </div>
      )
    }

    function LazySubEditor() {
      const [text] = useDraftState('lazy:text', '懒加载默认')
      useDraftGuard(text !== '懒加载默认')
      return <textarea aria-label="懒加载输入" value={text} readOnly />
    }

    function PanelShell() {
      const [showLazy, setShowLazy] = useState(false)
      return (
        <PersistentEditor remote={draftRemote} scope="panel">
          <EagerSubEditor />
          <button data-action="open-lazy" onClick={() => setShowLazy(true)}>打开懒加载子页</button>
          {showLazy ? <LazySubEditor /> : null}
        </PersistentEditor>
      )
    }

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<PanelShell />)
    })
    mounted.push(view)
    expect(view.root.findByProps({ 'aria-label': '当前页输入' }).props.value).toBe('当前页脏草稿')

    // 当前子编辑器点击放弃并清理自身草稿：不能触发整包 deleteEditorDraft 清空懒加载子页签
    await act(async () => {
      view.root.findByProps({ 'data-action': 'discard-eager' }).props.onClick()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })

    expect(stored).not.toBeNull()
    expect((stored?.value as { fields: Record<string, unknown> }).fields['lazy:text']).toBe('尚未打开页签的草稿')
    await act(async () => {
      view.root.findByProps({ 'data-action': 'open-lazy' }).props.onClick()
    })
    expect(view.root.findByProps({ 'aria-label': '懒加载输入' }).props.value).toBe('尚未打开页签的草稿')
  })

  it('LorebookEditor 删除第 2 页唯一条目后页码归位，并在复制第 40 条跨页生成副本时自动翻到新页展开', async () => {
    const entries = Array.from({ length: 41 }, (_, index) => makeWorldEntry(index + 1))
    const remote = {
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <DraftScope>
          {() => (
            <LorebookEditor
              target={{ kind: 'library', name: '测试世界书' }}
              entries={entries}
              revision="rev-1"
              save={async () => ok({ revision: 'rev-2' })}
              onClose={() => {}}
              remote={remote}
            />
          )}
        </DraftScope>,
      )
    })
    mounted.push(view)

    // 翻到第 2 页（仅第 41 条）并展开删除它
    const nextBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('lorebookEditor.pager.next'))
    await act(async () => {
      nextBtn()!.props.onClick()
    })
    const expandRow41 = view.root.findAllByType('button').find((b) => instanceText(b).includes('条目-41'))!
    await act(async () => {
      expandRow41.props.onClick({ stopPropagation: () => {} })
    })
    const deleteIcon = view.root.findByProps({ 'aria-label': t('lorebookEditor.deleteEntry') })
    await act(async () => {
      deleteIcon.props.onClick({ stopPropagation: () => {} })
    })
    await act(async () => {
      view.root.findAllByType(ConfirmDialog)[0]!.props.onConfirm()
    })
    // 剩 40 条共 1 页，分页栏消失且页码同步归位到第 1 页
    expect(nextBtn()).toBeUndefined()

    // 展开第 1 页末尾的第 40 条并点击「复制条目」：新副本落在索引 40（第 2 页首条），应自动翻到第 2 页并展开副本表单
    const expandRow40 = view.root.findAllByType('button').find((b) => instanceText(b).includes('条目-40'))!
    await act(async () => {
      expandRow40.props.onClick({ stopPropagation: () => {} })
    })
    const duplicateBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('lorebookEditor.duplicateEntry'))!
    await act(async () => {
      duplicateBtn.props.onClick()
    })
    const commentInputs = view.root.findAllByProps({ placeholder: t('lorebookEditor.form.commentPlaceholder') })
    expect(commentInputs).toHaveLength(1)
    expect(String(commentInputs[0]!.props.value)).toContain('条目-40')
  })

  it('LorebooksSection 删除世界书在途期间阻止点击卡片重新打开该书', async () => {
    const deleteGate = Promise.withResolvers<Envelope<TavernMethodResults['deleteLorebook']>>()
    const getLorebook = vi.fn<TavernRemote['getLorebook']>(async () => ok({ name: '设定集', json: { entries: {} }, revision: 'r1' }))
    const remote = {
      listLorebooks: vi.fn(async () => ok({ items: ['设定集'] })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      getLorebook,
      deleteLorebook: vi.fn(() => deleteGate.promise),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<LorebooksSection remote={remote} />)
    })
    mounted.push(view)

    // 点删除图标并确认删除（RPC 挂起在途）
    const trashBtn = view.root.findByProps({ 'aria-label': t('lorebooks.deleteBook') })
    await act(async () => {
      trashBtn.props.onClick({ stopPropagation: () => {} })
    })
    await act(async () => {
      view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!.props.onConfirm()
    })

    // 删除尚未返回时点击卡片试图打开世界书，必须被同步锁拦截
    const cardNode = view.root.findAllByProps({ className: 'dsh-tavern-tileTrigger' }).find((node) => instanceText(node).includes('设定集'))!
    expect(cardNode.props.disabled).toBe(true)
    await act(async () => {
      cardNode.props.onClick()
    })
    expect(getLorebook).not.toHaveBeenCalled()

    await act(async () => {
      deleteGate.resolve(ok({ deleted: true }))
    })
  })

  it('RegexSection 放弃修改同步清理持久草稿并重置 40 条分页上限，导入读取文件期间锁定操作按钮', async () => {
    const initialRules = Array.from({ length: 45 }, (_, index) => makeRegexRule(index + 1))
    let deletedDraft = false
    const remote = {
      listRegexRules: vi.fn(async () => ok({ rules: initialRules, revision: 'rev-1' })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      saveRegexRules: vi.fn(async () => ok({ revision: 'rev-2' })),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => {
        deletedDraft = true
        return ok({ deleted: true })
      }),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <PersistentEditor remote={remote} scope="regex-test">
          <RegexSection remote={remote} />
        </PersistentEditor>,
      )
    })
    mounted.push(view)

    expect(view.root.findAllByProps({ 'aria-label': t('regex.ruleName') })).toHaveLength(40)
    // 点击加载更多展开全部 45 条并修改首条名称，随后确认放弃修改
    const loadMoreBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('common.loadMore'))!
    await act(async () => {
      loadMoreBtn.props.onClick()
    })
    expect(view.root.findAllByProps({ 'aria-label': t('regex.ruleName') })).toHaveLength(45)

    await act(async () => {
      view.root.findAllByProps({ 'aria-label': t('regex.ruleName') })[0]!.props.onChange({ target: { value: '临时改名' } })
    })
    const discardBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.discard'))!
    await act(async () => {
      discardBtn.props.onClick()
    })
    await act(async () => {
      view.root.findByType(ConfirmDialog).props.onConfirm()
    })
    expect(view.root.findAllByProps({ 'aria-label': t('regex.ruleName') })).toHaveLength(40)
    expect(view.root.findAllByProps({ 'aria-label': t('regex.ruleName') })[0]!.props.value).toBe('规则-1')
    expect(deletedDraft).toBe(true)

    // 导入异步读取文件期间操作按钮与 FileBtn 均进入 busy 禁用态
    const fileGate = Promise.withResolvers<string>()
    const fakeFile = { name: 'imported.json', text: () => fileGate.promise } as unknown as File
    const fileBtn = view.root.findByType(FileBtn)
    await act(async () => {
      fileBtn.props.onFile(fakeFile)
      await Promise.resolve()
    })
    expect(view.root.findByType(FileBtn).props.disabled).toBe(true)
    const saveAllBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.saveAll'))!
    expect(saveAllBtn.props.disabled).toBe(true)

    await act(async () => {
      fileGate.resolve(JSON.stringify([{ scriptName: '导入规则', findRegex: 'abc', replaceString: 'def' }]))
      await Promise.resolve()
    })
    expect(view.root.findByType(FileBtn).props.disabled).toBe(false)
  })

  it('HelperScriptEditor 切换不同目标脚本库时自动重置搜索词、错误态与选中项；TavernHeaderChip 保存期间禁用表单控件；CharacterPicker 清空搜索恢复 24 条分页', async () => {
    const baseDraftRemote = {
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    }

    // 1. HelperScriptEditor 切换目标复位局部状态
    const libA = { cardId: 'card-a', revision: 'r1', trees: parseHelperScriptTrees([{ id: 's-a', name: '脚本A', content: '' }]) }
    const libB = { cardId: 'card-b', revision: 'r1', trees: parseHelperScriptTrees([{ id: 's-b', name: '脚本B', content: '' }]) }
    let editorView!: ReactTestRenderer
    await act(async () => {
      editorView = create(
        <PersistentEditor remote={baseDraftRemote as unknown as TavernRemote} scope="panel">
          <HelperScriptEditor remote={baseDraftRemote as unknown as TavernRemote} library={libA} onClose={() => {}} onSaved={() => {}} />
        </PersistentEditor>,
      )
    })
    mounted.push(editorView)
    await act(async () => {
      editorView.root.findByType(SearchInput).props.onChange('过滤A')
    })
    expect(editorView.root.findByType(SearchInput).props.value).toBe('过滤A')

    await act(async () => {
      editorView.update(
        <PersistentEditor remote={baseDraftRemote as unknown as TavernRemote} scope="panel">
          <HelperScriptEditor remote={baseDraftRemote as unknown as TavernRemote} library={libB} onClose={() => {}} onSaved={() => {}} />
        </PersistentEditor>,
      )
    })
    expect(editorView.root.findByType(SearchInput).props.value).toBe('')
    expect(editorView.root.findAllByType(Btn).some((b) => b.props.children === '脚本B')).toBe(true)

    // 2. TavernHeaderChip 在 saveBinding 在途时禁用 fieldset / Select / CheckChips / Toggle / textarea
    const chipSessionId = 'session-chip-busy'
    invalidateSessionBinding(chipSessionId)
    invalidateCharacter('card-1')
    const saveGate = Promise.withResolvers<Envelope<TavernMethodResults['setSessionBinding']>>()
    const chipRemote = {
      getSessionBinding: vi.fn(async () =>
        ok({ binding: defaultBinding(chipSessionId, 'card-1'), userName: '旅人', canSwipeGreeting: true, conversationStarted: false }),
      ),
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      getCharacter: vi.fn(async () =>
        ok({
          cardId: 'card-1',
          card: {
            name: '守望者',
            description: '',
            personality: '',
            scenario: '',
            firstMes: '你好',
            mesExample: '',
            creatorNotes: '',
            systemPrompt: '',
            postHistoryInstructions: '',
            alternateGreetings: [],
            tags: [],
            creator: '',
            characterVersion: '',
            extensions: {},
          },
          hasAvatar: false,
          hasCharacterBook: false,
          revision: 'rev-1',
        }),
      ),
      listCharacters: vi.fn(async () => ok({ items: [makeCharacterSummary(1)] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: ['世界书一'] })),
      setSessionBinding: vi.fn(() => saveGate.promise),
    } as unknown as TavernRemote
    const useSessions = <T,>(select: (s: { byId: Record<string, { projectionValues: { agentPreset: string } }> }) => T): T =>
      select({ byId: { [chipSessionId]: { projectionValues: { agentPreset: 'tavern' } } } })

    let chipView!: ReactTestRenderer
    await act(async () => {
      chipView = create(<TavernHeaderChip remote={chipRemote} sessionId={chipSessionId} sessions={{ open: vi.fn() }} useSessions={useSessions} />)
    })
    mounted.push(chipView)

    // 打开会话角色设置弹窗并修改作者注释后点击保存
    await act(async () => {
      chipView.root.findByType(TavernSeatChip).props.onClick()
    })
    await act(async () => {
      chipView.root.findByType('textarea').props.onChange({ target: { value: '悬疑氛围' } })
    })
    const saveBtn = chipView.root.findAllByType(Btn).find((b) => b.props.children === t('binding.save'))!
    await act(async () => {
      saveBtn.props.onClick()
    })

    expect(chipView.root.findByType('fieldset').props.disabled).toBe(true)
    expect(chipView.root.findAllByType(Select).every((s) => s.props.disabled === true)).toBe(true)
    expect(chipView.root.findAllByType(CheckChips).every((c) => c.props.disabled === true)).toBe(true)
    expect(chipView.root.findAllByType(Toggle).every((tg) => tg.props.disabled === true)).toBe(true)
    expect(chipView.root.findByType('textarea').props.disabled).toBe(true)

    await act(async () => {
      saveGate.resolve(ok({ binding: { ...defaultBinding(chipSessionId, 'card-1'), authorNote: '悬疑氛围' } }))
    })

    // 3. CharacterPicker 展开更多后通过无结果提示的清空按钮复位回 24 条分页
    const thirtyChars = Array.from({ length: 30 }, (_, index) => makeCharacterSummary(index + 1))
    const pickerRemote = {
      listCharacters: vi.fn(async () => ok({ items: thirtyChars })),
    } as unknown as TavernRemote
    let pickerView!: ReactTestRenderer
    await act(async () => {
      pickerView = create(<CharacterPicker remote={pickerRemote} busy={false} error={null} onPick={() => {}} onClose={() => {}} />)
    })
    mounted.push(pickerView)

    expect(pickerView.root.findAllByProps({ className: 'dsh-tavern-pickerItem' })).toHaveLength(24)
    const moreBtn = pickerView.root.findAllByType(Btn).find((b) => b.props.children === t('hero.picker.more'))!
    await act(async () => {
      moreBtn.props.onClick()
    })
    expect(pickerView.root.findAllByProps({ className: 'dsh-tavern-pickerItem' })).toHaveLength(30)

    await act(async () => {
      pickerView.root.findByType(SearchInput).props.onChange('不存在的角色名')
    })
    await act(async () => {
      pickerView.root.findByType(SearchEmpty).props.onClear()
    })
    expect(pickerView.root.findAllByProps({ className: 'dsh-tavern-pickerItem' })).toHaveLength(24)
  })
})
