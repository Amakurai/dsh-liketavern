/**
 * Client UI、iframe 桥接与表单生命周期第三轮缺陷修复回归测试（C1–C15 + #7 Bug #13）：
 * - C1: SpeechHtmlFrame 区分 staging(readOnly) 与 refreshing，活跃卡面重载/失败时不把 helperEventEmit 冒充 ok:true，也不吞掉在途 *Applied 回执
 * - C2: HelperMvuRunner 计算期间续租瞬时失败保留 running 与退避重试，不丢弃计算结果；超时/租约变更后沙箱忙时重建 iframe 避免重复执行冲突
 * - C3: HelperMvuRunner 的 mvuCancel / mvuRestart 经 scriptStatusStore 暴露至 ScriptSettings 可见可操作，错误态文案不再复用按钮文案
 * - C4: HelperScripts 在重拉/错误态保留脚本变更与资产订阅；脚本恢复就绪清除同代 failures，但 openHelperFrame 失败时不误清
 * - C5: 后台脚本改写消息分支导航失败后在 ScriptSettings 可见报错并提供手动「打开消息编辑分支」恢复按钮
 * - C6: installHelperLiveEvents 在绑定变更探测被 eventSource replace 中断后强制重新 initialize，不残留旧 storyId
 * - C7: installHelperLiveEvents 轮中打开/replace 且 turn/end 先于 settle-assistant 到达时完整派发事件且不泄漏 view.turns
 * - C8: DraftScope 不向 PersistentEditor 重复登记影子脏态，恢复叶编辑器 guard.clearDraft() 同步删草稿契约
 * - C9: TavernHeroCharacter 选卡/开聊/切开场白共享同步互斥锁，且陈旧绑定清扫 catch 在用户已选卡后不污染状态
 * - C10: SpeechBubble 定向 refreshOneMessage(id) 不被无关的加载中/失败气泡提前中止
 * - C11: SpeechHtmlFrame 在 document.write 运行时重建时重置 legacyHeight，恢复标准 resize 高度更新
 * - C12 (+ #7 Bug #13): SpeechBubble / DisplayProjection / GreetingPreview 统一对齐服务端 interactive 公式，GreetingPreview 响应式依赖完整且 interactive=false 不误标互动卡提示
 * - C13: HeaderChip 中 HelperMvuAbandonAction 与记忆按钮共享写入锁，阻止与保存/解绑并发写入
 * - C14: SettingsSection 恢复草稿时同步远端 locale，且世界书合并策略下拉项完成中英文 i18n
 * - C15: RegexSection 保存/切换期间禁用 RuleEditor 并拦截改写，预设正则冲突后可就地刷新修订
 */
import { useState, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT } from '../src/client/actions.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { TavernHeaderChip } from '../src/client/chip.js'
import { bumpDisplaySettingsRevision } from '../src/client/displayPrefs.js'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { prepareHelperDisplay } from '../src/client/helperDisplay.js'
import * as helperEventRouter from '../src/client/helperEventRouter.js'
import { installHelperLiveEvents } from '../src/client/helperLiveEvents.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { watchHelperStory } from '../src/client/helperNotifications.js'
import { notifyHelperScriptAssets, notifyHelperScripts } from '../src/client/helperScriptNotifications.js'
import { HelperScripts } from '../src/client/helperScripts.js'
import { TavernHeroCharacter } from '../src/client/hero.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { ScriptSettings } from '../src/client/panel/scripts.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { SpeechBubble, SpeechHtmlFrame } from '../src/client/speech.js'
import type { Envelope, SessionBinding, TavernRemote, TavernSettings } from '../src/client/types.js'
import { Btn, ConfirmDialog, IconBtn, Select, Toggle } from '../src/client/util.js'
import type { HelperMvuWork } from '../src/core/helperMvu.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import type { RegexRule } from '../src/core/types.js'
import { TavernConfigSchema } from '../src/node/config.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode; items?: Array<{ key: string; label: string; onSelect?: () => void }> }) => (
    <div data-menu="" data-items={JSON.stringify((props.items ?? []).map((i) => i.label))}>{props.anchor}</div>
  ),
  MarkdownText: (props: { text: string }) => <p data-md="">{props.text}</p>,
  IconBranchOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronLeftOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
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
const fail = (message: string, code = 'audit-error'): Envelope<never> => ({ ok: false, error: { code, message } })

interface FakeFrame {
  postMessage: ReturnType<typeof vi.fn>
}

let events: EventTarget
const mounted: ReactTestRenderer[] = []
const cleanups: Array<() => void> = []

function dispatchFrom(source: FakeFrame, data: Record<string, unknown>) {
  const event = new Event('message')
  Object.defineProperties(event, {
    source: { value: source },
    data: { value: data },
  })
  events.dispatchEvent(event)
}

function makeSnapshot(storyId = 'story-1', currentMessageId = 1, historyRevision = 'rev-1'): HelperSnapshot {
  return {
    storyId,
    historyRevision,
    currentMessageId,
    messages: [
      { message_id: 0, name: 'U', role: 'user', is_hidden: false, message: 'hi', data: {}, extra: {} },
      { message_id: 1, name: 'A', role: 'assistant', is_hidden: false, message: 'reply', data: {}, extra: {} },
    ],
    scopes: {},
    writable: true,
  }
}

function makeSettings(overrides: Partial<TavernSettings> = {}): TavernSettings {
  return { ...TavernConfigSchema({}), ...overrides }
}

function makeBinding(sessionId: string, cardId = 'card-1', overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sessionId,
    cardId,
    cardName: 'Alice',
    storyId: 'story-1',
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    authorNote: '',
    injectJournal: false,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function tavernSessionsHook(sessionId: string) {
  const state = { byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } }
  return (selector: (s: typeof state) => unknown) => selector(state)
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'children' in node) return textOf((node as { children: unknown }).children)
  return ''
}

beforeEach(() => {
  setTavernLocale('zh')
  events = new EventTarget()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', Object.assign(events, {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
      removeItem: (k: string) => { storage.delete(k) },
    },
  }))
  vi.stubGlobal('document', {
    documentElement: {},
    body: {},
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
  while (cleanups.length) cleanups.pop()!()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Client UI、桥接与表单第三轮修复回归 (C1–C15 + #7 Bug #13)', () => {
  it('C1: 活跃卡面 refreshing=true 时对 helperEventEmit 明确返回 ok:false 且不吞掉在途 helperMessageEditApplied；staging(readOnly) 保持原语义', async () => {
    const frameWin: FakeFrame = { postMessage: vi.fn() }
    const snapshot = makeSnapshot('story-c1')
    const onMessageBranch = vi.fn(async () => {})
    const onMessageEdit = vi.fn(async () => ({ branch: { childSessionId: 'child-c1', title: '编辑分支' } }))
    const onViolation = vi.fn()
    const remote = {
      openHelperFrame: vi.fn(async () => ok({ token: 'tok-c1' })),
      closeHelperFrame: vi.fn(async () => ok({ closed: true })),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <SpeechHtmlFrame
          srcDoc="<html></html>"
          title="live-card"
          widget
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 'sess-c1', storyId: 'story-c1' }}
          onMessageEdit={onMessageEdit}
          onMessageBranch={onMessageBranch}
          onReadOnlyViolation={onViolation}
        />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWin } : {}) },
      )
    })
    mounted.push(view)

    // 先在正常态发起并完成 helperMessageEdit，等待卡面回执 helperMessageEditApplied。
    await act(async () => {
      dispatchFrom(frameWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-c1' })
      await Promise.resolve()
      dispatchFrom(frameWin, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEdit',
        runtimeId: 'rt-c1',
        requestId: 'edit-1',
        storyId: snapshot.storyId,
        historyRevision: snapshot.historyRevision,
        edits: [{ message_id: 1, message: 'updated' }],
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onMessageEdit).toHaveBeenCalledOnce()

    // 切换为活跃卡面重载/失败态（refreshing=true, readOnly=false）。
    await act(async () => {
      view.update(
        <SpeechHtmlFrame
          srcDoc="<html></html>"
          title="live-card"
          widget
          refreshing
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 'sess-c1', storyId: 'story-c1' }}
          onMessageEdit={onMessageEdit}
          onMessageBranch={onMessageBranch}
          onReadOnlyViolation={onViolation}
        />,
      )
    })

    // 活跃卡面重载态下 helperEventEmit 必须返回 ok:false，不得冒充成功，也不应误触发 staging violation。
    await act(async () => {
      dispatchFrom(frameWin, {
        source: 'dsh-tavern-card',
        action: 'helperEventEmit',
        runtimeId: 'rt-c1',
        requestId: 'ev-live',
        eventName: 'custom',
        args: [1],
      })
      // 已落盘编辑的 Applied 回执不得被 refreshing 吞掉。
      dispatchFrom(frameWin, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEditApplied',
        runtimeId: 'rt-c1',
        requestId: 'edit-1',
      })
      await Promise.resolve()
    })
    const liveEmitReply = frameWin.postMessage.mock.calls.find((c) => c[0]?.requestId === 'ev-live')?.[0]
    expect(liveEmitReply).toMatchObject({ action: 'helperEventResult', ok: false, error: t('speech.helperDisplayBusy') })
    expect(onViolation).not.toHaveBeenCalled()
    expect(onMessageBranch).toHaveBeenCalledExactlyOnceWith({ childSessionId: 'child-c1', title: '编辑分支' })

    // 对照：候选预演 readOnly=true 仍对 helperEventEmit 无副作用返回 ok:true。
    const stagingWin: FakeFrame = { postMessage: vi.fn() }
    let stagingView!: ReactTestRenderer
    await act(async () => {
      stagingView = create(
        <SpeechHtmlFrame srcDoc="<html></html>" title="staging" widget readOnly onReadOnlyViolation={onViolation} />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: stagingWin } : {}) },
      )
    })
    mounted.push(stagingView)
    await act(async () => {
      dispatchFrom(stagingWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-stg' })
      dispatchFrom(stagingWin, {
        source: 'dsh-tavern-card',
        action: 'helperEventEmit',
        runtimeId: 'rt-stg',
        requestId: 'ev-stg',
        eventName: 'render',
        args: ['ok'],
      })
    })
    const stagingReply = stagingWin.postMessage.mock.calls.find((c) => c[0]?.requestId === 'ev-stg')?.[0]
    expect(stagingReply).toMatchObject({ action: 'helperEventResult', ok: true, args: ['ok'] })
  })

  it('C2: HelperMvuRunner 计算中续租瞬时失败保留 running 与退避重试并接收计算结果；超时后沙箱忙时重试重建 iframe', async () => {
    vi.useFakeTimers()
    const snapshot = makeSnapshot('story-c2')
    const work: HelperMvuWork = {
      storyId: 'story-c2',
      enabled: true,
      status: 'pending',
      job: { id: 'b'.repeat(64), identity: 'm1', seq: 2, kind: 'initialize', text: 'hi', turn: 0, floor: 's#t0' },
      token: 'tok-c2',
      snapshot,
      base: {},
    }
    let prepareCalls = 0
    const prepareHelperMvuJob = vi.fn<TavernRemote['prepareHelperMvuJob']>(async () => {
      prepareCalls++
      if (prepareCalls === 2) return fail('瞬时网络抖动')
      return ok(work)
    })
    const commitHelperMvuJob = vi.fn<TavernRemote['commitHelperMvuJob']>(async () => ok({ status: 'idle' } as never))
    const remote = { prepareHelperMvuJob, commitHelperMvuJob } as unknown as TavernRemote

    const frames: FakeFrame[] = []
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <HelperMvuRunner remote={remote} sessionId="sess-c2" storyId="story-c2" snapshot={snapshot} ready />,
        {
          createNodeMock: (el) => {
            if (el.type !== 'iframe') return {}
            const win: FakeFrame = { postMessage: vi.fn() }
            frames.push(win)
            return { contentWindow: win }
          },
        },
      )
    })
    mounted.push(view)

    await act(async () => {
      dispatchFrom(frames[0]!, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-1' })
      dispatchFrom(frames[0]!, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'rt-1' })
      await Promise.resolve()
    })
    expect(prepareCalls).toBe(1)
    const runMsg1 = frames[0]!.postMessage.mock.calls.find((c) => c[0]?.action === 'helperMvuRun')?.[0] as { requestId: string }
    expect(runMsg1?.requestId).toBeTruthy()

    // 20s 续租触发瞬时失败：不能中止 running 或停轮询，5s 后退避续租成功并清错。
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100) })
    expect(prepareCalls).toBe(2)
    expect(JSON.stringify(view.toJSON())).toContain('瞬时网络抖动')
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    expect(prepareCalls).toBe(3)
    expect(JSON.stringify(view.toJSON())).not.toContain('瞬时网络抖动')

    // 沙箱随后返回计算结果：必须正常提交，而非因续租曾失败被静默丢弃。
    await act(async () => {
      dispatchFrom(frames[0]!, {
        source: 'dsh-tavern-card',
        action: 'helperMvuResult',
        runtimeId: 'rt-1',
        requestId: runMsg1.requestId,
        ok: true,
        data: { stat_data: { hp: 88 } },
      })
      await Promise.resolve()
    })
    expect(commitHelperMvuJob).toHaveBeenCalledOnce()

    // 场景 B：沙箱超时未返回（sandboxBusy=true）时点击重试，应重建隔离 iframe 避免碰撞旧沙箱 busy 锁。
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    const runMsg2 = frames[0]!.postMessage.mock.calls.filter((c) => c[0]?.action === 'helperMvuRun').at(-1)?.[0]
    expect(runMsg2).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(305_000) })
    expect(JSON.stringify(view.toJSON())).toContain(t('speech.mvuExecutionTimeout'))
    const retryBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('speech.mvuRetry'))!
    await act(async () => { retryBtn.props.onClick() })
    expect(frames.length).toBe(2)
  })

  it('C3: HelperMvuRunner 的取消等待与租约重建恢复入口在 ScriptSettings 中可见可操作，且错误态文案准确', async () => {
    vi.useFakeTimers()
    const snapshot = makeSnapshot('story-c3')
    const work1: HelperMvuWork = {
      storyId: 'story-c3',
      enabled: true,
      status: 'pending',
      job: { id: 'c'.repeat(64), identity: 'm1', seq: 2, kind: 'initialize', text: 'hi', turn: 0, floor: 's#t0' },
      token: 'tok-1',
      snapshot,
      base: {},
    }
    let prepareCount = 0
    const cancelSpy = vi.fn(async () => {})
    const mvuFrames: FakeFrame[] = []
    const remote = {
      getHelperScriptBundle: vi.fn(async () => ok({
        sessionId: 'sess-c3',
        storyId: 'story-c3',
        cardId: 'card-c3',
        revision: 'v1',
        enabled: true,
        helperMvu: true,
        messageId: 1,
        snapshot,
        trees: [],
        libraries: [],
        worldbooks: [],
        whitelist: [],
      })),
      prepareHelperMvuJob: vi.fn(async () => {
        prepareCount++
        return ok(prepareCount === 1 ? work1 : { ...work1, token: 'tok-2' })
      }),
      commitHelperMvuJob: vi.fn(async () => ok({ status: 'idle' })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <>
          <HelperScripts remote={remote} sessionId="sess-c3" cardId="card-c3" onCancel={cancelSpy} />
          <ScriptSettings remote={remote} />
        </>,
        {
          createNodeMock: (el) => {
            if (el.type !== 'iframe') return {}
            const win: FakeFrame = { postMessage: vi.fn() }
            mvuFrames.push(win)
            return { contentWindow: win }
          },
        },
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)

    await act(async () => {
      dispatchFrom(mvuFrames[0]!, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-c3' })
      dispatchFrom(mvuFrames[0]!, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'rt-c3' })
      await Promise.resolve()
    })

    // 取消等待按钮必须在可见的 ScriptSettings 中可点击并触发 onCancel。
    const settingsNode = view.root.findByType(ScriptSettings)
    const cancelBtn = settingsNode.findAllByType(Btn).find((b) => b.props.children === t('speech.mvuCancel'))
    expect(cancelBtn).toBeDefined()
    await act(async () => { cancelBtn!.props.onClick(); await Promise.resolve() })
    expect(cancelSpy).toHaveBeenCalledOnce()

    // 推进 20s 触发租约变更：ScriptSettings 应显示 runtime.error 状态与 mvuRestart 按钮，而非把 mvuRetry 当状态文字。
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100) })
    const runtimeText = textOf(settingsNode.findByProps({ className: 'dsh-tavern-scriptRuntime' }))
    expect(runtimeText).toContain(t('settings.scripts.runtime.error'))
    expect(runtimeText).toContain(t('speech.mvuLeaseChanged'))
    const restartBtn = settingsNode.findAllByType(Btn).find((b) => b.props.children === t('speech.mvuRestart'))
    expect(restartBtn).toBeDefined()
    await act(async () => { restartBtn!.props.onClick(); await Promise.resolve() })
    // 沙箱忙时点击重启重建 iframe。
    expect(mvuFrames.length).toBe(2)
  })

  it('C4: HelperScripts 在重拉/报错期间不丢失脚本变更通知，且脚本重连就绪后清除同代 failures 解锁 MVU', async () => {
    const snapshot = makeSnapshot('story-c4')
    const scriptTree = [{ type: 'script', id: 'sc-1', name: 'Helper1', enabled: true, content: 'console.log(1)', info: '', data: {}, buttons: [] }]
    const makeBundle = (rev: string) => ({
      sessionId: 'sess-c4',
      storyId: 'story-c4',
      cardId: 'card-c4',
      revision: rev,
      enabled: true,
      helperMvu: true,
      messageId: 1,
      snapshot,
      trees: scriptTree,
      libraries: [
        { target: { type: 'preset' as const, presetId: 'preset-c4' }, revision: rev, trees: scriptTree },
      ],
      worldbooks: [],
      whitelist: [],
    })
    let bundleCall = 0
    const getHelperScriptBundle = vi.fn<TavernRemote['getHelperScriptBundle']>(async () => {
      bundleCall++
      if (bundleCall === 2) return fail('临时读取失败')
      return ok(makeBundle(`v${bundleCall}`))
    })
    const openHelperFrame = vi.fn(async () => ok({ token: 'tok-frame' }))
    const closeHelperFrame = vi.fn(async () => ok({ closed: true }))
    const prepareHelperMvuJob = vi.fn(async () => ok({ storyId: 'story-c4', enabled: true, status: 'idle' } as HelperMvuWork))
    const remote = { getHelperScriptBundle, openHelperFrame, closeHelperFrame, prepareHelperMvuJob } as unknown as TavernRemote

    const frameByTitle = new Map<string, FakeFrame>()
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<HelperScripts remote={remote} sessionId="sess-c4" cardId="card-c4" />, {
        createNodeMock: (el) => {
          if (el.type !== 'iframe') return {}
          const win: FakeFrame = { postMessage: vi.fn() }
          frameByTitle.set(String(el.props.title), win)
          return { contentWindow: win }
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)
    expect(getHelperScriptBundle).toHaveBeenCalledTimes(1)

    // 1. 触发一次失败重拉（bundle=undefined, status=error），再发 preset 资产变更与会话脚本变更通知：仍须触发重载恢复。
    await act(async () => { notifyHelperScripts('sess-c4', 'story-c4'); await Promise.resolve() })
    expect(getHelperScriptBundle).toHaveBeenCalledTimes(2)
    await act(async () => { notifyHelperScriptAssets({ type: 'preset', presetId: 'preset-c4' }); await Promise.resolve(); await Promise.resolve() })
    expect(getHelperScriptBundle).toHaveBeenCalledTimes(3)

    // 2. 脚本先报一次 diagnostic 失败：同运行时发来 helperScriptReady ok:true 绝不能清除故障或放行 MVU；
    //    只有新运行时重连（rt-s2）触发重置并就绪后，才清除旧故障并解锁 MVU 轮询。
    const scriptWin = frameByTitle.get('Helper1')!
    const mvuWin = frameByTitle.get(t('speech.mvuTitle'))!
    await act(async () => {
      dispatchFrom(mvuWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-mvu' })
      dispatchFrom(mvuWin, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'rt-mvu' })
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-s1' })
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperScriptDiagnostic', runtimeId: 'rt-s1', error: '瞬时脚本异常' })
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperScriptReady', runtimeId: 'rt-s1', ok: true })
      await Promise.resolve()
    })
    expect(prepareHelperMvuJob).not.toHaveBeenCalled()

    await act(async () => {
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-s2' })
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperScriptReady', runtimeId: 'rt-s2', ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(prepareHelperMvuJob).toHaveBeenCalled()
  })

  it('C5: 后台脚本改写消息分支导航失败后在 ScriptSettings 可见报错并可通过手动按钮打开分支', async () => {
    cleanups.push(markSessionView('sess-c5', true))
    const snapshot = makeSnapshot('story-c5')
    const scriptTree = [{ type: 'script', id: 'sc-edit', name: 'EditorScript', enabled: true, content: 'void 0', info: '', data: {}, buttons: [] }]
    let shouldFailOpen = true
    const sessions = {
      open: vi.fn(() => {
        if (shouldFailOpen) throw new Error('导航服务暂不可用')
      }),
      refresh: vi.fn(async () => {}),
    }
    const remote = {
      getHelperScriptBundle: vi.fn(async () => ok({
        sessionId: 'sess-c5',
        storyId: 'story-c5',
        cardId: 'card-c5',
        revision: 'v1',
        enabled: true,
        helperMvu: false,
        messageId: 1,
        snapshot,
        trees: scriptTree,
        libraries: [{ target: { type: 'character' as const, cardId: 'card-c5' }, revision: 'v1', trees: scriptTree }],
        worldbooks: [],
        whitelist: [],
      })),
      openHelperFrame: vi.fn(async () => ok({ token: 'tok-c5' })),
      closeHelperFrame: vi.fn(async () => ok({ closed: true })),
      editHelperMessages: vi.fn(async () => ok({ branch: { childSessionId: 'child-c5', title: '编辑后的分支' } })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    let scriptWin!: FakeFrame
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <>
          <HelperScripts remote={remote} sessionId="sess-c5" cardId="card-c5" sessions={sessions} />
          <ScriptSettings remote={remote} />
        </>,
        {
          createNodeMock: (el) => {
            if (el.type !== 'iframe') return {}
            scriptWin = { postMessage: vi.fn() }
            return { contentWindow: scriptWin }
          },
        },
      )
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    mounted.push(view)

    await act(async () => {
      dispatchFrom(scriptWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-c5' })
      for (let i = 0; i < 6; i++) await Promise.resolve()
      dispatchFrom(scriptWin, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEdit',
        runtimeId: 'rt-c5',
        requestId: 'edit-bg',
        storyId: snapshot.storyId,
        historyRevision: snapshot.historyRevision,
        edits: [{ message_id: 1, message: 'bg-edited' }],
      })
      for (let i = 0; i < 10; i++) await Promise.resolve()
      dispatchFrom(scriptWin, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEditApplied',
        runtimeId: 'rt-c5',
        requestId: 'edit-bg',
      })
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    const settingsNode = view.root.findByType(ScriptSettings)
    expect(textOf(settingsNode)).toContain('导航服务暂不可用')
    const openBtn = settingsNode.findAllByType(Btn).find((b) => b.props.children === t('speech.openEditedBranch'))
    expect(openBtn).toBeDefined()

    shouldFailOpen = false
    await act(async () => {
      openBtn!.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(sessions.open).toHaveBeenLastCalledWith('child-c5')
    expect(settingsNode.findAllByType(Btn).find((b) => b.props.children === t('speech.openEditedBranch'))).toBeUndefined()
  })

  it('C6: installHelperLiveEvents 绑定变更探测被 replace 中断后重新 initialize 获取新 storyId', async () => {
    const emitted: Array<{ storyId: string; event: string }> = []
    const hostErrors: unknown[] = []
    vi.spyOn(helperEventRouter, 'emitHelperHostEvent').mockImplementation(async (_sid, storyId, event, _data, current) => {
      if (current && !current()) return
      emitted.push({ storyId, event: String(event) })
    })
    vi.spyOn(helperEventRouter, 'reportHelperHostEventError').mockImplementation((_sid, _storyId, err) => {
      hostErrors.push(err)
    })

    cleanups.push(markSessionView('sess-c6', true))
    let rev = 1
    let currentSnap: SessionEventWindow = { revision: rev, change: { kind: 'replace' }, entries: [] } as unknown as SessionEventWindow
    const subs = new Set<() => void>()
    const source: SessionEventSource = {
      getSnapshot: () => currentSnap,
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn) },
    } as unknown as SessionEventSource
    const push = (change: unknown, entries = currentSnap.entries) => {
      rev++
      currentSnap = { revision: rev, change, entries } as unknown as SessionEventWindow
      for (const fn of subs) fn()
    }

    let callIndex = 0
    const probeGate = Promise.withResolvers<Envelope<{ storyId: string; closedThrough: number; messages: [] }>>()
    const remote = {
      getHelperEventState: vi.fn(async () => {
        callIndex++
        if (callIndex === 1) return ok({ storyId: 'story-old', closedThrough: 0, messages: [] })
        if (callIndex === 2) return probeGate.promise
        return ok({ storyId: 'story-new', closedThrough: 10, messages: [{ seq: 5, role: 'user' as const, message_id: 0 }] })
      }),
    }

    cleanups.push(installHelperLiveEvents(
      { binding: () => ({ sessionId: 'sess-c6', eventSource: source }) as never },
      remote as never,
    ))
    await new Promise((r) => setTimeout(r, 15))
    expect(callIndex).toBe(1)

    // 发起绑定变更探测，尚未回包前 eventSource 触发 replace 中断该探测。
    events.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 'sess-c6' }))
    expect(callIndex).toBe(2)
    push({ kind: 'replace' }, [])
    probeGate.resolve(ok({ storyId: 'story-old', closedThrough: 0, messages: [] }))
    await new Promise((r) => setTimeout(r, 15))

    // 必须已重新 initialize 到 story-new，后续实时事件不得因旧 storyId 报错。
    push({ kind: 'append', entries: [{ type: 'event', event: { seq: 5, type: 'user/message', time: 1, data: { text: 'hi' } } as unknown as SessionEvent }] })
    await new Promise((r) => setTimeout(r, 15))
    expect(hostErrors).toEqual([])
    expect(emitted).toContainEqual({ storyId: 'story-new', event: 'message_sent' })
  })

  it('C7: installHelperLiveEvents 轮中打开/replace 且 turn/end 先于 settle-assistant 到达时完整派发并不泄漏槽位', async () => {
    const emitted: Array<{ event: string; data: unknown[] }> = []
    const hostErrors: unknown[] = []
    const storyNotified = vi.fn()
    vi.spyOn(helperEventRouter, 'emitHelperHostEvent').mockImplementation(async (_sid, _storyId, event, data, current) => {
      if (current && !current()) return
      emitted.push({ event: String(event), data: [...data] })
    })
    vi.spyOn(helperEventRouter, 'reportHelperHostEventError').mockImplementation((_sid, _storyId, err) => {
      hostErrors.push(err)
    })

    cleanups.push(markSessionView('sess-c7', true))
    cleanups.push(watchHelperStory('sess-c7', 'story-c7', storyNotified))
    let rev = 1
    let currentSnap: SessionEventWindow = {
      revision: rev,
      change: { kind: 'replace' },
      entries: [
        // 基线中 turn 1 已开始尚未结束。
        { type: 'event', event: { seq: 1, type: 'turn/start', time: 0, data: { turn: 1 } } as unknown as SessionEvent },
      ],
    } as unknown as SessionEventWindow
    const subs = new Set<() => void>()
    const source: SessionEventSource = {
      getSnapshot: () => currentSnap,
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn) },
    } as unknown as SessionEventSource
    const push = (change: unknown) => {
      rev++
      currentSnap = { ...currentSnap, revision: rev, change } as unknown as SessionEventWindow
      for (const fn of subs) fn()
    }

    const remote = {
      getHelperEventState: vi.fn(async () => ok({
        storyId: 'story-c7',
        closedThrough: 100,
        messages: [{ seq: 2, role: 'assistant' as const, message_id: 0 }],
      })),
    }

    cleanups.push(installHelperLiveEvents(
      { binding: () => ({ sessionId: 'sess-c7', eventSource: source }) as never },
      remote as never,
    ))
    await new Promise((r) => setTimeout(r, 15))

    // turn/end 先到达，随后 settle-assistant 迟到补发。
    push({
      kind: 'append',
      entries: [{ type: 'event', event: { seq: 3, type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent }],
    })
    push({
      kind: 'settle-assistant',
      entry: { type: 'event', event: { seq: 2, type: 'assistant/message', time: 1, data: { turn: 1, interrupted: false } } as unknown as SessionEvent },
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(hostErrors).toEqual([])
    expect(emitted).toEqual([
      { event: 'message_received', data: [0, 'normal'] },
      { event: 'generation_ended', data: [0] },
    ])
    expect(storyNotified).toHaveBeenCalled()

    // 孤立 turn/end（基线无 turn/start）后若来迟到 settle-assistant，不得伪造消息接收，也不泄漏 view.turns 槽位。
    for (let turn = 10; turn < 85; turn++) {
      push({
        kind: 'append',
        entries: [{ type: 'event', event: { seq: turn * 10 + 2, type: 'turn/end', time: 1, data: { turn, reason: { kind: 'completed' } } } as unknown as SessionEvent }],
      })
      push({
        kind: 'settle-assistant',
        entry: { type: 'event', event: { seq: turn * 10 + 1, type: 'assistant/message', time: 1, data: { turn, interrupted: false } } as unknown as SessionEvent },
      })
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(hostErrors).toEqual([])
    expect(emitted).toHaveLength(2)
  })

  it('C8: PersistentEditor 嵌套多层 DraftScope 时，叶编辑器 clearDraft 后立刻卸载会同步删草稿而非重存脏快照', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let stored: unknown = null
    const saveEditorDraft = vi.fn(async ({ value }: { value: unknown }) => { stored = structuredClone(value); return ok({ saved: true }) })
    const deleteEditorDraft = vi.fn(async () => { stored = null; return ok({ deleted: true }) })
    const remote = {
      getEditorDraft: vi.fn(async () => ok({ draft: stored ? { value: stored, updatedAt: new Date(0).toISOString() } : null })),
      saveEditorDraft,
      deleteEditorDraft,
    } as unknown as TavernRemote

    function Leaf(props: { onClosePanel: () => void }) {
      const [text, setText] = useDraftState('leaf:text', 'base')
      const guard = useDraftGuard(text !== 'base')
      return (
        <>
          <input value={text} onChange={(e) => setText(e.target.value)} />
          <button
            data-action="save-and-close"
            onClick={() => {
              guard.clearDraft()
              props.onClosePanel()
            }}
          >
            保存并关闭
          </button>
        </>
      )
    }

    function PanelHarness() {
      const [open, setOpen] = useState(true)
      if (!open) return <span>panel-closed</span>
      return (
        <PersistentEditor remote={remote} scope="panel">
          <DraftScope>
            {() => (
              <DraftScope>
                {() => <Leaf onClosePanel={() => setOpen(false)} />}
              </DraftScope>
            )}
          </DraftScope>
        </PersistentEditor>
      )
    }

    let view!: ReactTestRenderer
    await act(async () => { view = create(<PanelHarness />) })
    mounted.push(view)

    await act(async () => { view.root.findByType('input').props.onChange({ target: { value: '已编辑草稿' } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(550) })
    expect(stored).toEqual({ version: 1, fields: { 'leaf:text': '已编辑草稿' } })
    const savesBeforeClose = saveEditorDraft.mock.calls.length

    // 保存并同步卸载 PersistentEditor：不能因为外层 DraftScope 影子 dirty=true 把草稿重存回去。
    await act(async () => { view.root.findByProps({ 'data-action': 'save-and-close' }).props.onClick() })
    await act(async () => { await Promise.resolve() })
    expect(deleteEditorDraft).toHaveBeenCalledOnce()
    expect(saveEditorDraft.mock.calls.length).toBe(savesBeforeClose)
    expect(stored).toBeNull()
  })

  it('C9: TavernHeroCharacter 同步写互斥防连点重入，且清扫失败 catch 在用户已选卡后不污染状态', async () => {
    const clearGate = Promise.withResolvers<Envelope<{ cleared: boolean }>>()
    const bindGate = Promise.withResolvers<Envelope<{ binding: SessionBinding }>>()
    const staleBinding = makeBinding('sess-c9', 'old-card')
    let activeBinding: SessionBinding = staleBinding

    const clearSessionBinding = vi.fn(() => clearGate.promise)
    const setSessionBinding = vi.fn(async ({ binding }: { binding: SessionBinding }) => {
      activeBinding = binding
      return bindGate.promise
    })
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding: activeBinding, conversationStarted: false, userName: 'User' })),
      clearSessionBinding,
      setSessionBinding,
      getSettings: vi.fn(async () => ok({ settings: makeSettings() })),
      listCharacters: vi.fn(async () => ok({
        items: [
          { cardId: 'old-card', name: 'Old', creator: '', tags: [], hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 },
          { cardId: 'new-card', name: 'New', creator: '', tags: [], hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 },
        ],
      })),
      getCharacterDetail: vi.fn(async ({ cardId }: { cardId: string }) => ok({
        cardId,
        revision: 'r1',
        name: cardId === 'new-card' ? 'New' : 'Old',
        description: '',
        personality: '',
        scenario: '',
        firstMes: 'Hello',
        alternateGreetings: ['Alt'],
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        creator: '',
        characterVersion: '',
        tags: [],
        spec: 'chara_card_v2',
        hasCharacterBook: false,
        characterBookName: null,
        characterBookEntryCount: 0,
        hasAvatar: false,
        extensions: {},
      })),
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, html: null, htmls: [], interactiveCards: true })),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <TavernHeroCharacter
          remote={remote}
          sessionId="sess-c9"
          sessions={{ open: vi.fn(), refresh: vi.fn(async () => {}) }}
          session={{ blank: true, promptAttempted: false }}
          useSessions={tavernSessionsHook('sess-c9')}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)
    expect(clearSessionBinding).toHaveBeenCalledOnce()

    // 在清扫挂起期间，打开角色选择器并同步连点选卡两次：互斥锁只允许一次写请求。
    const chipBtn = view.root.findByProps({ 'aria-haspopup': 'dialog' })
    await act(async () => {
      chipBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const pickNew = view.root.findAllByProps({ className: 'dsh-tavern-pickerItem' }).find((n) => textOf(n).includes('New'))!
    await act(async () => {
      pickNew.props.onClick()
      pickNew.props.onClick()
    })

    // 清扫 RPC 在选卡等待期间抛错：catch 须因 picking.current=true 跳过 sweepFailed 与重置 sweptSession，
    // 不能在选卡完成后二次清扫新绑定的角色，也不出现可清扫新卡的 alert 重试横幅。
    await act(async () => {
      clearGate.reject(new Error('清扫超时'))
      await Promise.resolve()
      await Promise.resolve()
      bindGate.resolve(ok({ binding: activeBinding }))
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })

    expect(setSessionBinding).toHaveBeenCalledOnce()
    expect(clearSessionBinding).toHaveBeenCalledOnce()
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })

  it('C10: 定向 refreshOneMessage(id) 不被同一会话中无关的失败/加载中气泡提前中止', async () => {
    const snap0 = makeSnapshot('story-c10', 0, 'rev-c10')
    const snap1 = makeSnapshot('story-c10', 1, 'rev-c10')
    let b1Renders = 0
    const remote = {
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputTexts: vi.fn(async ({ items }: { items: Array<{ messageId?: number; text: string }> }) => ok({
        items: items.map((item) => item.messageId === 0
          ? { ok: false as const, error: { code: 'ERR', message: '旧气泡渲染失败' } }
          : { ok: true as const, value: { text: `ok-${++b1Renders}`, html: null, htmls: [], interactiveCards: true, helperContext: { storyId: 'story-c10', historyRevision: 'rev-c10', currentMessageId: 1, currentMessageRole: 'assistant' as const } } }),
      })),
      renderOutputText: vi.fn(async () => ok({
        text: `refreshed-${++b1Renders}`,
        html: null,
        htmls: [],
        interactiveCards: true,
        helperContext: { storyId: 'story-c10', historyRevision: 'rev-c10', currentMessageId: 1, currentMessageRole: 'assistant' as const },
      })),
      getHelperSnapshot: vi.fn(async ({ messageId }: { messageId: number }) => ok(messageId === 0 ? snap0 : snap1)),
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <>
          <SpeechBubble remote={remote} sessionId="sess-c10" cardId="card-1" name="A" rawText="m0" messageId={0} />
          <SpeechBubble remote={remote} sessionId="sess-c10" cardId="card-1" name="A" rawText="m1" messageId={1} />
        </>,
      )
      await new Promise((r) => setTimeout(r, 30))
    })
    mounted.push(view)

    // 仅刷新 messageId=1：气泡 0 虽处于 error 态，但不在 ids=[1] 中，不得把定向刷新整批中止。
    const lease = await prepareHelperDisplay('sess-c10', { storyId: 'story-c10', historyRevision: 'rev-c10', ids: [1] })
    await act(async () => {
      lease.commit()
      await Promise.resolve()
    })
    lease.cancel()
    expect(remote.renderOutputText).toHaveBeenCalledOnce()
  })

  it('C11: SpeechHtmlFrame 在 document.write 运行时重建后重置 legacyHeight，恢复标准 resize 更新', async () => {
    const frameWin: FakeFrame = { postMessage: vi.fn() }
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<SpeechHtmlFrame srcDoc="<html></html>" title="resize-card" widget />, {
        createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWin } : {}),
      })
    })
    mounted.push(view)

    await act(async () => {
      dispatchFrom(frameWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-old' })
      dispatchFrom(frameWin, { type: 'iframe-resize', height: 420, runtimeId: 'rt-old' })
    })
    expect(view.root.findByType('iframe').props.style.height).toBe(420)

    // 运行时切换（document.write 重建）后标准 resize 必须重新生效。
    await act(async () => {
      dispatchFrom(frameWin, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-new' })
      dispatchFrom(frameWin, { source: 'dsh-tavern-card', action: 'resize', runtimeId: 'rt-new', height: 260 })
    })
    expect(view.root.findByType('iframe').props.style.height).toBe(260)
  })

  it('C12 + #7 Bug #13: 客户端 interactive 与服务端公式对齐；GreetingPreview 响应设置与卡变更，禁用态不误标互动卡提示', async () => {
    // 1. SpeechBubble：会话级 interactiveCards=true 但服务端全局关闭（value.interactiveCards=false）时，不得渲染 iframe 也不做 normalizeHostMarkdown。
    const bubbleRemote = {
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputTexts: vi.fn(async () => ok({
        items: [{
          ok: true as const,
          value: {
            text: '```html\n<div>raw</div>\n```',
            html: null,
            htmls: ['<div>should-not-iframe</div>'],
            parts: [{ kind: 'html' as const, text: '<div>should-not-iframe</div>' }],
            interactiveCards: false,
          },
        }],
      })),
    } as unknown as TavernRemote

    let bubbleView!: ReactTestRenderer
    await act(async () => {
      bubbleView = create(
        <SpeechBubble remote={bubbleRemote} sessionId="sess-c12" cardId="card-1" name="A" rawText="<div>raw</div>" interactiveCards={true} />,
      )
      await new Promise((r) => setTimeout(r, 30))
    })
    mounted.push(bubbleView)
    expect(bubbleView.root.findAllByType('iframe')).toHaveLength(0)

    // 2. GreetingPreview：绑定 presetId/cardId/revision/displaySettingsRevision 变化时重载；禁用态遇到 html part 不误报 interactiveGreeting。
    // 空白会话初始无陈旧绑定（避免被 Hero 自动清扫），再通过 BINDING_CHANGED_EVENT 绑定角色进入预览。
    let binding: SessionBinding | null = null
    let serverInteractive = false
    const renderOutputText = vi.fn(async () => ok({
      text: 'Hello',
      html: null,
      htmls: ['<div>card</div>'],
      parts: [
        { kind: 'markdown' as const, text: 'Hello' },
        { kind: 'html' as const, text: '<div>card</div>' },
      ],
      interactiveCards: serverInteractive,
    }))
    const heroRemote = {
      getSessionBinding: vi.fn(async () => ok({ binding, conversationStarted: false, userName: 'User' })),
      clearSessionBinding: vi.fn(async () => ok({ cleared: true })),
      listCharacters: vi.fn(async () => ok({ items: [] })),
      getCharacterDetail: vi.fn(async ({ cardId }: { cardId: string }) => ok({
        cardId,
        revision: 'rev-1',
        name: 'Alice',
        description: '',
        personality: '',
        scenario: '',
        firstMes: 'Same Greeting',
        alternateGreetings: [],
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        creator: '',
        characterVersion: '',
        tags: [],
        spec: 'chara_card_v2',
        hasCharacterBook: false,
        characterBookName: null,
        characterBookEntryCount: 0,
        hasAvatar: false,
        extensions: {},
      })),
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      renderOutputText,
    } as unknown as TavernRemote

    let heroView!: ReactTestRenderer
    await act(async () => {
      heroView = create(
        <TavernHeroCharacter
          remote={heroRemote}
          sessionId="sess-hero-c12"
          sessions={{ open: vi.fn() }}
          session={{ blank: true, promptAttempted: false }}
          useSessions={tavernSessionsHook('sess-hero-c12')}
        />,
      )
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    mounted.push(heroView)
    binding = makeBinding('sess-hero-c12', 'card-a', { interactiveCards: true, presetId: 'p1' })
    await act(async () => {
      events.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 'sess-hero-c12' }))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(renderOutputText).toHaveBeenCalledTimes(1)
    // 全局关闭（serverInteractive=false）即使会话 interactiveCards=true，也不应显示「含互动卡面」。
    expect(JSON.stringify(heroView.toJSON())).not.toContain(t('hero.interactiveGreeting'))

    // 切换全局展示设置修订号：即使开场白文本不变，GreetingPreview 也须重新调用 renderOutputText。
    serverInteractive = true
    await act(async () => {
      bumpDisplaySettingsRevision()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(renderOutputText).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(heroView.toJSON())).toContain(t('hero.interactiveGreeting'))

    // 切换预设绑定：相同开场白文本下也须触发重载。
    binding = makeBinding('sess-hero-c12', 'card-a', { interactiveCards: true, presetId: 'p2' })
    await act(async () => {
      events.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 'sess-hero-c12' }))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(renderOutputText).toHaveBeenCalledTimes(3)
  })

  it('C13: HeaderChip 中 HelperMvuAbandonAction 与记忆按钮共享写入锁，阻止与保存并发', async () => {
    invalidateSessionBinding('sess-c13')
    const saveGate = Promise.withResolvers<Envelope<{ binding: SessionBinding }>>()
    const abandonGate = Promise.withResolvers<Envelope<{ abandoned: boolean }>>()
    const binding = makeBinding('sess-c13', 'card-1', { storyId: 'story-c13' })
    const setSessionBinding = vi.fn(() => saveGate.promise)
    const abandonHelperMvu = vi.fn(() => abandonGate.promise)
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, conversationStarted: true, userName: 'User' })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
      listCharacters: vi.fn(async () => ok({ items: [{ cardId: 'card-1', name: 'Alice', creator: '', tags: [], hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 }] })),
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getCharacterDetail: vi.fn(async () => ok({ cardId: 'card-1', revision: 'r1', name: 'Alice', description: '', personality: '', scenario: '', firstMes: 'hi', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [], spec: 'chara_card_v2', hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0, hasAvatar: false, extensions: {} })),
      getCharacterAvatar: vi.fn(async () => ok({ dataUrl: null })),
      getHelperScriptBundle: vi.fn(async () => ok({ sessionId: 'sess-c13', storyId: 'story-c13', cardId: 'card-1', revision: 'v1', enabled: false, helperMvu: false, messageId: null, snapshot: null, trees: [], libraries: [], worldbooks: [], whitelist: [] })),
      setSessionBinding,
      abandonHelperMvu,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <TavernHeaderChip
          remote={remote}
          sessionId="sess-c13"
          sessions={{ open: vi.fn() }}
          useSessions={tavernSessionsHook('sess-c13')}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)

    // 打开绑定编辑弹窗。
    const trigger = view.root.findByProps({ 'aria-haspopup': 'dialog' })
    await act(async () => { trigger.props.onClick(); await Promise.resolve(); await Promise.resolve() })

    // 1. 保存绑定在途时，记忆按钮与放弃 MVU 按钮必须同步禁用。
    const saveBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('binding.save'))!
    await act(async () => { saveBtn.props.onClick() })
    const memBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('section.memory'))!
    const abandonBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('chip.mvuAbandon.action'))!
    expect(memBtn.props.disabled).toBe(true)
    expect(abandonBtn.props.disabled).toBe(true)

    await act(async () => { saveGate.resolve(ok({ binding })); await Promise.resolve(); await Promise.resolve() })

    // 2. 放弃 MVU 在途时，保存与记忆按钮也必须被互斥锁禁用。
    const abandonBtn2 = view.root.findAllByType(Btn).find((b) => b.props.children === t('chip.mvuAbandon.action'))!
    await act(async () => { abandonBtn2.props.onClick() })
    const confirmDialog = view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!
    await act(async () => { confirmDialog.props.onConfirm() })
    expect(abandonHelperMvu).toHaveBeenCalledOnce()
    const saveBtnDuringAbandon = view.root.findAllByType(Btn).find((b) => b.props.children === t('binding.save'))!
    const memBtnDuringAbandon = view.root.findAllByType(Btn).find((b) => b.props.children === t('section.memory'))!
    expect(saveBtnDuringAbandon.props.disabled).toBe(true)
    expect(memBtnDuringAbandon.props.disabled).toBe(true)
    await act(async () => { saveBtnDuringAbandon.props.onClick() })
    expect(setSessionBinding).toHaveBeenCalledOnce()

    await act(async () => { abandonGate.resolve(ok({ abandoned: true })); await Promise.resolve() })
  })

  it('C14: SettingsSection 恢复草稿时同步远端 locale，且世界书合并策略下拉选项走中英文 i18n', async () => {
    const remoteSettings = makeSettings({ locale: 'en', speakerHeader: false })
    const staleDraft = makeSettings({ locale: 'zh', sampling: { ...remoteSettings.sampling, temperature: 0.9 } })
    const savedSnapshot = {
      version: 1,
      fields: {
        'settings:sub': 'interface',
        'settings:draft': staleDraft,
        'settings:baseline': makeSettings({ locale: 'zh' }),
      },
    }
    const updateSettings = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ok({ settings: { ...remoteSettings, ...patch } }))
    const remote = {
      getEditorDraft: vi.fn(async () => ok({ draft: { value: savedSnapshot, updatedAt: new Date(0).toISOString() } })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
      getSettings: vi.fn(async () => ok({ settings: remoteSettings })),
      updateSettings,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <PersistentEditor remote={remote} scope="settings-c14">
          <SettingsSection remote={remote} />
        </PersistentEditor>,
      )
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)

    // 1. locale 应已从远端同步为 'en'，因此选回 'zh' 不会因旧草稿 draft.locale==='zh' 被短路。
    const localeSelect = view.root.findByType(Select)
    expect(localeSelect.props.value).toBe('en')
    await act(async () => { localeSelect.props.onChange('zh'); await Promise.resolve() })
    expect(updateSettings).toHaveBeenCalledWith({ patch: { locale: 'zh' } })

    // 2. 切到世界书引擎分组，核验合并策略三个选项在 zh 下为中文文案。
    const wiTab = view.root.findAllByProps({ role: 'tab' }).find((tab) => tab.props.children === t('settings.sub.worldinfo'))!
    await act(async () => { wiTab.props.onClick() })
    const strategySelect = view.root.findByType(Select)
    expect(strategySelect.props.options).toEqual([
      { value: '0', label: t('settings.worldinfo.strategy.evenly') },
      { value: '1', label: t('settings.worldinfo.strategy.characterFirst') },
      { value: '2', label: t('settings.worldinfo.strategy.globalFirst') },
    ])
    expect(strategySelect.props.options[0]!.label).toBe('均匀排序')
  })

  it('C15: RegexSection 保存期间禁用 RuleEditor 并拦截变更，预设正则冲突后支持就地刷新修订', async () => {
    const saveGate = Promise.withResolvers<Envelope<{ revision: string }>>()
    const initialRules: RegexRule[] = [
      { id: 'r1', name: 'Rule1', find: 'a', replace: 'b', enabled: true, scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'user' },
      { id: 'r2', name: 'Rule2', find: 'c', replace: 'd', enabled: true, scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'user' },
    ]
    let presetRev = 'prev-1'
    let failFirstToggle = true
    const savePreset = vi.fn(async ({ expectedRevision }: { expectedRevision?: string }) => {
      if (failFirstToggle) {
        failFirstToggle = false
        presetRev = 'prev-2'
        return fail('预设已被修改（修订冲突）')
      }
      return ok({ id: 'p1', revision: `${expectedRevision}-next` })
    })
    const remote = {
      listRegexRules: vi.fn(async () => ok({ rules: initialRules, revision: 'reg-1' })),
      saveRegexRules: vi.fn(() => saveGate.promise),
      listPresets: vi.fn(async () => ok({ items: [{ id: 'p1', name: 'P1', regexCount: 1 }] })),
      getPreset: vi.fn(async () => ok({
        revision: presetRev,
        preset: {
          identifier: 'p1',
          name: 'P1',
          regexScripts: [{ id: 'ps1', scriptName: 'PresetRule', findRegex: 'x', replaceString: 'y', disabled: false }],
        },
      })),
      savePreset,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<RegexSection remote={remote} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    mounted.push(view)

    // 1. 开始保存全局正则：RuleEditor 控件被禁用且回调被 saving.current 拦截。
    const saveAllBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.saveAll'))!
    await act(async () => { saveAllBtn.props.onClick() })
    const deleteBtns = view.root.findAllByType(IconBtn).filter((b) => b.props.label === t('regex.deleteRule'))
    expect(deleteBtns).toHaveLength(2)
    expect(deleteBtns[0]!.props.disabled).toBe(true)
    await act(async () => { deleteBtns[0]!.props.onClick() })
    // 规则未被误删。
    expect(view.root.findAllByType(IconBtn).filter((b) => b.props.label === t('regex.deleteRule'))).toHaveLength(2)

    await act(async () => { saveGate.resolve(ok({ revision: 'reg-2' })); await Promise.resolve() })

    // 2. 预设正则切换遭遇修订冲突后，点击预设区「刷新」就地重拉 prev-2 并重新切换成功。
    const presetToggle = view.root.findAllByType(Toggle).at(-1)!
    await act(async () => { presetToggle.props.onChange(false); await Promise.resolve() })
    expect(JSON.stringify(view.toJSON())).toContain('修订冲突')

    const refreshBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('action.refresh'))!
    await act(async () => { refreshBtn.props.onClick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    const presetToggleAfterRefresh = view.root.findAllByType(Toggle).at(-1)!
    await act(async () => { presetToggleAfterRefresh.props.onChange(false); await Promise.resolve() })
    expect(savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 'prev-2' }))
  })
})
