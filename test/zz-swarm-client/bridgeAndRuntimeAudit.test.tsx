/**
 * 客户端沙箱桥接、MVU 租约恢复、事件路由 O(1) 索引与流式续写快照回归测试：
 * - HelperMvuRunner：沙箱卡死/失联重建（sandboxGen 递增）时复用同一 (sessionId, storyId) 宿主租约身份，避免触发服务端 90s 租约自锁；跨 storyId 切换仍轮换租约身份
 * - SpeechHtmlFrame：srcDoc 替换（含静态 HTML 不重连场景）及 storyId 切换时立即清理陈旧 editedBranch / branchError 与 onBranchError，同身份文档替换仍保留 retiredRuntimes 防重放
 * - helperEventRouter：O(1) 监听注册/重排/卸载、once 自动释放 1024 单卡预算槽位、派发中途退订即时拦截
 * - 客户端通知存储：回调内同步退订并重订时不死循环重入
 * - useContinuationStream：流式非持久化修订推进且持久化事件未变时保持零拷贝引用稳定
 */
import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useContinuationStream } from '../../src/client/continuationStream.js'
import { setSpeakerHeader, useSpeakerHeader } from '../../src/client/displayPrefs.js'
import { clearScriptChoices, publishScriptChoices, ScriptChoices } from '../../src/client/helperChoices.js'
import { attachHelperEvents, emitHelperHostEvent } from '../../src/client/helperEventRouter.js'
import { HelperMvuRunner } from '../../src/client/helperMvuRunner.js'
import { notifyHelperStory, watchHelperStory } from '../../src/client/helperNotifications.js'
import {
  notifyHelperScriptAssets,
  notifyHelperScripts,
  watchHelperScriptAssets,
  watchHelperScripts,
} from '../../src/client/helperScriptNotifications.js'
import { clearScriptStatus, publishScriptStatus, scriptStatusStore } from '../../src/client/helperScriptStatus.js'
import { setTavernLocale, t, useT } from '../../src/client/i18n.js'
import { SpeechHtmlFrame } from '../../src/client/speech.js'
import type { Envelope, TavernRemote } from '../../src/client/types.js'
import { Btn } from '../../src/client/util.js'
import type { HelperMvuWork } from '../../src/core/helperMvu.js'
import type { HelperSnapshot } from '../../src/core/helperRuntime.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p>{props.text}</p>,
  IconCopyOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map(textOf).join('')
}

function makeSnapshot(storyId = 'story-1', currentMessageId = 1): HelperSnapshot {
  return {
    storyId,
    historyRevision: 'rev-1',
    currentMessageId,
    writable: true,
    scopes: {},
    messages: [
      { message_id: 0, role: 'user', name: '旅人', message: '你好', data: {}, extra: {}, is_hidden: false },
      { message_id: 1, role: 'assistant', name: '向导', message: '欢迎', data: {}, extra: {}, is_hidden: false },
    ],
  }
}

const mounted: ReactTestRenderer[] = []
const cleanups: Array<() => void> = []
let winTarget: EventTarget

beforeEach(() => {
  winTarget = Object.assign(new EventTarget(), {
    sessionStorage: { getItem: () => 'swarm-client-tab', setItem() {} },
  })
  vi.stubGlobal('window', winTarget)
  setTavernLocale('zh')
})

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.()
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTavernLocale('zh')
  setSpeakerHeader(false)
})

function dispatchCardMessage(source: unknown, data: Record<string, unknown>): void {
  const event = Object.assign(new Event('message'), { source, data })
  winTarget.dispatchEvent(event)
}

describe('沙箱桥接、MVU 租约恢复与事件路由回归', () => {
  it('HelperMvuRunner 在沙箱忙态失败并重建 iframe 后沿用同一宿主 runtimeId 立即续回服务端 90s 租约，跨剧情则轮换身份', async () => {
    const frames: Array<{ postMessage: ReturnType<typeof vi.fn> }> = []
    let activeLease: { storyId: string; runtimeId: string; token: string; expiresAt: number } | null = null
    let committed = false
    const seenRuntimeIds: Array<{ storyId: string; runtimeId: string }> = []

    const prepareHelperMvuJob = vi.fn(async (req: { sessionId: string; storyId: string; runtimeId: string }): Promise<Envelope<HelperMvuWork>> => {
      seenRuntimeIds.push({ storyId: req.storyId, runtimeId: req.runtimeId })
      if (committed || req.storyId !== 'story-1') {
        return ok({ enabled: true, status: 'idle', storyId: req.storyId })
      }
      const now = Date.now()
      if (activeLease && activeLease.storyId === req.storyId && activeLease.expiresAt > now && activeLease.runtimeId !== req.runtimeId) {
        // 真实复现服务端 src/node/helperMvu.ts 的 90s 租约互斥逻辑
        return ok({ enabled: true, status: 'waiting', storyId: req.storyId })
      }
      const token = activeLease?.runtimeId === req.runtimeId ? activeLease.token : `lease-${seenRuntimeIds.length}`
      activeLease = { storyId: req.storyId, runtimeId: req.runtimeId, token, expiresAt: now + 90_000 }
      return ok({
        enabled: true,
        status: 'pending',
        storyId: req.storyId,
        token,
        snapshot: makeSnapshot(req.storyId),
        job: {
          id: 'job-1',
          kind: 'update',
          seq: 1,
          identity: 's-mvu#1',
          text: '<UpdateVariable>hp=9</UpdateVariable>',
          turn: 1,
          floor: 's-mvu#t1',
        },
      })
    })
    const commitHelperMvuJob = vi.fn(async (req: { runtimeId: string; token: string }): Promise<Envelope<HelperMvuWork>> => {
      expect(req.runtimeId).toBe(activeLease?.runtimeId)
      expect(req.token).toBe(activeLease?.token)
      committed = true
      activeLease = null
      return ok({ enabled: true, status: 'idle', storyId: 'story-1' })
    })
    const remote = { prepareHelperMvuJob, commitHelperMvuJob } as unknown as TavernRemote
    const snapshot = makeSnapshot('story-1')

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <HelperMvuRunner remote={remote} sessionId="s-mvu" storyId="story-1" snapshot={snapshot} ready={true} />,
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
    mounted.push(view)
    expect(frames).toHaveLength(1)

    // 首个沙箱连接并领取任务，进入 sandboxBusy=true
    await act(async () => {
      dispatchCardMessage(frames[0]!, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'sandbox-1' })
      dispatchCardMessage(frames[0]!, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'sandbox-1' })
    })
    expect(prepareHelperMvuJob).toHaveBeenCalledTimes(1)
    const runCall1 = frames[0]!.postMessage.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)?.action === 'helperMvuRun',
    )?.[0] as Record<string, unknown> | undefined
    expect(runCall1).toBeDefined()

    // 计算中途脚本短暂失联（ready=false），唤醒轮询后失败，但旧沙箱仍占着 sandboxBusy=true
    await act(async () => {
      view.update(<HelperMvuRunner remote={remote} sessionId="s-mvu" storyId="story-1" snapshot={snapshot} ready={false} />)
    })
    expect(textOf(view.root)).toContain(t('speech.mvuScriptsNotReady'))

    // 脚本重新就绪后用户点击重试：触发 sandboxGen++ 重建新 iframe
    await act(async () => {
      view.update(<HelperMvuRunner remote={remote} sessionId="s-mvu" storyId="story-1" snapshot={snapshot} ready={true} />)
    })
    const retryBtn = view.root.findAllByType(Btn).find((b) => textOf(b) === t('speech.mvuRetry'))
    expect(retryBtn).toBeDefined()
    await act(async () => {
      retryBtn!.props.onClick()
    })
    expect(frames).toHaveLength(2)

    // 旧沙箱 runtimeId 已退役，不能在新帧重放；新沙箱连接后立即以原宿主 runtimeId 取回任务而非被 90s 租约挡成 waiting
    await act(async () => {
      dispatchCardMessage(frames[1]!, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'sandbox-2' })
      dispatchCardMessage(frames[1]!, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'sandbox-2' })
    })
    expect(seenRuntimeIds).toHaveLength(2)
    expect(seenRuntimeIds[1]!.runtimeId).toBe(seenRuntimeIds[0]!.runtimeId)

    const runCall2 = frames[1]!.postMessage.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)?.action === 'helperMvuRun',
    )?.[0] as { requestId: string } | undefined
    expect(runCall2).toBeDefined()

    await act(async () => {
      dispatchCardMessage(frames[1]!, {
        source: 'dsh-tavern-card',
        action: 'helperMvuResult',
        runtimeId: 'sandbox-2',
        requestId: runCall2!.requestId,
        ok: true,
        data: { message: { 1: { hp: 9 } } },
      })
    })
    expect(commitHelperMvuJob).toHaveBeenCalledTimes(1)
    expect(textOf(view.root)).toContain(t('speech.mvuReady'))

    // 切换到新 storyId 时必须旋转宿主租约身份，不能跨剧情共用同一 runtimeId
    const snapshot2 = makeSnapshot('story-2')
    await act(async () => {
      view.update(<HelperMvuRunner remote={remote} sessionId="s-mvu" storyId="story-2" snapshot={snapshot2} ready={true} />)
    })
    const latestFrame = frames.at(-1)!
    await act(async () => {
      dispatchCardMessage(latestFrame, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'sandbox-story-2' })
      dispatchCardMessage(latestFrame, { source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId: 'sandbox-story-2' })
    })
    const story2Call = seenRuntimeIds.find((item) => item.storyId === 'story-2')
    expect(story2Call).toBeDefined()
    expect(story2Call!.runtimeId).not.toBe(seenRuntimeIds[0]!.runtimeId)
  })

  it('SpeechHtmlFrame 在 srcDoc 替换为静态页或 storyId 切换时清理陈旧分支按钮与错误，且同身份文档替换保留 retiredRuntimes', async () => {
    const openCalls: Array<{ frameId: string; storyId: string; runtimeId: string; epoch: number }> = []
    const openHelperFrame = vi.fn(async (req: { frameId: string; storyId: string; runtimeId: string; epoch: number }) => {
      openCalls.push(req)
      return ok({ token: `tok-${openCalls.length}` })
    })
    const closeHelperFrame = vi.fn(async () => ok({ ok: true }))
    const remote = { openHelperFrame, closeHelperFrame } as unknown as TavernRemote
    const frameWindow = { postMessage: vi.fn() }
    const branchNotifications: Array<{ childSessionId: string | null; error: string | null }> = []

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(
        <SpeechHtmlFrame
          srcDoc="<html><body>v1</body></html>"
          title="card"
          widget={false}
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 's-branch', storyId: 'story-a' }}
          onBranchError={(branch, error) => branchNotifications.push({ childSessionId: branch?.childSessionId ?? null, error })}
          onMessageEdit={async () => ({
            snapshot: makeSnapshot('story-a'),
            branch: { childSessionId: 'session-child-a', title: '分支 A' },
          })}
          onMessageBranch={async () => {
            throw new Error('跳转子会话失败')
          }}
        />,
        { createNodeMock: (el) => (el.type === 'iframe' ? { contentWindow: frameWindow } : null) },
      )
    })
    mounted.push(view)

    await act(async () => {
      dispatchCardMessage(frameWindow, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-old' })
    })
    expect(openCalls).toHaveLength(1)

    await act(async () => {
      dispatchCardMessage(frameWindow, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEdit',
        runtimeId: 'rt-old',
        requestId: 'edit-1',
        storyId: 'story-a',
        historyRevision: 'rev-1',
        edits: [{ message_id: 1, message: '改后正文' }],
      })
    })
    await act(async () => {
      dispatchCardMessage(frameWindow, {
        source: 'dsh-tavern-card',
        action: 'helperMessageEditApplied',
        runtimeId: 'rt-old',
        requestId: 'edit-1',
      })
    })

    expect(textOf(view.root)).toContain(t('speech.openEditedBranch'))
    expect(textOf(view.root)).toContain('跳转子会话失败')
    expect(branchNotifications.at(-1)).toEqual({ childSessionId: 'session-child-a', error: '跳转子会话失败' })

    // 同一 (sessionId, storyId, messageId) 替换为不含脚本的静态 HTML（不发送 helperEventConnect）：
    // 必须立即清除旧分支按钮和报错，但仍须保留已退役的 rt-old 防止重连重放。
    await act(async () => {
      view.update(
        <SpeechHtmlFrame
          srcDoc="<html><body>static-v2</body></html>"
          title="card"
          widget={false}
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 's-branch', storyId: 'story-a' }}
          onBranchError={(branch, error) => branchNotifications.push({ childSessionId: branch?.childSessionId ?? null, error })}
          onMessageEdit={async () => ({
            snapshot: makeSnapshot('story-a'),
            branch: { childSessionId: 'session-child-a', title: '分支 A' },
          })}
          onMessageBranch={async () => {}}
        />,
      )
    })
    expect(textOf(view.root)).not.toContain(t('speech.openEditedBranch'))
    expect(textOf(view.root)).not.toContain('跳转子会话失败')
    expect(branchNotifications.at(-1)).toEqual({ childSessionId: null, error: null })

    // 尝试复用已退役的 rt-old 重连：必须被拒绝，不得再次触发 openHelperFrame
    await act(async () => {
      dispatchCardMessage(frameWindow, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-old' })
    })
    expect(openCalls).toHaveLength(1)

    // 切换 storyId（例如同会话绑定换到新剧情）时，frameId 必须旋转且 epoch 归 1
    await act(async () => {
      view.update(
        <SpeechHtmlFrame
          srcDoc="<html><body>story-b</body></html>"
          title="card"
          widget={false}
          remote={remote}
          helperMessageId={1}
          helperBinding={{ sessionId: 's-branch', storyId: 'story-b' }}
        />,
      )
    })
    await act(async () => {
      dispatchCardMessage(frameWindow, { source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-story-b' })
    })
    expect(openCalls).toHaveLength(2)
    expect(openCalls[1]!.storyId).toBe('story-b')
    expect(openCalls[1]!.frameId).not.toBe(openCalls[0]!.frameId)
    expect(openCalls[1]!.epoch).toBe(1)
  })

  it('helperEventRouter 支持 O(1) 重排、派发中途退订拦截，并在 once 触发后立即释放单卡 1024 预算槽位', async () => {
    const order: string[] = []
    const results: Array<Record<string, unknown>> = []
    const epA = attachHelperEvents('s-ev', 'story-ev', (msg) => {
      if (msg.action === 'helperEventResult') results.push(msg)
      if (msg.action === 'helperEventDeliver' && typeof msg.deliveryId === 'string' && typeof msg.listenerId === 'string') {
        order.push(msg.listenerId)
        if (msg.listenerId === 'first-sub') {
          // 在首个监听器内同步退订尚未执行的 cancel-me
          epA.receive({ source: 'dsh-tavern-card', action: 'helperEventUnsubscribe', runtimeId: 'rt-ep-a', listenerId: 'cancel-me' })
        }
        queueMicrotask(() => {
          epA.receive({
            source: 'dsh-tavern-card',
            action: 'helperEventReply',
            runtimeId: 'rt-ep-a',
            deliveryId: msg.deliveryId,
            ok: true,
            args: [Number((msg.args as unknown[])[0] ?? 0) + 1],
          })
        })
      }
    })
    cleanups.push(() => epA.dispose())
    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-ep-a' })

    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'rt-ep-a', listenerId: 'normal-sub', event: 'ping', once: false, position: 'normal' })
    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'rt-ep-a', listenerId: 'cancel-me', event: 'ping', once: false, position: 'last' })
    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'rt-ep-a', listenerId: 'first-sub', event: 'ping', once: true, position: 'first' })
    // normal-sub 重排到最末
    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'rt-ep-a', listenerId: 'normal-sub', event: 'ping', once: false, position: 'last' })

    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventEmit', runtimeId: 'rt-ep-a', requestId: 'emit-1', event: 'ping', args: [10] })
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(order).toEqual(['first-sub', 'normal-sub'])
    expect(results[0]).toMatchObject({ ok: true, args: [12] })

    // first-sub(once) 与 cancel-me 已移除，当前仅剩 normal-sub（1 项）；再注册 1023 项应恰好达 1024 上限而不误报超预算
    for (let i = 0; i < 1023; i++) {
      epA.receive({
        source: 'dsh-tavern-card',
        action: 'helperEventSubscribe',
        runtimeId: 'rt-ep-a',
        listenerId: `fill-${i}`,
        event: 'bulk',
        once: false,
        position: 'normal',
      })
    }
    expect(results).toHaveLength(1)

    // 第 1025 项超出单卡 1024 上限，必须返回明确失败回执
    epA.receive({
      source: 'dsh-tavern-card',
      action: 'helperEventSubscribe',
      requestId: 'over-budget',
      runtimeId: 'rt-ep-a',
      listenerId: 'fill-overflow',
      event: 'bulk',
      once: false,
      position: 'normal',
    })
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ requestId: 'over-budget', ok: false })

    // 宿主事件 once 触发后同样释放 entries 槽位
    epA.receive({ source: 'dsh-tavern-card', action: 'helperEventUnsubscribe', runtimeId: 'rt-ep-a', listenerId: 'fill-0' })
    const hostDeliveries: string[] = []
    let pendingHostArgs: unknown = []
    const epHost = attachHelperEvents('s-ev', 'story-host', (msg) => {
      if (msg.action === 'helperEventDeliver' && typeof msg.deliveryId === 'string') {
        hostDeliveries.push(String(msg.listenerId))
        pendingHostArgs = msg.args
        queueMicrotask(() => {
          epHost.receive({ source: 'dsh-tavern-card', action: 'helperEventPrepared', runtimeId: 'rt-host', deliveryId: msg.deliveryId, args: pendingHostArgs })
        })
      }
      if (msg.action === 'helperEventExecute' && typeof msg.deliveryId === 'string') {
        queueMicrotask(() => {
          epHost.receive({ source: 'dsh-tavern-card', action: 'helperEventReply', runtimeId: 'rt-host', deliveryId: msg.deliveryId, ok: true, args: pendingHostArgs })
        })
      }
    })
    cleanups.push(() => epHost.dispose())
    epHost.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'rt-host' })
    epHost.receive({ source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'rt-host', listenerId: 'once-host', event: 'message_sent', once: true, position: 'normal' })

    await emitHelperHostEvent('s-ev', 'story-host', 'message_sent', [0])
    await emitHelperHostEvent('s-ev', 'story-host', 'message_sent', [0])
    expect(hostDeliveries).toEqual(['once-host'])
  })

  it('各客户端通知存储在监听回调内同步退订再重订时只触发本轮快照，不发生死循环重入', async () => {
    let storyFires = 0
    let stopStory = () => {}
    const storyCb = () => {
      storyFires++
      stopStory()
      stopStory = watchHelperStory('s-re', 'st-re', storyCb)
    }
    stopStory = watchHelperStory('s-re', 'st-re', storyCb)
    cleanups.push(() => stopStory())
    notifyHelperStory('s-re', 'st-re')
    expect(storyFires).toBe(1)

    let scriptFires = 0
    let stopScript = () => {}
    const scriptCb = () => {
      scriptFires++
      stopScript()
      stopScript = watchHelperScripts('s-re', 'st-re', scriptCb)
    }
    stopScript = watchHelperScripts('s-re', 'st-re', scriptCb)
    cleanups.push(() => stopScript())
    notifyHelperScripts('s-re', 'st-re')
    expect(scriptFires).toBe(1)

    let assetFires = 0
    let stopAsset = () => {}
    const assetCb = () => {
      assetFires++
      stopAsset()
      stopAsset = watchHelperScriptAssets(assetCb)
    }
    stopAsset = watchHelperScriptAssets(assetCb)
    cleanups.push(() => stopAsset())
    notifyHelperScriptAssets({ type: 'global' })
    expect(assetFires).toBe(1)

    let statusFires = 0
    let stopStatus = () => {}
    const owner = Symbol('status-re')
    const statusCb = () => {
      statusFires++
      stopStatus()
      stopStatus = scriptStatusStore.subscribe(statusCb)
    }
    stopStatus = scriptStatusStore.subscribe(statusCb)
    cleanups.push(() => {
      stopStatus()
      clearScriptStatus(owner, 's-re')
    })
    publishScriptStatus(owner, { sessionId: 's-re', cardId: 'c1', state: 'running', nativeMvu: false, scripts: [] })
    expect(statusFires).toBe(1)

    // useSpeakerHeader / useT / ScriptChoices 通过快照安全通知订阅组件
    const choiceOwner = Symbol('choice-re')
    cleanups.push(() => clearScriptChoices(choiceOwner))
    const Probe = () => {
      const tr = useT()
      const header = useSpeakerHeader()
      return (
        <div>
          <span>{header ? tr('action.save') : tr('action.cancel')}</span>
          <ScriptChoices sessionId="s-re" context={{ storyId: 'st-re', historyRevision: 'rev-1', currentMessageId: 1 }} />
        </div>
      )
    }
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<Probe />)
    })
    mounted.push(view)
    await act(async () => {
      setSpeakerHeader(true)
      setTavernLocale('en')
      publishScriptChoices(choiceOwner, 's-re', makeSnapshot('st-re', 1), 1, [{ label: 'Option A', text: 'Pick A' }])
    })
    expect(textOf(view.root)).toContain('Save')
    expect(textOf(view.root)).toContain('Option A')
  })

  it('useContinuationStream 在流式非事件修订连续推进时复用持久化事件数组，不重复触发前文裁剪重算', async () => {
    const persistentEvent = {
      type: 'turn/start',
      data: { turn: 1 },
    } as unknown as SessionEvent
    let currentWindow: SessionEventWindow = {
      revision: 1,
      entries: [{ type: 'event', seq: 1, event: persistentEvent }],
    } as unknown as SessionEventWindow
    const subs = new Set<() => void>()
    const source: SessionEventSource = {
      getSnapshot: () => currentWindow,
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    }

    const results: Array<{ text: string; error?: string }> = []
    function StreamConsumer(props: { text: string }) {
      const value = useContinuationStream(source, 1, undefined, props.text)
      results.push(value)
      return <span>{value.text}</span>
    }

    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<StreamConsumer text="正文流式片段" />)
    })
    mounted.push(view)
    const firstResult = results.at(-1)!
    expect(firstResult.text).toBe('正文流式片段')

    // 模拟非持久化状态引起 replace 修订推进，但持久化 event 列表与 text 均未变
    await act(async () => {
      currentWindow = {
        revision: 2,
        change: { kind: 'replace' },
        entries: [{ type: 'event', seq: 1, event: persistentEvent }],
      } as unknown as SessionEventWindow
      for (const fn of [...subs]) fn()
    })
    expect(results.at(-1)).toBe(firstResult)
  })
})
