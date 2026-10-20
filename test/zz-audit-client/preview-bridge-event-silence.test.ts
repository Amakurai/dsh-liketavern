/**
 * 修复后行为（C1）：无 helper 快照的普通卡面走“预览桥” `attachCardBridgeRuntime`。
 * 预览不接入剧情事件桥，但必须回明确失败回执，不能让卡面的 await 永久 pending；
 * 同时保持“预览无剧情分组、不接收跨卡监听”的安全边界（订阅不会真的登记监听）。
 */
import { describe, expect, it } from 'vitest'
import { attachCardBridgeRuntime, attachHelperEvents } from '../../src/client/helperEventRouter.js'

type Message = Record<string, unknown>

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('预览桥（无 helper 快照卡面）的事件请求', () => {
  it('helperEventEmit / helperEventSubscribe 得到明确失败回执，而不是静默挂起', async () => {
    const sent: Message[] = []
    const preview = attachCardBridgeRuntime((message) => sent.push(message))
    preview.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'preview-runtime-1' })
    expect(preview.matchesRuntime('preview-runtime-1')).toBe(true)

    preview.receive({
      source: 'dsh-tavern-card', action: 'helperEventEmit', runtimeId: 'preview-runtime-1',
      requestId: 'emit-1', event: 'character_message_rendered', args: [1, 'normal'],
    })
    preview.receive({
      source: 'dsh-tavern-card', action: 'helperEventSubscribe', runtimeId: 'preview-runtime-1',
      listenerId: 'l1', event: 'character_message_rendered', once: false, position: 'normal',
    })
    await flush()

    const results = sent.filter((message) => message.action === 'helperEventResult')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ runtimeId: 'preview-runtime-1', requestId: 'emit-1', ok: false, args: [] })
    expect(String(results[0]!.error)).toContain('预览')
    expect(results[1]).toMatchObject({ runtimeId: 'preview-runtime-1', ok: false, args: [] })
    // 边界不变：预览不建立跨卡监听，也不会把 emit 转给任何分组。
    expect(sent.some((message) => message.action === 'helperEventDeliver')).toBe(false)
    preview.dispose()
  })

  it('完整业务桥对同一 emit 仍回成功回执（对照）', async () => {
    const sent: Message[] = []
    const endpoint = attachHelperEvents('session-1', 'story-1', (message) => sent.push(message))
    endpoint.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'full-runtime-1' })
    endpoint.receive({
      source: 'dsh-tavern-card', action: 'helperEventEmit', runtimeId: 'full-runtime-1',
      requestId: 'emit-1', event: 'character_message_rendered', args: [1, 'normal'],
    })
    await flush()

    const result = sent.find((message) => message.action === 'helperEventResult')
    expect(result).toMatchObject({ requestId: 'emit-1', ok: true })
    endpoint.dispose()
  })
})
