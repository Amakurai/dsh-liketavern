/**
 * 修复后行为（C7，裁决 A）：runtimeId 是卡面自报的文档内重建标识，两端统一 1..96；
 * 宿主签发的 frameId 与 token 仍是 ≥8。客户端 connect 不再拒绝短 id（与 remote 一致），
 * 超过 96 字符仍被忽略，避免身份被任意长字符串污染。
 */
import { describe, expect, it } from 'vitest'
import { attachHelperEvents } from '../../src/client/helperEventRouter.js'
import { closeHelperFrame } from '../../src/node/helperFrameLease.js'
import type { TavernState } from '../../src/node/state.js'
import { METHODS } from '../../src/remote.js'

const base = { sessionId: 's', messageId: 0, storyId: 'st', frameId: 'frame-12345678', epoch: 1, readOnly: false }
const acceptsRuntimeId = (runtimeId: string) => METHODS.openHelperFrame.req.safeParse({ ...base, runtimeId }).success

describe('卡面运行时身份校验口径', () => {
  it('客户端与 remote schema 都接受 1..96 字符的 runtimeId，拒绝 97 字符', () => {
    const sent: Record<string, unknown>[] = []
    const endpoint = attachHelperEvents('session-1', 'story-1', (message) => sent.push(message))

    // 1 字符与 96 字符：两端都接受（短 id 卡面端到端可用）。
    endpoint.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'a' })
    expect(endpoint.matchesRuntime('a')).toBe(true)
    expect(acceptsRuntimeId('a')).toBe(true)

    const long96 = 'r'.repeat(96)
    endpoint.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: long96 })
    expect(endpoint.matchesRuntime(long96)).toBe(true)
    expect(acceptsRuntimeId(long96)).toBe(true)

    // 97 字符：客户端忽略该 Connect（身份不被替换），schema 也拒绝。
    endpoint.receive({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: 'x'.repeat(97) })
    expect(endpoint.matchesRuntime('x'.repeat(97))).toBe(false)
    expect(endpoint.matchesRuntime(long96)).toBe(true)
    expect(acceptsRuntimeId('x'.repeat(97))).toBe(false)
    endpoint.dispose()
  })

  it('frameId 与 token 仍是宿主签发的 ≥8 字符身份', () => {
    expect(METHODS.openHelperFrame.req.safeParse({ ...base, frameId: 'short', runtimeId: 'a' }).success).toBe(false)
    expect(METHODS.openHelperFrame.req.safeParse({ ...base, frameId: 'frame-12345678', runtimeId: 'a' }).success).toBe(true)

    const edit = (token: string) => METHODS.editHelperMessages.req.safeParse({
      sessionId: 's', messageId: 0, storyId: 'st', historyRevision: 'h', edits: [],
      frameLease: { frameId: 'frame-12345678', runtimeId: 'a', epoch: 1, token },
    }).success
    expect(edit('short')).toBe(false)
    expect(edit('token-1234')).toBe(true)
    const dummyState = {} as TavernState
    expect(() => closeHelperFrame(dummyState, { ...base, runtimeId: 'a' })).not.toThrow()
    expect(() => closeHelperFrame(dummyState, { ...base, runtimeId: '' })).toThrow('卡面运行时身份无效')
    expect(() => closeHelperFrame(dummyState, { ...base, frameId: 'short', runtimeId: 'a' })).toThrow('卡面运行时身份无效')
  })
})
