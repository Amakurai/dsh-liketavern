/**
 * 楼层 fork 的 agentOptions：子会话必须带上 provider/model，
 * 否则 system-prompt 插值 {{model}} 会在重新生成时抛无值错误。
 */
import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import {
  floorNamesForLineageRollback,
  floorNamesForRollback,
  forkAgentOptions,
  inheritedThroughTurn,
  sessionPrefixEvents,
  timerOwnerAtTurn,
  withEditedAssistantMessage,
} from '../src/node/floors.js'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'

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
