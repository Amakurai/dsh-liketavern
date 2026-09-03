/**
 * host 侧 Tavern 会话判定。
 * 覆盖：活 agent 组成预设优先于会话投影；投影服务缺席时折叠 header +
 * agent-preset/selected 事件兜底；非 tavern 不得当 Tavern 处理。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isTavernRuntimeSession, sessionPresetId } from '../src/node/tavernSession.js'

function session(agentPreset?: string, events: readonly SessionEvent[] = []): Session {
  return { id: 'session-1', header: { agentPreset }, snapshotEvents: () => events } as unknown as Session
}

function selected(agentPreset: string): SessionEvent {
  return { type: 'agent-preset/selected', seq: 0, time: 0, data: { agentPreset } } as unknown as SessionEvent
}

function ctx(livePreset?: string, projections?: { stateOf(session: Session, key: 'agentPreset'): string | null | undefined }): Context {
  return {
    get: (name: string) => {
      if (name === 'sessionProjections') return projections
      return livePreset === undefined ? undefined : { composedPreset: () => livePreset }
    },
    agents: { get: () => (livePreset === undefined ? undefined : { ctx: {} }) },
  } as unknown as Context
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

  it('agent-preset/selected 事件推进 header 初始值（空白期换预设）', () => {
    expect(isTavernRuntimeSession(ctx(), session('coding', [selected('tavern')]))).toBe(true)
    expect(isTavernRuntimeSession(ctx(), session('tavern', [selected('coding')]))).toBe(false)
  })

  it('投影服务提供 agentPreset 键时以投影为准', () => {
    const projections = { stateOf: () => 'tavern' as string | null }
    expect(sessionPresetId(ctx(undefined, projections), session('coding'))).toBe('tavern')
    expect(isTavernRuntimeSession(ctx(undefined, projections), session('coding'))).toBe(true)
  })
})
