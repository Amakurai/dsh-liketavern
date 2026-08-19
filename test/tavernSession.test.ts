/**
 * host 侧 Tavern 会话判定。
 * 覆盖：活 agent 组成预设优先于会话 header；非 tavern 不得当 Tavern 处理。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { isTavernRuntimeSession } from '../src/node/tavernSession.js'

function session(agentPreset?: string, events: Session['events'] = []): Session {
  return { id: 'session-1', header: { agentPreset }, events } as Session
}

function ctx(livePreset?: string): Context {
  return {
    get: () => (livePreset === undefined ? undefined : { composedPreset: () => livePreset }),
    agents: { get: () => (livePreset === undefined ? undefined : { ctx: {} }) },
  } as Context
}

describe('isTavernRuntimeSession', () => {
  it('header 为 tavern 且无活 agent 时为真', () => {
    expect(isTavernRuntimeSession(ctx(), session('tavern'))).toBe(true)
  })

  it('header 为其它预设时为假', () => {
    expect(isTavernRuntimeSession(ctx(), session('coding'))).toBe(false)
    expect(isTavernRuntimeSession(ctx(), session(undefined))).toBe(false)
  })

  it('活 agent 组成预设覆盖 header', () => {
    expect(isTavernRuntimeSession(ctx('tavern'), session('coding'))).toBe(true)
    expect(isTavernRuntimeSession(ctx('coding'), session('tavern'))).toBe(false)
  })
})
