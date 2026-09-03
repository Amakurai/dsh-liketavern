/**
 * 楼层 fork 的 agentOptions：子会话必须带上 provider/model，
 * 否则 system-prompt 插值 {{model}} 会在重新生成时抛无值错误。
 * 另覆盖：childWalLineage 祖先边界 clamp、sessionPrefixEvents、回滚楼层名、
 * inheritedThroughTurn、withEditedAssistantMessage、timerOwnerAtTurn、
 * editUserMessage 空文本拒绝（与 editAssistantMessage 同口径）、
 * resolveFloorTurn 的 messageId/turn 双定位（中断楼层操作条按 turn 定位）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import {
  childWalLineage,
  editUserMessage,
  floorNamesForLineageRollback,
  floorNamesForRollback,
  forkAgentOptions,
  inheritedThroughTurn,
  regenerate,
  resolveFloorTurn,
  rollbackToFloor,
  sessionPrefixEvents,
  timerOwnerAtTurn,
  withEditedAssistantMessage,
  type FloorDeps,
} from '../src/node/floors.js'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

function sessionOf(opts: {
  header?: { provider?: string; model?: string; maxTokens?: number }
  events?: SessionEvent[]
}): Session {
  return {
    requestHeader: () =>
      opts.header === undefined
        ? undefined
        : { config: { provider: opts.header.provider ?? '', model: opts.header.model ?? '', ...(opts.header.maxTokens !== undefined ? { maxTokens: opts.header.maxTokens } : {}) } },
    events: opts.events ?? [],
  } as unknown as Session
}

function assistant(provider: string, model: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    data: { message: { source: { provider, model } } },
  } as SessionEvent
}

describe('forkAgentOptions', () => {
  it('request/header 覆盖父 agent.options（换模后跟 header）', () => {
    const out = forkAgentOptions(
      { options: { provider: 'old', model: 'old-model', maxTokens: 100 } },
      sessionOf({ header: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 } }),
    )
    expect(out).toEqual({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 })
  })

  it('没有 header 时用父 agent.options', () => {
    const out = forkAgentOptions(
      { options: { provider: 'deepseek', model: 'deepseek-v4' } },
      sessionOf({}),
    )
    expect(out.provider).toBe('deepseek')
    expect(out.model).toBe('deepseek-v4')
  })

  it('父 options 与 header 都缺时，取最近非开场白 assistant source', () => {
    const out = forkAgentOptions(undefined, sessionOf({
      events: [
        assistant(TAVERN_GREETING_SOURCE.provider, TAVERN_GREETING_SOURCE.model),
        assistant('deepseek', 'deepseek-chat'),
      ],
    }))
    expect(out).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('跳过开场白 source，不会把 greeting 当成模型路由', () => {
    const out = forkAgentOptions(undefined, sessionOf({
      events: [assistant(TAVERN_GREETING_SOURCE.provider, TAVERN_GREETING_SOURCE.model)],
    }))
    expect(out.provider).toBeUndefined()
    expect(out.model).toBeUndefined()
  })
})

describe('sessionPrefixEvents', () => {
  it('boundary -1（turn/start 在 seq 0）得到空前缀，可重跑第一层', () => {
    const source = sessionOf({
      events: [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent],
    })
    expect(sessionPrefixEvents(source, -1)).toEqual([])
    expect(sessionPrefixEvents(source, 0)).toHaveLength(1)
  })
})

describe('floorNamesForRollback', () => {
  it('按 turn 数字升序交给 rollbackAfter，并排除其他会话与非法后缀', () => {
    expect(
      floorNamesForRollback(
        ['session-a#t10', 'session-b#t3', 'session-a#t2', 'session-a#t1', 'session-a#t2-extra'],
        'session-a',
        2,
      ),
    ).toEqual(['session-a#t2', 'session-a#t10'])
  })

  it('跨两次 fork 时纳入祖先边界内楼层，排除未继承的父会话后续楼层', () => {
    const floors = [
      'root#t1',
      'root#t2',
      'root#t3',
      'child#t3',
      'child#t4',
      'current#t5',
    ]
    expect(
      floorNamesForLineageRollback(
        floors,
        { walLineage: [{ sessionId: 'root', throughTurn: 2 }, { sessionId: 'child', throughTurn: 4 }] },
        'current',
        2,
      ),
    ).toEqual(['root#t2', 'child#t3', 'child#t4', 'current#t5'])
  })
})

describe('inheritedThroughTurn', () => {
  it('取 seed 内最大 turn/start，空 seed 返回 null', () => {
    const events = [
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'turn/end', data: { turn: 2 } },
      { type: 'turn/start', data: { turn: 10 } },
    ] as SessionEvent[]
    expect(inheritedThroughTurn(events)).toBe(10)
    expect(inheritedThroughTurn([])).toBeNull()
  })
})

describe('withEditedAssistantMessage', () => {
  const message = createAssistantMessage({
    content: [{ type: 'text', text: '旧台词' }],
    source: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, message },
      surfaceOp: 'append',
      sourceEventSeqs: [],
    },
    { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]

  it('替换指定消息的正文，保留 seq/surfaceOp/turn 与模型 source', () => {
    const out = withEditedAssistantMessage(events, message.id, '新台词')!
    expect(out).toHaveLength(3)
    const replaced = out[1]!
    expect(replaced.seq).toBe(1)
    expect(replaced.type).toBe('assistant/message')
    expect((replaced as { surfaceOp?: string }).surfaceOp).toBe('append')
    const data = replaced.data as { turn: number; message: { content: { type: string; text?: string }[]; source: { provider: string; model: string } } }
    expect(data.turn).toBe(1)
    expect(data.message.content).toEqual([{ type: 'text', text: '新台词' }])
    expect(data.message.source).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    // 其余事件原样保留（同一引用）
    expect(out[0]).toBe(events[0])
    expect(out[2]).toBe(events[2])
  })

  it('找不到消息返回 null，不改原数组', () => {
    expect(withEditedAssistantMessage(events, 'missing-id', 'x')).toBeNull()
    expect((events[1]!.data as { message: { content: { text?: string }[] } }).message.content[0]!.text).toBe('旧台词')
  })
})

describe('timerOwnerAtTurn', () => {
  const binding = { walLineage: [{ sessionId: 'root', throughTurn: 2 }, { sessionId: 'child', throughTurn: 4 }] }

  it('跨 fork 边界时从拥有目标 turn 的祖先复制定时器', () => {
    expect(timerOwnerAtTurn(binding, 'current', 1)).toBe('root')
    expect(timerOwnerAtTurn(binding, 'current', 3)).toBe('child')
    expect(timerOwnerAtTurn(binding, 'current', 5)).toBe('current')
  })
})

describe('childWalLineage', () => {
  it('在祖先条目后追加源会话边界', () => {
    expect(childWalLineage({ walLineage: [{ sessionId: 'root', throughTurn: 2 }] }, 'parent', 4)).toEqual([
      { sessionId: 'root', throughTurn: 2 },
      { sessionId: 'parent', throughTurn: 4 },
    ])
  })

  it('回退 fork 时祖先边界 clamp 到新 seed 实际继承的边界', () => {
    // A(turn1-10) 在 turn5 重生成得 B（[{A,4}]），B 回退到 turn3 得 C：C 只继承了 A 的 turn1-3。
    expect(childWalLineage({ walLineage: [{ sessionId: 'A', throughTurn: 4 }] }, 'B', 3)).toEqual([
      { sessionId: 'A', throughTurn: 3 },
      { sessionId: 'B', throughTurn: 3 },
    ])
  })

  it('空 seed（throughTurn=null）丢弃全部祖先条目', () => {
    expect(childWalLineage({ walLineage: [{ sessionId: 'A', throughTurn: 4 }] }, 'B', null)).toEqual([])
  })

  it('世系里已有源会话条目时替换而非重复', () => {
    expect(
      childWalLineage(
        { walLineage: [{ sessionId: 'A', throughTurn: 4 }, { sessionId: 'B', throughTurn: 2 }] },
        'B',
        3,
      ),
    ).toEqual([
      { sessionId: 'A', throughTurn: 3 },
      { sessionId: 'B', throughTurn: 3 },
    ])
  })

  it('无既有世系时只有源会话条目', () => {
    expect(childWalLineage({}, 'A', 2)).toEqual([{ sessionId: 'A', throughTurn: 2 }])
  })
})

describe('editUserMessage 空文本', () => {
  const message = createAssistantMessage({
    content: [{ type: 'text', text: '旧台词' }],
    source: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }),
    },
    { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 1, message } },
    { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  const session = { id: 'session-x', header: { agentPreset: 'tavern' }, events } as unknown as Session
  const deps = {
    ctx: {
      sessions: { get: (id: string) => (id === session.id ? session : undefined) },
      agents: { get: () => undefined },
      get: () => undefined,
    } as unknown as Context,
    state: {},
  } as unknown as FloorDeps

  it('拒绝空串与纯空白文本（empty-text），在 fork 之前抛错', async () => {
    await expect(editUserMessage(deps, session.id, message.id, '')).rejects.toMatchObject({ code: 'empty-text' })
    await expect(editUserMessage(deps, session.id, message.id, '   ')).rejects.toMatchObject({ code: 'empty-text' })
  })
})

describe('resolveFloorTurn（中断楼层按 turn 号定位）', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 0, data: { turn: 1, step: 1, message: { id: 'm1' } } },
    { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 3, time: 0, data: { turn: 2 } },
    { type: 'assistant/message', seq: 4, time: 0, data: { turn: 2, step: 1, message: { id: 'm2' } } },
    { type: 'turn/end', seq: 5, time: 0, data: { turn: 2, reason: { kind: 'interrupted' } } },
  ] as unknown as SessionEvent[]

  it('messageId 优先，turn 兜底；未知定位返回 null', () => {
    expect(resolveFloorTurn(events, 'm1', 2)).toBe(1)
    expect(resolveFloorTurn(events, 'm2')).toBe(2)
    expect(resolveFloorTurn(events, undefined, 2)).toBe(2)
    expect(resolveFloorTurn(events, 'missing')).toBeNull()
    expect(resolveFloorTurn(events, undefined, 3)).toBeNull()
    expect(resolveFloorTurn(events, undefined, 0)).toBeNull()
    expect(resolveFloorTurn(events)).toBeNull()
  })

  const session = { id: 'session-x', header: { agentPreset: 'tavern' }, events } as unknown as Session
  const deps = {
    ctx: {
      sessions: { get: (id: string) => (id === session.id ? session : undefined) },
      agents: { get: () => undefined },
      get: () => undefined,
    } as unknown as Context,
    state: {},
  } as unknown as FloorDeps

  it('regenerate / rollbackToFloor 接受 turn 定位；未知 turn 报 no-message', async () => {
    await expect(regenerate(deps, session.id, undefined, 3)).rejects.toMatchObject({ code: 'no-message' })
    await expect(rollbackToFloor(deps, session.id, undefined, 3)).rejects.toMatchObject({ code: 'no-message' })
    await expect(rollbackToFloor(deps, session.id)).rejects.toMatchObject({ code: 'no-message' })
  })
})
