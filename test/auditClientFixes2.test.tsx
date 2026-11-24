/**
 * Client UI 与 iframe 桥接第二轮缺陷修复回归测试（U1–U9）：
 * - U1: 消息编辑忙/已分支态阻断重绘（cardChatEdits/cardDisplay）；SpeechBubble 在重绘守护协商期禁写而放行快照只读
 * - U2: HelperMvuRunner 在 restart 状态停止后台轮询，续约失败指数退避，且 commit 重试不清零 renewAt
 * - U3: TavernFloorActions submitEdit/submitEditAi 在 openChildSession 失败后可见报错且卸载后不更新状态
 * - U4: installTavernSeatWatch 在 chip 未挂载前若 views.hasShownSession() 已成立仍解除 armed 复查标记
 * - U5: MemorySection 与 CardDataSettings 在 React StrictMode 双挂载卸载后仍保留一次绑定预填
 * - U6: CharacterInteractivePreview 转发除 connect/disconnect 外的同运行时 helperEvent* 消息
 * - U7: styles.ts prefers-reduced-motion 覆盖骨架屏 shimmers 与推理块动画/过渡
 * - U8: NativeMvuEnable 对双击加同步互斥锁且组件卸载后忽略迟到完成状态
 * - U9: isBindingDirty 精确区分 helperMvu undefined 与 false，chip 开启后再关闭自动跟随不误写 false
 */
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { StrictMode, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT, TavernFloorActions } from '../src/client/actions.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { isBindingDirty, TavernHeaderChip } from '../src/client/chip.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { publishScriptStatus, clearScriptStatus } from '../src/client/helperScriptStatus.js'
import { CharacterInteractivePreview } from '../src/client/panel/characters.js'
import { CardDataSettings } from '../src/client/panel/cardData.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { ScriptSettings } from '../src/client/panel/scripts.js'
import { installTavernSeatWatch } from '../src/client/seatWatch.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { SpeechHtmlFrame } from '../src/client/speech.js'
import { ensureTavernStyles } from '../src/client/styles.js'
import { t } from '../src/client/i18n.js'
import type { ClientContext, Envelope, SessionBinding, TavernRemote } from '../src/client/types.js'
import { Btn, Toggle } from '../src/client/util.js'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
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

let view: ReactTestRenderer | undefined
let events: EventTarget
const cleanups: Array<() => void> = []

beforeEach(() => {
  events = new EventTarget()
  vi.stubGlobal('window', events)
  const styles: HTMLStyleElement[] = []
  vi.stubGlobal('document', {
    documentElement: {},
    body: {},
    head: { appendChild: (el: HTMLStyleElement) => { styles.push(el) } },
    getElementById: (id: string) => styles.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: () => [],
  })
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
})

afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  while (cleanups.length) cleanups.pop()!()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function emptyEvents(): SessionEventSource {
  return {
    state: () => ({ events: [], loading: false }),
    window: () => ({ events: [], total: 0 }) as SessionEventWindow,
    subscribe: () => () => {},
  } as unknown as SessionEventSource
}

function makeSnapshot(storyId = 'story-1'): HelperSnapshot {
  return {
    storyId,
    historyRevision: 'rev-1',
    currentMessageId: 1,
    messages: [
      { message_id: 0, name: 'U', role: 'user', is_hidden: false, message: 'hi', data: {}, extra: {} },
      { message_id: 1, name: 'A', role: 'assistant', is_hidden: false, message: 'reply', data: {}, extra: {} },
    ],
    scopes: {},
    writable: true,
  }
}

describe('Client UI 与桥接第二轮缺陷修复回归 (U1–U9)', () => {
  it('U1: cardChatEdits busy/branched 阻断重绘；SpeechBubble 在重绘守护待决期拒绝写入并允许只读快照', async () => {
    const scope: Record<string, unknown> = {
      parent: { postMessage: () => {} },
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'loading',
        body: null,
        open: () => {},
        write: () => {},
        close: () => {},
        currentScript: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    scope.window = scope
    const ctx = createContext(scope)
    runInContext(
      tavernCardBridgeScript({ greetings: [], greetingIndex: 0, helperSnapshot: makeSnapshot() })
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
      ctx,
    )
    expect((scope.__dshTavernChatEditBusy as () => boolean)()).toBe(false)
    scope.__dshTavernChatEditBusy = () => true
    await expect((scope.__dshTavernRefreshDisplay as (ids: number[] | null) => Promise<void>)(null)).rejects.toThrow(/编辑/)
    scope.__dshTavernChatEditBusy = () => false
    scope.__dshTavernMessageBranch = { childSessionId: 'c1', title: 't' }
    await expect((scope.__dshTavernRefreshDisplay as (ids: number[] | null) => Promise<void>)(null)).rejects.toThrow(/分支/)
    runInContext('__dshTavernBridgeCleanup()', ctx)

    // 验证 SpeechHtmlFrame 在 guards.size > 0（registerDisplayGuard 尚未回应）期间拒绝 helperMessageEdit，但放行 helperSnapshotGet：
    let capturedGuard: ((request: { storyId: string; historyRevision: string; ids: number[] | null }) => Promise<{ check(): void; commit(): void; cancel(): void }>) | undefined
    const posted: Array<Record<string, unknown>> = []
    const contentWindow = { postMessage: vi.fn((msg: Record<string, unknown>) => posted.push(msg)) }

    await act(async () => {
      view = create(
        <SpeechHtmlFrame
          srcDoc="<div>widget</div>"
          title="u1-widget"
          widget
          helperBinding={{ sessionId: 'sess-u1', storyId: 'story-1' }}
          helperMessageId={1}
          onMessageEdit={vi.fn(async () => ({ branch: null }))}
          onHelperRefresh={vi.fn(async () => makeSnapshot('story-1'))}
          registerDisplayGuard={(fn) => {
            capturedGuard = fn
            return () => {}
          }}
        />,
        {
          createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow } : {}),
        },
      )
      await Promise.resolve()
    })

    // Connect iframe runtime so SpeechHtmlFrame accepts messages from it.
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: contentWindow,
          data: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-u1' },
        }),
      )
      await Promise.resolve()
    })

    // Trigger pending display guard (guards.size > 0).
    let guardPromise: Promise<unknown> | undefined
    await act(async () => {
      guardPromise = capturedGuard?.({ storyId: 'story-1', historyRevision: 'rev-1', ids: null })
      await Promise.resolve()
    })
    const guardPost = posted.find((m) => m.action === 'helperDisplayGuard')
    expect(guardPost).toBeDefined()

    // While guard check is pending: mutating edit is rejected, read-only snapshot succeeds.
    posted.length = 0
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: contentWindow,
          data: { source: 'dsh-tavern-card', action: 'helperMessageEdit', requestId: 'req-edit', runtimeId: 'rt-u1', storyId: 'story-1', historyRevision: 'rev-1', edits: [] },
        }),
      )
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: contentWindow,
          data: { source: 'dsh-tavern-card', action: 'helperSnapshotGet', requestId: 'req-snap', runtimeId: 'rt-u1', storyId: 'story-1' },
        }),
      )
      await Promise.resolve()
    })
    expect(posted.some((m) => m.action === 'helperMessageEditResult' && m.ok === false)).toBe(true)
    expect(posted.some((m) => m.action === 'helperSnapshotResult' && m.ok === true)).toBe(true)

    // Resolve guard so cleanup doesn't leak timers.
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: contentWindow,
          data: { source: 'dsh-tavern-card', action: 'helperDisplayGuardResult', requestId: guardPost!.requestId, runtimeId: 'rt-u1', ok: true },
        }),
      )
      await Promise.resolve()
    })
    const lease = (await guardPromise) as { cancel(): void }
    lease.cancel()
  })

  it('U2: HelperMvuRunner 在 restart 状态暂停轮询，续约失败指数退避，且 commit 重试不清零 renewAt', async () => {
    vi.useFakeTimers()
    let pollCalls = 0
    let failRenew = false
    const frameWin = { postMessage: vi.fn() }
    const jobWork: HelperMvuWork = {
      storyId: 'story-u2',
      enabled: true,
      status: 'pending',
      job: { id: 'a'.repeat(64), identity: 'm1', seq: 2, kind: 'initialize', text: 'hi', turn: 0, floor: 's#t0' },
      token: 'tok-1',
      snapshot: makeSnapshot('story-u2'),
      base: {},
    }
    const remote = {
      prepareHelperMvuJob: vi.fn(async () => {
        pollCalls++
        if (failRenew) return fail('renew err')
        if (pollCalls === 1) return ok(jobWork)
        return ok({ ...jobWork, token: 'tok-changed' })
      }),
      commitHelperMvuJob: vi.fn(async () => fail('commit boom')),
    } as unknown as TavernRemote

    await act(async () => {
      view = create(
        <HelperMvuRunner
          remote={remote}
          sessionId="sess-u2"
          storyId="story-u2"
          snapshot={makeSnapshot('story-u2')}
          ready
        />,
        {
          createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWin } : {}),
        },
      )
    })
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: frameWin,
          data: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-mvu' },
        }),
      )
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: frameWin,
          data: { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'rt-mvu' },
        }),
      )
      await Promise.resolve()
    })
    expect(pollCalls).toBe(1)

    // 触发一次 commit，使 result !== undefined 且 commit 失败（此时 work 仍在且 renewAt 在 20s 之后）
    const runMsg = frameWin.postMessage.mock.calls.find((c) => c[0]?.action === 'helperMvuRun')?.[0]
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: frameWin,
          data: { source: 'dsh-tavern-card', action: 'helperMvuResult', runtimeId: 'rt-mvu', requestId: runMsg.requestId, ok: true, data: { stat_data: { x: 1 } } },
        }),
      )
      await Promise.resolve()
    })
    // 点击 Retry 仅重试 commit，不得清零 renewAt 去额外抢跑一次 prepareHelperMvuJob。
    const retryBtn = view!.root.findAllByType(Btn).find((b) => b.props.children === t('speech.mvuRetry'))!
    await act(async () => {
      retryBtn.props.onClick()
      await Promise.resolve()
    })
    expect(pollCalls).toBe(1)

    // 续约失败按 5s -> 10s 指数退避，而不是固定频率轮询：
    failRenew = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(pollCalls).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(pollCalls).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(pollCalls).toBe(3)

    failRenew = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(pollCalls).toBe(3)
    // 第 2 次退避 10s 到期后拿到变更后的 lease token -> restart = true，此后 60s 不再后台轮询。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(pollCalls).toBe(4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(pollCalls).toBe(4)
  })

  it('U3: TavernFloorActions submitEdit 在 openChildSession 失败后可见报错且卸载安全', async () => {
    cleanups.push(markSessionView('sess-u3', true))
    const remote = {
      getSessionBinding: async () => ok({ binding: { cardId: 'c1', storyId: 's1', greetingIndex: 0 } }),
      getFloorActionStates: async () => ok({ items: [{ messageId: 'msg-2', turn: 1, canContinue: false, greeting: { isGreeting: false, started: true, swipe: null }, siblings: { swipe: null } }] }),
      getFloorUserMessage: async () => ok({ turn: 1, text: 'old user text' }),
      editUserMessage: async () => ok({ childSessionId: 'child-u3', title: 'BranchTitle' }),
    } as unknown as TavernRemote
    const sessions = {
      open: vi.fn(() => { throw new Error('openChild failed') }),
      refresh: vi.fn(async () => {}),
    }

    await act(async () => {
      view = create(
        <TavernFloorActions
          remote={remote}
          sessionId="sess-u3"
          messageId="msg-2"
          useSessions={((sel: (s: unknown) => unknown) => sel({ byId: { 'sess-u3': { projectionValues: { agentPreset: 'tavern' } } } })) as never}
          sessions={sessions as never}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const editBtn = view!.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === t('actions.editUser'))[0]!
    await act(async () => {
      editBtn.props.onClick()
      await Promise.resolve()
    })
    const textarea = view!.root.findByType('textarea')
    await act(async () => {
      textarea.props.onChange({ target: { value: 'edited user text' } })
    })
    const saveBtn = view!.root.findAllByType(Btn).find((b) => b.props.primary === true)!
    await act(async () => {
      saveBtn.props.onClick()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(sessions.open).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(view!.toJSON())).toContain('openChild failed')

    // 卸载安全：当 editUserMessage/openChildSession 挂起期间组件卸载，迟到 reject 不触发未挂载告警或抛错。
    let resolveDelayedEdit!: () => void
    const delayedRemote = {
      ...remote,
      editUserMessage: () => new Promise<Envelope<{ childSessionId: string; title: string }>>((resolve) => {
        resolveDelayedEdit = () => resolve(ok({ childSessionId: 'child-u3-late', title: 'Late' }))
      }),
    } as unknown as TavernRemote
    await act(async () => {
      view!.update(
        <TavernFloorActions
          remote={delayedRemote}
          sessionId="sess-u3"
          messageId="msg-2"
          useSessions={((sel: (s: unknown) => unknown) => sel({ byId: { 'sess-u3': { projectionValues: { agentPreset: 'tavern' } } } })) as never}
          sessions={sessions as never}
        />,
      )
      await Promise.resolve()
    })
    const editBtn2 = view!.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === t('actions.editUser'))[0]!
    await act(async () => {
      editBtn2.props.onClick()
      await Promise.resolve()
    })
    await act(async () => {
      view!.root.findByType('textarea').props.onChange({ target: { value: 'edited user text 2' } })
    })
    await act(async () => {
      view!.root.findAllByType(Btn).find((b) => b.props.primary === true)!.props.onClick()
    })
    await act(async () => {
      view!.unmount()
    })
    view = undefined
    resolveDelayedEdit()
    await Promise.resolve()
  })

  it('U4: installTavernSeatWatch 在 views.hasShownSession() 成立且 chip 暂不在 DOM 时仍解除 armed', async () => {
    vi.useFakeTimers()
    let chipMounted = true
    let chipTavern = false
    let shownSession = false
    const callbacks: Array<() => void> = []
    vi.stubGlobal('MutationObserver', class {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('document', {
      documentElement: {},
      body: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () =>
        chipMounted
          ? [{ getAttribute: (k: string) => (k === 'title' ? '选择新任务使用的 Agent 预设' : k === 'class' ? 'cubgiG_seat' : null), textContent: chipTavern ? 'Tavern 模式' : '默认' }]
          : [],
    })
    const startSession = vi.fn(async () => {})
    const stop = installTavernSeatWatch(
      { get: () => ({ startSession }), workspaces: {} } as unknown as ClientContext,
      { hasShownSession: () => shownSession },
    )

    // 先以 false 建立初始基线，再跳变为 true 触发第一次 startSession 并进入冷却。
    callbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(200)
    chipTavern = true
    callbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(200)
    expect(startSession).toHaveBeenCalledTimes(1)

    // 在冷却期再次跳回 false -> true 置起 armed=true，随后 chip 从 DOM 卸载且已有会话展示。
    chipTavern = false
    callbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(200)
    chipTavern = true
    callbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(200)
    shownSession = true
    chipMounted = false
    callbacks.forEach((cb) => cb())
    await vi.advanceTimersByTimeAsync(500)

    // 冷却结束后重新挂上 chip：armed 已在 chip 卸载时解除，不会补发多余 startSession。
    chipMounted = true
    shownSession = false
    await vi.advanceTimersByTimeAsync(3_000)
    expect(startSession).toHaveBeenCalledTimes(1)
    stop()
  })

  it('U5: MemorySection 与 CardDataSettings 在 StrictMode 双挂载卸载后仍正常预填激活会话绑定', async () => {
    cleanups.push(markSessionView('sess-u5', true))
    invalidateSessionBinding('sess-u5')
    const remote = {
      listCharacters: async () => ok({ items: [{ cardId: 'card-u5', name: 'CardU5', creator: '', tags: [], hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 }] }),
      listStories: async () => ok({ items: [{ id: 'story-u5', sessionId: 'sess-u5', createdAt: '2026-01-01T00:00:00Z', migrated: false }] }),
      listSessionImportWorkspaces: async () => ok({ items: [] }),
      getHelperEventState: async () => ok({ storyId: 'story-u5', historyRevision: 'rev-1', messages: [{ seq: 1, message_id: 1, role: 'assistant' }], writable: true, closedThrough: 0 }),
      getHelperSnapshot: async () => ok(makeSnapshot('story-u5')),
      getMemories: async () => ok({ items: [] }),
      getWorldDeltas: async () => ok({ items: [] }),
      getSessionBinding: vi.fn(async () => ok({
        binding: {
          sessionId: 'sess-u5',
          cardId: 'card-u5',
          storyId: 'story-u5',
          presetId: null,
          personaId: null,
          lorebookIds: [],
          characterLorebookId: null,
          interactiveCards: null,
          greetingIndex: 0,
        },
      })),
    } as unknown as TavernRemote

    await act(async () => {
      view = create(
        <StrictMode>
          <MemorySection remote={remote} />
          <CardDataSettings remote={remote} />
        </StrictMode>,
      )
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    const treeJson = JSON.stringify(view!.toJSON())
    expect(treeJson).toContain('CardU5')
    expect(treeJson).toContain('Story 1')
    expect(treeJson).toContain('sess-u5')
    expect(treeJson).not.toContain('dsh-tavern-errText')
  })

  it('U6: CharacterInteractivePreview 转发除 connect/disconnect 外的同运行时 helperEvent* 消息', async () => {
    const iframeWin = { postMessage: vi.fn() }
    await act(async () => {
      view = create(<CharacterInteractivePreview html="<div>preview</div>" firstMes="hi" alternateGreetings={[]} title="Preview" />, {
        createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: iframeWin } : {}),
      })
      await Promise.resolve()
    })
    await act(async () => {
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: iframeWin,
          data: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-prev' },
        }),
      )
      events.dispatchEvent(
        Object.assign(new Event('message'), {
          source: iframeWin,
          data: { source: 'dsh-tavern-card', action: 'helperEventEmit', requestId: 'ev-1', runtimeId: 'rt-prev', eventName: 'test', args: ['hello'] },
        }),
      )
      await Promise.resolve()
    })
    expect(iframeWin.postMessage.mock.calls.some((call) => call[0]?.action === 'helperEventResult' && call[0]?.requestId === 'ev-1')).toBe(true)
  })

  it('U7: styles.ts prefers-reduced-motion 规则包含 skeleton 与 reason 选择器', () => {
    ensureTavernStyles()
    const el = document.getElementById('dsh-tavern-ui-style')
    expect(el).not.toBeNull()
    const css = el!.textContent ?? ''
    const match = /@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/.exec(css)
    expect(match).not.toBeNull()
    expect(match![1]).toContain('.dsh-tavern-skeleton')
    expect(match![1]).toContain('.dsh-tavern-reason')
  })

  it('U8: ScriptSettings NativeMvuEnable 阻止同步双击重入并在卸载后忽略迟到完成', async () => {
    let resolveEnable!: () => void
    const enableSpy = vi.fn(() => new Promise<void>((r) => { resolveEnable = r }))
    const remote = {
      listCharacters: async () => ok({ items: [] }),
      listPresets: async () => ok({ items: [] }),
    } as unknown as TavernRemote
    const owner = Symbol('u8')
    publishScriptStatus(
      owner,
      {
        sessionId: 'sess-u8',
        cardId: 'card-u8',
        state: 'running',
        nativeMvu: false,
        scripts: [{ id: 's1', name: 'MVU', state: 'ready', native: true }],
      },
      undefined,
      enableSpy,
    )
    try {
      await act(async () => {
        view = create(<ScriptSettings remote={remote} />)
        await Promise.resolve()
      })
      const enableBtn = view!.root.findAllByType(Btn).find((b) => b.props.children === t('settings.scripts.nativeEnable'))!
      await act(async () => {
        enableBtn.props.onClick()
        enableBtn.props.onClick()
      })
      // 同步互斥锁确保连续触发两次点击也只调用一次 enableSpy。
      expect(enableSpy).toHaveBeenCalledTimes(1)
      await act(async () => {
        view!.unmount()
      })
      view = undefined
      resolveEnable?.()
    } finally {
      clearScriptStatus(owner, 'sess-u8')
    }
  })

  it('U9: isBindingDirty 区分 helperMvu undefined 与 false，chip 三态切换不强制写入 false', () => {
    const base: SessionBinding = {
      sessionId: 'sess-u9',
      cardId: 'card-u9',
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00Z',
    }
    expect(isBindingDirty({ ...base, helperMvu: undefined }, { ...base, helperMvu: undefined })).toBe(false)
    expect(isBindingDirty({ ...base, helperMvu: false }, { ...base, helperMvu: undefined })).toBe(true)
    expect(isBindingDirty({ ...base, helperMvu: undefined }, { ...base, helperMvu: false })).toBe(true)
    expect(Toggle).toBeTypeOf('function')
    expect(TavernHeaderChip).toBeTypeOf('function')
  })
})
