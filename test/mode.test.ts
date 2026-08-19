/**
 * 客户端 Tavern 模式判定。
 * 覆盖：缺 useSessions / 非 tavern 预设都不得打开插件 UI。
 */
import { describe, expect, it } from 'vitest'
import { isCurrentTavernSession, isTavernSession } from '../src/client/mode.js'

describe('isTavernSession', () => {
  it('没有会话列表 hook 时视为非 Tavern（不挡原生 dsh）', () => {
    expect(isTavernSession(undefined, 'session-1')).toBe(false)
  })

  it('只在 agentPreset 为 tavern 时为真', () => {
    const useSessions = (sel: (s: { byId: Record<string, { agentPreset?: string } | undefined> }) => unknown) =>
      sel({ byId: { a: { agentPreset: 'tavern' }, b: { agentPreset: 'coding' } } })
    expect(isTavernSession(useSessions, 'a')).toBe(true)
    expect(isTavernSession(useSessions, 'b')).toBe(false)
    expect(isTavernSession(useSessions, 'missing')).toBe(false)
  })
})

describe('isCurrentTavernSession', () => {
  it('当前会话是 tavern 才为真', () => {
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: { a: { agentPreset: 'tavern' } } }),
      }),
    ).toBe(true)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: { a: { agentPreset: 'coding' } } }),
      }),
    ).toBe(false)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: {} }),
      }),
    ).toBe(false)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a' } as { current: string; byId?: Record<string, { agentPreset?: string }> }),
      }),
    ).toBe(false)
    expect(isCurrentTavernSession({ getSnapshot: () => ({ current: undefined, byId: {} }) })).toBe(false)
  })
})
