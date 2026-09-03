/**
 * 客户端 Tavern 模式判定。
 * 覆盖：缺 useSessions / 非 tavern 预设都不得打开插件 UI；
 * 0.1.2 起预设 id 只读 SessionSummary.projectionValues.agentPreset（顶层字段已移除）。
 */
import { describe, expect, it } from 'vitest'
import { isCurrentTavernSession, isTavernSession } from '../src/client/mode.js'

type Row = { projectionValues?: { agentPreset?: string | null } } | undefined
const tavernRow: Row = { projectionValues: { agentPreset: 'tavern' } }
const codingRow: Row = { projectionValues: { agentPreset: 'coding' } }

describe('isTavernSession', () => {
  it('没有会话列表 hook 时视为非 Tavern（不挡原生 dsh）', () => {
    expect(isTavernSession(undefined, 'session-1')).toBe(false)
  })

  it('只在 projectionValues.agentPreset 为 tavern 时为真', () => {
    const useSessions = (sel: (s: { byId: Record<string, Row> }) => unknown) =>
      sel({ byId: { a: tavernRow, b: codingRow } })
    expect(isTavernSession(useSessions, 'a')).toBe(true)
    expect(isTavernSession(useSessions, 'b')).toBe(false)
    expect(isTavernSession(useSessions, 'missing')).toBe(false)
  })

  it('投影值缺省或为 null 时视为非 Tavern', () => {
    const useSessions = (sel: (s: { byId: Record<string, Row> }) => unknown) =>
      sel({ byId: { a: {}, b: { projectionValues: { agentPreset: null } }, c: { projectionValues: {} } } })
    expect(isTavernSession(useSessions, 'a')).toBe(false)
    expect(isTavernSession(useSessions, 'b')).toBe(false)
    expect(isTavernSession(useSessions, 'c')).toBe(false)
  })
})

describe('isCurrentTavernSession', () => {
  it('当前会话是 tavern 才为真', () => {
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: { a: tavernRow } }),
      }),
    ).toBe(true)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: { a: codingRow } }),
      }),
    ).toBe(false)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a', byId: {} }),
      }),
    ).toBe(false)
    expect(
      isCurrentTavernSession({
        getSnapshot: () => ({ current: 'a' }) as {
          current: string
          byId?: Record<string, Row>
        },
      }),
    ).toBe(false)
    expect(isCurrentTavernSession({ getSnapshot: () => ({ current: undefined, byId: {} }) })).toBe(false)
  })
})
