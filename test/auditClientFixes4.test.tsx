/**
 * Client UI、iframe 桥接与性能第四轮审计修复回归测试（C1–C8）：
 * - C1: SpeechHtmlFrame 的 openHelperFrame 超时或卸载后迟到成功时立即回补 closeHelperFrame 释放服务端租约
 * - C2: HelperMvuRunner 在未就绪空闲态不空转定时器；运行中 ready 降为 false 时立刻按脚本未就绪报错并清理定时器
 * - C3: installHelperLiveEvents 中过期 initialize 回包不覆盖更新的 BINDING_CHANGED_EVENT 探测也不误 cancel 新探测
 * - C4: HelperScripts 记忆化 srcDoc 不因 ready/MVU 更新重复构建，且编辑分支重试二次失败后再次成功时正确清除 failures
 * - C5: SettingsSection 远端配置到达时同步调用 setTavernLocale
 * - C6: MemorySection 在 deltaType='add' 时忽略隐藏 deltaRef，既不误触发未保存草稿也不提交脏 ref
 * - C7: TavernFloorActions 订阅当前绑定角色卡的 CHARACTER_CHANGED_EVENT，编辑开场白后主动重载楼层动作状态
 * - C8: 客户端入口 apply 在 getSettings 挂起超过 5s 时按超时放行全部 UI slot 注册，不永久阻塞界面挂载
 */
import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT, TavernFloorActions } from '../src/client/actions.js'
import { CHARACTER_CHANGED_EVENT, invalidateSessionBinding } from '../src/client/cache.js'
import * as cardFrame from '../src/core/cardFrame.js'
import { installHelperLiveEvents } from '../src/client/helperLiveEvents.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { HelperScripts } from '../src/client/helperScripts.js'
import { openScriptEditedBranch, scriptStatusStore } from '../src/client/helperScriptStatus.js'
import { getTavernLocale, setTavernLocale, t } from '../src/client/i18n.js'
import { apply as applyClient } from '../src/client/index.js'
import { markSessionView } from '../src/client/sessionViews.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import { SpeechHtmlFrame } from '../src/client/speech.js'
import type { ClientContext, Envelope, SessionBinding, TavernRemote, TavernSettings } from '../src/client/types.js'
import { Btn, Select } from '../src/client/util.js'
import type { HelperMvuWork } from '../src/core/helperMvu.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import { TavernConfigSchema } from '../src/node/config.js'

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
  IconEditOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const mounted: ReactTestRenderer[] = []
let winEvents: EventTarget

const BASE_SNAPSHOT: HelperSnapshot = {
  storyId: 'story-c4',
  historyRevision: 'rev-c4',
  currentMessageId: 0,
  writable: true,
  scopes: {},
  messages: [{ message_id: 0, role: 'assistant', name: '角色', message: 'hello', data: {}, extra: {}, is_hidden: false }],
}

beforeEach(() => {
  winEvents = Object.assign(new EventTarget(), {
    sessionStorage: { getItem: () => 'audit4-client-tab', setItem() {} },
  })
  vi.stubGlobal('window', winEvents)
  setTavernLocale('zh')
})

afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTavernLocale('zh')
})

describe('Client UI、桥接与性能第四轮审计修复回归', () => {
  it('C1: openHelperFrame 超时后迟到成功时立即回补 closeHelperFrame 释放服务端租约', async () => {
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const deferred = Promise.withResolvers<Envelope<{ token: string }>>()
    const openHelperFrame = vi.fn(() => deferred.promise)
    const closeHelperFrame = vi.fn(async () => ok({ ok: true }))
    const remote = { openHelperFrame, closeHelperFrame } as unknown as TavernRemote
    const frameWindow = { postMessage: vi.fn() }

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <SpeechHtmlFrame
          srcDoc="<html></html>"
          title="t"
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 's-c1', storyId: 'story-c1' }}
        />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWindow } : null) },
      )
    })
    mounted.push(view)

    await act(async () => {
      const ev = new Event('message')
      Object.defineProperties(ev, {
        source: { value: frameWindow },
        data: { value: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-c1' } },
      })
      winEvents.dispatchEvent(ev)
    })
    expect(openHelperFrame).toHaveBeenCalledTimes(1)

    // 触发 5s 超时信号
    await act(async () => {
      controller.abort(new Error('timeout'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(closeHelperFrame).not.toHaveBeenCalled()

    // 迟到的 openHelperFrame 成功回包：必须立刻携带真实 token 关闭释放服务端租约
    await act(async () => {
      deferred.resolve(ok({ token: 'late-token-123' }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(closeHelperFrame).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-c1',
      messageId: 1,
      runtimeId: 'rt-c1',
      token: 'late-token-123',
    }))
  })

  it('C2: HelperMvuRunner 在未就绪空闲态零定时器空转，运行中脚本失效立刻失败并清除定时器', async () => {
    vi.useFakeTimers()
    const work: HelperMvuWork = {
      storyId: 'story-c4',
      enabled: true,
      status: 'pending',
      token: 'tok-c2',
      job: { id: 'b'.repeat(64), identity: 'm0', seq: 1, kind: 'initialize', text: 'hi', turn: 0, floor: 's#t0' },
      snapshot: BASE_SNAPSHOT,
      base: {},
    }
    const prepareHelperMvuJob = vi.fn(async () => ok(structuredClone(work)))
    const commitHelperMvuJob = vi.fn(async () => ok({ storyId: 'story-c4', enabled: true, status: 'idle' as const }))
    const remote = { prepareHelperMvuJob, commitHelperMvuJob } as unknown as TavernRemote
    const frameWindow = { postMessage: vi.fn() }

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <HelperMvuRunner remote={remote} sessionId="s-c2" storyId="story-c4" snapshot={BASE_SNAPSHOT} ready={false} />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWindow } : null) },
      )
    })
    mounted.push(view)

    // 未就绪且无 running 任务时不应空挂 1Hz 定时器
    expect(vi.getTimerCount()).toBe(0)

    // iframe 就绪 + scripts ready=true → 启动任务
    await act(async () => {
      for (const action of ['helperEventConnect', 'helperMvuReady']) {
        const ev = new Event('message')
        Object.defineProperties(ev, {
          source: { value: frameWindow },
          data: { value: { source: 'dsh-tavern-card', action, runtimeId: 'rt-mvu' } },
        })
        winEvents.dispatchEvent(ev)
      }
    })
    await act(async () => {
      view.update(<HelperMvuRunner remote={remote} sessionId="s-c2" storyId="story-c4" snapshot={BASE_SNAPSHOT} ready={true} />)
    })
    expect(prepareHelperMvuJob).toHaveBeenCalledTimes(1)

    // 运行中途 ready 变为 false：立刻报错 mvuScriptsNotReady 并清除已挂载的续租定时器
    await act(async () => {
      view.update(<HelperMvuRunner remote={remote} sessionId="s-c2" storyId="story-c4" snapshot={BASE_SNAPSHOT} ready={false} />)
    })
    expect(JSON.stringify(view.toJSON())).toContain(t('speech.mvuScriptsNotReady'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('C3: installHelperLiveEvents 中迟到的 initialize 失败回包不会取消更新的 BINDING_CHANGED 探测', async () => {
    const first = Promise.withResolvers<Envelope<any>>()
    const second = Promise.withResolvers<Envelope<any>>()
    let calls = 0
    const getHelperEventState = vi.fn(() => (++calls === 1 ? first.promise : second.promise))
    const listeners = new Set<() => void>()
    const snapshot: SessionEventWindow = {
      revision: 1,
      entries: [],
      change: { kind: 'replace' },
    } as unknown as SessionEventWindow
    const eventSource: SessionEventSource = {
      getSnapshot: () => snapshot,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    } as unknown as SessionEventSource

    const dispose = installHelperLiveEvents(
      { binding: (id: string) => (id === 's-c3' ? ({ sessionId: 's-c3', eventSource } as any) : undefined) },
      { getHelperEventState } as unknown as Pick<TavernRemote, 'getHelperEventState'>,
      { currentTavernSession: () => 's-c3', subscribe: () => () => {} },
    )
    try {
      expect(getHelperEventState).toHaveBeenCalledTimes(1)
      // 在首次 initialize 未返回前触发绑定变更探测
      winEvents.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 's-c3' }))
      expect(getHelperEventState).toHaveBeenCalledTimes(2)

      // 旧的 initialize 失败返回：因为 probe 已过期，不得 cancel 更新中的 second 探测
      first.reject(new Error('stale init failed'))
      await Promise.resolve()
      await Promise.resolve()

      second.resolve(ok({ storyId: 'story-new', closedThrough: 0, messages: [] }))
      await Promise.resolve()
      await Promise.resolve()
      expect(getHelperEventState).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
    }
  })

  it('C4: HelperScripts 记忆化 srcDoc，且分支打开二次失败后再次成功时清除脚本 failures', async () => {
    const unmark = markSessionView('s-c4', true)
    try {
      const buildSpy = vi.spyOn(cardFrame, 'buildCardSrcDoc')
      const frameWindow = { postMessage: vi.fn() }
      const bundle = {
        enabled: true,
        cardId: 'card-1',
        storyId: 'story-c4',
        revision: 'r1',
        trees: [{ id: 'scr-1', type: 'script' as const, name: 'S1', enabled: true, content: 'void 0', info: '', data: {}, button: { enabled: false, buttons: [] } }],
        libraries: [{ target: { type: 'character' as const, cardId: 'card-1' }, revision: 'r1', trees: [{ id: 'scr-1', type: 'script' as const, name: 'S1', enabled: true, content: 'void 0', info: '', data: {}, button: { enabled: false, buttons: [] } }] }],
        messageId: 0,
        snapshot: BASE_SNAPSHOT,
        worldbooks: undefined,
        scriptContext: undefined,
        whitelist: [],
        helperMvu: false,
      }
      // openChildSession 内部对每次调用会重试一次 open，因此按阶段控制报错/成功
      let navError: string | null = 'first nav failed'
      const open = vi.fn(() => { if (navError) throw new Error(navError) })
      const remote = {
        getHelperScriptBundle: vi.fn(async () => ok(bundle)),
        openHelperFrame: vi.fn(async () => ok({ token: 'tok-s' })),
        closeHelperFrame: vi.fn(async () => ok({ ok: true })),
        editHelperMessages: vi.fn(async () => ok({ branch: { childSessionId: 'child-1', title: '编辑分支' } })),
      } as unknown as TavernRemote

      let view!: ReactTestRenderer
      await act(async () => {
        view = create(
          <HelperScripts remote={remote} sessionId="s-c4" cardId="card-1" sessions={{ open }} />,
          { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWindow } : null) },
        )
      })
      mounted.push(view)
      const initialCalls = buildSpy.mock.calls.length
      expect(initialCalls).toBe(1)

      // 模拟脚本上报就绪导致 HelperScripts 重渲染：buildCardSrcDoc 必须保持记忆化，不再重算
      await act(async () => {
        const ev1 = new Event('message')
        Object.defineProperties(ev1, {
          source: { value: frameWindow },
          data: { value: { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-s1' } },
        })
        winEvents.dispatchEvent(ev1)
        const ev2 = new Event('message')
        Object.defineProperties(ev2, {
          source: { value: frameWindow },
          data: { value: { source: 'dsh-tavern-card', action: 'helperScriptReady', runtimeId: 'rt-s1', ok: true } },
        })
        winEvents.dispatchEvent(ev2)
        for (let i = 0; i < 6; i++) await Promise.resolve()
      })
      expect(buildSpy.mock.calls.length).toBe(initialCalls)

      const currentStatus = () => scriptStatusStore.getSnapshot().find((item) => item.sessionId === 's-c4')

      // 触发脚本消息分支编辑，首次 open 失败产生 editedBranchError + failures
      await act(async () => {
        const ev = new Event('message')
        Object.defineProperties(ev, {
          source: { value: frameWindow },
          data: {
            value: {
              source: 'dsh-tavern-card',
              action: 'helperMessageEdit',
              requestId: 'req-edit-1',
              runtimeId: 'rt-s1',
              storyId: 'story-c4',
              historyRevision: 'rev-c4',
              edits: [{ message_id: 0, message: 'edited' }],
            },
          },
        })
        winEvents.dispatchEvent(ev)
        for (let i = 0; i < 10; i++) await Promise.resolve()
        const applied = new Event('message')
        Object.defineProperties(applied, {
          source: { value: frameWindow },
          data: {
            value: {
              source: 'dsh-tavern-card',
              action: 'helperMessageEditApplied',
              requestId: 'req-edit-1',
              runtimeId: 'rt-s1',
            },
          },
        })
        winEvents.dispatchEvent(applied)
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })
      await act(async () => { await Promise.resolve() })
      expect(currentStatus()?.editedBranchError).toContain('first nav failed')
      expect(currentStatus()?.scripts[0]?.state).toBe('error')

      // 重试 #1 再次失败（换了错误信息 second nav failed）
      navError = 'second nav failed'
      await act(async () => { await openScriptEditedBranch('s-c4') })
      expect(currentStatus()?.editedBranchError).toContain('second nav failed')

      // 重试 #2 成功：必须同时清除 editedBranch 与 failures[scr-1]，脚本恢复 ready
      navError = null
      await act(async () => { await openScriptEditedBranch('s-c4') })
      expect(currentStatus()?.editedBranchError).toBeUndefined()
      expect(currentStatus()?.scripts[0]?.state).toBe('ready')
    } finally {
      unmark()
    }
  })

  it('C5: SettingsSection 远端配置加载后同步更新生效语言', async () => {
    const settings: TavernSettings = { ...TavernConfigSchema({}), locale: 'en' }
    const remote = {
      getSettings: vi.fn(async () => ok({ settings })),
      updateSettings: vi.fn(async () => ok({ settings })),
      getDataInfo: async () => ok({ dataHome: '/tmp' }),
      listPresets: async () => ok({ items: [] }),
      listLorebooks: async () => ok({ items: [] }),
      listPersonas: async () => ok({ items: [] }),
    } as unknown as TavernRemote

    expect(getTavernLocale()).toBe('zh')
    let view!: ReactTestRenderer
    await act(async () => { view = create(<SettingsSection remote={remote} />) })
    mounted.push(view)
    expect(getTavernLocale()).toBe('en')
  })

  it('C6: MemorySection 在 deltaType=add 时忽略隐藏 deltaRef，不提交脏 ref', async () => {
    const addWorldDelta = vi.fn(async () => ok({ id: 'd1' }))
    const remote = {
      listCharacters: async () => ok({ items: [{ cardId: 'c1', name: 'C1', hasAvatar: false }] }),
      listStories: async () => ok({ items: [{ id: 'st1', sessionId: 's1', createdAt: '2026-01-01', migrated: false }] }),
      getMemories: async () => ok({ items: [] }),
      getWorldDeltas: async () => ok({ items: [] }),
      getJournal: async () => ok({ text: '', revision: 'r0' }),
      getStoryRecovery: async () => ok({ floors: [] }),
      getEditorDraft: async () => ok({ draft: null }),
      saveEditorDraft: async () => ok({ saved: true }),
      deleteEditorDraft: async () => ok({ deleted: true }),
      addWorldDelta,
    } as unknown as TavernRemote

    let view!: ReactTestRenderer
    await act(async () => { view = create(<MemorySection remote={remote} initialContext={{ cardId: 'c1', storyId: 'st1' }} initialTab="delta" />) })
    mounted.push(view)

    // 先切到 update 填一个 ref，再切回 add（ref 输入框被隐藏）并填正文提交
    const selects = view.root.findAllByType(Select)
    const typeSelect = selects.find((s) => (s.props.options as Array<{ value: string }>).some((o) => o.value === 'update'))!
    await act(async () => { typeSelect.props.onChange('update') })
    const refInput = view.root.findAllByType('input').find((i) => i.props.className === 'dsh-tavern-input')!
    await act(async () => { refInput.props.onChange({ target: { value: 'old-ref-id' } }) })
    await act(async () => { typeSelect.props.onChange('add') })

    const bodyArea = view.root.findByType('textarea')
    await act(async () => { bodyArea.props.onChange({ target: { value: '新增世界事实' } }) })
    const submitBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('memory.addDelta'))!
    await act(async () => { submitBtn.props.onClick() })

    expect(addWorldDelta).toHaveBeenCalledWith(expect.objectContaining({
      type: 'add',
      content: '新增世界事实',
      ref: null,
    }))
  })

  it('C7: TavernFloorActions 在 CHARACTER_CHANGED_EVENT 命中当前绑定角色卡时重新加载楼层状态', async () => {
    invalidateSessionBinding('s-c7')
    const binding: SessionBinding = {
      sessionId: 's-c7',
      cardId: 'card-c7',
      storyId: 'st-c7',
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const getFloorActionStates = vi.fn(async () => ok({
      states: {
        'm-1': {
          greeting: { isGreeting: true, started: false, swipe: { index: 0, count: 2 } },
          siblings: { swipe: null },
          canContinue: false,
        },
      },
    }))
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, canSwipeGreeting: true })),
      getFloorActionStates,
    } as unknown as TavernRemote
    const useSessions = (selector: (s: { byId: Record<string, { projectionValues?: { agentPreset?: string | null } }> }) => unknown) =>
      selector({ byId: { 's-c7': { projectionValues: { agentPreset: 'tavern' } } } })

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <TavernFloorActions remote={remote} sessionId="s-c7" messageId="m-1" sessions={{ open: () => {} }} useSessions={useSessions} />,
      )
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    mounted.push(view)
    const callsBefore = getFloorActionStates.mock.calls.length
    expect(callsBefore).toBeGreaterThanOrEqual(1)

    await act(async () => {
      winEvents.dispatchEvent(new CustomEvent(CHARACTER_CHANGED_EVENT, { detail: 'card-c7' }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(getFloorActionStates.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('C8: 客户端入口 apply 在 getSettings 挂起超过 5s 时放行全部常驻 UI slot 挂载', async () => {
    vi.useFakeTimers()
    const stalled = new Promise<Envelope<{ settings: TavernSettings }>>(() => {})
    const registeredSlots: string[] = []
    const ctx = {
      remote: { $mount: vi.fn(async () => {}) },
      get: (name: string) => (name === 'remote.tavern' ? { getSettings: () => stalled } : undefined),
      locale: {
        getSnapshot: () => ({ active: 'zh-CN' }),
        subscribe: () => () => {},
        register: () => () => {},
      },
      sessions: { open: () => {} },
      workspaces: {},
      slots: {
        register: vi.fn((desc: { name: string }) => { registeredSlots.push(desc.name); return () => {} }),
      },
      effect: vi.fn((fn: () => unknown) => { fn() }),
    } as unknown as ClientContext

    const done = applyClient(ctx)
    await vi.advanceTimersByTimeAsync(5100)
    await done
    expect(registeredSlots).toContain('settings.section')
    expect(registeredSlots).toContain('conversation.chat.assistant-actions')
    expect(registeredSlots).toContain('conversation.session.header.actions')
    expect(registeredSlots).toContain('conversation.input.dock')
  })
})
