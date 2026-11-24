/**
 * Client UI 层缺陷修复回归测试：
 * 覆盖 HelperMvuRunner 在 helperSnapshotResult 回执中携带 runtimeId（修复 MVU 15s 超时）、
 * installHelperLiveEvents 对非完成/基线前轮次的迟到 settle-assistant 过滤与完成轮次 closedSeq 屏障、
 * SpeechHtmlFrame 在 editedBranch 为空时仍展示 branchError，
 * 以及 client/index.tsx 的按需 cancelWaiting 解析与 applyNode 部分注册失败回滚清理。
 */
import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as helperEventRouter from '../src/client/helperEventRouter.js'
import { installHelperLiveEvents } from '../src/client/helperLiveEvents.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { apply as applyClient } from '../src/client/index.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { SpeechBubble } from '../src/client/speech.js'
import type { ClientContext, TavernRemote } from '../src/client/types.js'
import type { HelperMvuWork } from '../src/core/helperMvu.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p>{props.text}</p>,
  IconBranchOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronLeftOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
}))

let view: ReactTestRenderer | undefined
let events: EventTarget

beforeEach(() => {
  events = new EventTarget()
  vi.stubGlobal('window', events)
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
})

afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Client UI 层缺陷修复回归', () => {
  it('F1: HelperMvuRunner 回复 helperSnapshotResult 时必须携带匹配的 runtimeId', async () => {
    vi.useFakeTimers()
    const source = { postMessage: vi.fn() }
    const snapshot: HelperSnapshot = {
      storyId: 'story-f1',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: false,
      scopes: {},
      messages: [{ message_id: 0, name: 'Alice', role: 'assistant', is_hidden: false, message: 'hi', data: {}, extra: {} }],
    }
    const work: HelperMvuWork = {
      storyId: 'story-f1',
      enabled: true,
      status: 'pending',
      token: 'tok-1',
      job: { id: 'a'.repeat(64), identity: 'm1', seq: 2, kind: 'initialize', text: 'hi', turn: 0, floor: 's#t0' },
      snapshot,
      base: {},
    }
    const remote = {
      prepareHelperMvuJob: vi.fn().mockResolvedValue({ ok: true, value: work }),
      commitHelperMvuJob: vi.fn().mockResolvedValue({ ok: true, value: { storyId: 'story-f1', enabled: true, status: 'idle' } }),
    } as unknown as TavernRemote

    await act(async () => {
      view = create(
        <HelperMvuRunner remote={remote} sessionId="s-f1" storyId="story-f1" snapshot={snapshot} ready={true} />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: source } : null) },
      )
    })

    const sendFromFrame = async (data: Record<string, unknown>) => {
      await act(async () => {
        const event = new Event('message')
        Object.defineProperties(event, {
          source: { value: source },
          data: { value: { source: 'dsh-tavern-card', runtimeId: 'mvu-rt-1', ...data } },
        })
        events.dispatchEvent(event)
      })
    }

    await sendFromFrame({ action: 'helperEventConnect' })
    await sendFromFrame({ action: 'helperMvuReady' })
    await sendFromFrame({ action: 'helperSnapshotGet', requestId: 'snap-req-1', storyId: 'story-f1' })

    const reply = source.postMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((m) => m.action === 'helperSnapshotResult' && m.requestId === 'snap-req-1')
    expect(reply).toBeDefined()
    expect(reply!.runtimeId).toBe('mvu-rt-1')
    expect(reply!.ok).toBe(true)
    expect(reply!.snapshot).toEqual(snapshot)
  })

  it('F2: installHelperLiveEvents 忽略基线前与非完成轮次的迟到 settle-assistant，并对完成轮次的迟到 settle 校验 closedSeq 屏障', async () => {
    const received: Array<{ event: string; data: unknown[] }> = []
    const hostErrors: unknown[] = []
    const unsub = markSessionView('s-f2', true)
    vi.spyOn(helperEventRouter, 'emitHelperHostEvent').mockImplementation(async (_sid, _storyId, event, data, current) => {
      if (current && !current()) return
      received.push({ event: String(event), data: [...data] })
    })
    vi.spyOn(helperEventRouter, 'reportHelperHostEventError').mockImplementation((_sid, _storyId, error) => {
      hostErrors.push(error)
    })

    let rev = 1
    let currentSnap: SessionEventWindow = {
      revision: rev,
      change: { kind: 'replace' },
      entries: [
        // 基线前已完成的 turn 0。
        { type: 'event', event: { seq: 1, type: 'turn/end', time: 0, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent },
      ],
    } as unknown as SessionEventWindow
    const subs = new Set<() => void>()
    const source: SessionEventSource = {
      getSnapshot: () => currentSnap,
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn) },
    } as unknown as SessionEventSource

    const pushSnap = (next: Partial<SessionEventWindow>) => {
      rev++
      currentSnap = { ...currentSnap, revision: rev, ...next } as SessionEventWindow
      for (const fn of subs) fn()
    }

    let closedThrough = 20
    const requestedClosedSeqs: Array<number | undefined> = []
    const remote = {
      getHelperEventState: vi.fn(async (req: { closedSeq?: number }) => {
        requestedClosedSeqs.push(req.closedSeq)
        return {
          ok: true as const,
          value: {
            storyId: 'story-f2',
            closedThrough,
            messages: [
              { seq: 0, role: 'assistant' as const, message_id: 0 },
              { seq: 5, role: 'assistant' as const, message_id: 1 },
              { seq: 11, role: 'assistant' as const, message_id: 2 },
            ],
          },
        }
      }),
    }

    const stop = installHelperLiveEvents(
      { binding: () => ({ sessionId: 's-f2', eventSource: source }) as never },
      remote as never,
    )

    await new Promise((r) => setTimeout(r, 20))

    // 1. 基线前 turn 0 的迟到 settle-assistant 不能回放 message_received。
    pushSnap({
      change: {
        kind: 'settle-assistant',
        entry: { type: 'event', event: { seq: 0, type: 'assistant/message', time: 0, data: { turn: 0, interrupted: false } } as unknown as SessionEvent },
      },
    } as unknown as Partial<SessionEventWindow>)
    await new Promise((r) => setTimeout(r, 20))
    expect(received.filter((r) => r.event === 'message_received')).toHaveLength(0)

    // 2. aborted 轮次（turn 1）的迟到 settle-assistant 不能发出 message_received。
    pushSnap({
      change: {
        kind: 'append',
        entries: [
          { type: 'event', event: { seq: 4, type: 'turn/start', time: 0, data: { turn: 1 } } as unknown as SessionEvent },
          { type: 'event', event: { seq: 6, type: 'turn/end', time: 0, data: { turn: 1, reason: { kind: 'aborted' } } } as unknown as SessionEvent },
        ],
      },
    } as unknown as Partial<SessionEventWindow>)
    pushSnap({
      change: {
        kind: 'settle-assistant',
        entry: { type: 'event', event: { seq: 5, type: 'assistant/message', time: 0, data: { turn: 1, interrupted: false } } as unknown as SessionEvent },
      },
    } as unknown as Partial<SessionEventWindow>)
    await new Promise((r) => setTimeout(r, 20))
    expect(received.filter((r) => r.event === 'message_received')).toHaveLength(0)
    expect(received.some((r) => r.event === 'generation_stopped')).toBe(true)

    // 3. completed 轮次（turn 2, endSeq=12）的迟到 settle-assistant（seq=11）在 closedThrough < 12 时必须被屏障拦下。
    closedThrough = 10
    pushSnap({
      change: {
        kind: 'append',
        entries: [
          { type: 'event', event: { seq: 10, type: 'turn/start', time: 0, data: { turn: 2 } } as unknown as SessionEvent },
          { type: 'event', event: { seq: 12, type: 'turn/end', time: 0, data: { turn: 2, reason: { kind: 'completed' } } } as unknown as SessionEvent },
        ],
      },
    } as unknown as Partial<SessionEventWindow>)
    pushSnap({
      change: {
        kind: 'settle-assistant',
        entry: { type: 'event', event: { seq: 11, type: 'assistant/message', time: 0, data: { turn: 2, interrupted: false } } as unknown as SessionEvent },
      },
    } as unknown as Partial<SessionEventWindow>)
    await new Promise((r) => setTimeout(r, 20))
    expect(requestedClosedSeqs).toContain(12)
    expect(received.filter((r) => r.event === 'message_received')).toHaveLength(0)
    expect(hostErrors.some((e) => String(e).includes('尚未完成剧情收口'))).toBe(true)

    stop()
    unsub()
  })

  it('F3: SpeechHtmlFrame 在 editedBranch 为 null 时仍渲染 greeting-swipe 失败等 branchError', async () => {
    const frameWin = { postMessage: vi.fn() }
    const snapshot: HelperSnapshot = {
      storyId: 'story-f3',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: true,
      scopes: {},
      messages: [{ message_id: 0, name: 'Alice', role: 'assistant', is_hidden: false, message: '<div>card</div>', data: {}, extra: {} }],
    }
    const renderedResult = {
      text: '',
      html: '<div>card</div>',
      htmls: ['<div>card</div>'],
      parts: [{ kind: 'html' as const, text: '<div>card</div>' }],
      interactiveCards: true,
      whitelist: [],
      greetings: ['g0', 'g1'],
      greetingIndex: 0,
      canSwipeGreeting: true,
      helper: snapshot,
    }
    const remote = {
      renderOutputText: vi.fn().mockResolvedValue({ ok: true, value: renderedResult }),
      openHelperFrame: vi.fn().mockResolvedValue({ ok: false, error: { message: '卡面租约登记失败F3' } }),
      closeHelperFrame: vi.fn().mockResolvedValue({ ok: true, value: { closed: true } }),
    } as unknown as TavernRemote

    await act(async () => {
      view = create(
        <SpeechBubble
          remote={remote}
          sessionId="s-f3"
          cardId="c-f3"
          name="Alice"
          rawText="<div>card</div>"
          messageId={1}
          onSwipeGreeting={async () => {}}
        />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWin } : null) },
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })

    // 模拟卡面完成 connect 后触发 swipeGreeting，但 openHelperFrame 租约失败：
    // 此时 editedBranch 恒为 null，branchError 必须通过 dsh-tavern-cardBackupBar 渲染可见。
    const rtId = 'rt-f3'
    await act(async () => {
      const connectEvent = new Event('message')
      Object.defineProperties(connectEvent, {
        source: { value: frameWin },
        data: { value: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: rtId } },
      })
      events.dispatchEvent(connectEvent)
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      const swipeEvent = new Event('message')
      Object.defineProperties(swipeEvent, {
        source: { value: frameWin },
        data: { value: { source: 'dsh-tavern-card', action: 'swipeGreeting', index: 1, runtimeId: rtId } },
      })
      events.dispatchEvent(swipeEvent)
      await new Promise((r) => setTimeout(r, 40))
    })

    const backupBar = view!.root.findAllByType('div').find((node) => node.props.className === 'dsh-tavern-cardBackupBar')
    expect(backupBar).toBeDefined()
    expect(backupBar!.findAllByType('button')).toHaveLength(0)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('卡面租约登记失败F3')
  })

  it('F4 & F5: client/index.tsx 按需解析 cancelWaiting 绑定，且 applyNode 第二步抛错时回滚已注册的 assistant-step', async () => {
    const cancelFirst = vi.fn().mockResolvedValue({ ok: true })
    const cancelSecond = vi.fn().mockResolvedValue({ ok: true })
    let currentBinding: { sessionId: string; session: { cancel: () => Promise<{ ok: boolean }> } } | undefined
    const registeredSlots: Array<{ name: string; options: Record<string, unknown> }> = []
    const assistantDisposed = vi.fn()
    let failTriggerOnce = true
    const effects: Array<() => void> = []

    const remote = {
      getSettings: vi.fn().mockResolvedValue({ ok: true, value: { settings: { locale: 'zh', speakerHeader: false } } }),
      getHelperEventState: vi.fn().mockResolvedValue({ ok: true, value: { storyId: 'st', closedThrough: 0, messages: [] } }),
    }

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      remote: { $mount: vi.fn().mockResolvedValue(undefined) },
      sessions: {
        open: vi.fn(),
        binding: () => currentBinding,
        list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
      },
      get: (name: string) => {
        if (name === 'remote.tavern') return remote
        return undefined
      },
      locale: {
        getSnapshot: () => ({ active: 'zh' }),
        subscribe: () => () => {},
        register: () => () => {},
      },
      effect: (fn: () => (() => void) | void) => {
        const dispose = fn()
        if (typeof dispose === 'function') effects.push(dispose)
        return () => {}
      },
      slots: {
        inject: (_slot: string, fn: () => (() => void) | void) => {
          const dispose = fn()
          if (typeof dispose === 'function') effects.push(dispose)
          return () => {}
        },
        register: (options: Record<string, unknown>) => {
          registeredSlots.push({ name: String(options.name), options })
          if (options.name === 'conversation.chat.node' && options.key === 'assistant-step') {
            return assistantDisposed
          }
          if (options.name === 'conversation.chat.node' && options.key === 'turn-trigger' && failTriggerOnce) {
            failTriggerOnce = false
            throw new Error('simulated turn-trigger failure')
          }
          return () => {}
        },
      },
    } as unknown as ClientContext

    await applyClient(fakeCtx)

    // F4: inject 在无 binding 时调用，随后 binding 到达并切换，onCancel 仍按调用时刻解析到最新句柄。
    const headerSlot = registeredSlots.find((s) => s.name === 'conversation.session.header.actions')!
    const injected = (headerSlot.options.inject as (id: string) => { onCancel?: () => Promise<void> })('s-f4')
    expect(typeof injected.onCancel).toBe('function')
    await expect(injected.onCancel!()).rejects.toThrow('当前会话未就绪')

    currentBinding = { sessionId: 's-f4', session: { cancel: cancelFirst } }
    await injected.onCancel!()
    expect(cancelFirst).toHaveBeenCalledTimes(1)

    currentBinding = { sessionId: 's-f4', session: { cancel: cancelSecond } }
    await injected.onCancel!()
    expect(cancelSecond).toHaveBeenCalledTimes(1)

    // F5: 切换到 Tavern 会话触发 applyNode，turn-trigger 注册抛错后 assistant-step 必须立即回滚释放。
    const stopMark = markSessionView('s-f5', true)
    await Promise.resolve()
    expect(assistantDisposed).toHaveBeenCalledTimes(1)
    stopMark()
    for (const dispose of effects) dispose()
  })
})
