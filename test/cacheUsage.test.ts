/**
 * 缓存用量汇总单测：按轮累计宿主互不重叠的 usage 口径，命中率分母含缓存读写，
 * 坏数值按 0 处理，没有输入时命中率为 null 而不是 0%，只截断展示轮次不截断累计；
 * 真实 Session 读取跳过未上报步骤与分支继承事件。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { summarizeCacheUsage } from '../src/core/cacheUsage.js'
import { sessionCacheUsage } from '../src/node/requestDiagnostics.js'

describe('summarizeCacheUsage', () => {
  it('同轮多个工具步骤合计，命中率 = 缓存读 / (未缓存 + 缓存读 + 缓存写)', () => {
    const summary = summarizeCacheUsage([
      { turn: 1, inputTokens: 9000, outputTokens: 300 },
      { turn: 2, inputTokens: 500, cacheReadTokens: 9000, outputTokens: 50 },
      { turn: 2, inputTokens: 100, cacheReadTokens: 9400, cacheWriteTokens: 0, outputTokens: 800 },
    ])
    expect(summary.turns.map(turn => [turn.turn, turn.steps])).toEqual([[1, 1], [2, 2]])
    expect(summary.turns[0]!.hitRate).toBe(0)
    expect(summary.turns[1]).toMatchObject({ uncachedInput: 600, cacheRead: 18400, output: 850 })
    expect(summary.turns[1]!.hitRate).toBeCloseTo(18400 / 19000)
    expect(summary.total.hitRate).toBeCloseTo(18400 / 28000)
  })

  it('缓存写计入分母；坏数值按 0，不污染合计', () => {
    const summary = summarizeCacheUsage([
      { turn: 3, inputTokens: Number.NaN, cacheReadTokens: 100, cacheWriteTokens: 100, outputTokens: -5 },
    ])
    expect(summary.total).toMatchObject({ uncachedInput: 0, cacheRead: 100, cacheWrite: 100, output: 0 })
    expect(summary.total.hitRate).toBe(0.5)
  })

  it('没有输入时命中率为 null，而不是 0%', () => {
    expect(summarizeCacheUsage([]).total.hitRate).toBeNull()
    expect(summarizeCacheUsage([{ turn: 1, inputTokens: 0, outputTokens: 0 }]).turns[0]!.hitRate).toBeNull()
  })

  it('只保留最近 limit 轮展示，累计仍包含全部步骤', () => {
    const steps = [5, 1, 3, 2, 4].map(turn => ({ turn, inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 }))
    const summary = summarizeCacheUsage(steps, 2)
    expect(summary.turns.map(turn => turn.turn)).toEqual([4, 5])
    expect(summary.total.steps).toBe(5)
  })

  it.each([0, -1, 0.9, NaN])('限制为 %s 时隐藏轮次而保留累计', limit => {
    const result = summarizeCacheUsage([{ turn: 1, inputTokens: 10, outputTokens: 2 }], limit)
    expect(result.turns).toEqual([])
    expect(result.total).toMatchObject({ steps: 1, uncachedInput: 10, output: 2 })
  })
})

describe('sessionCacheUsage', () => {
  const answer = (text: string) => createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text }] })
  const factory = () => {
    const session = Session.create(SessionId('cache-usage'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, message: answer('父会话回复'), stream: [],
      usage: { inputTokens: 8000, outputTokens: 100 } }, { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    // 供应商未上报 usage 的步骤不计入，而不是按 0 命中拉低命中率。
    session.append('assistant/message', { turn: 2, step: 1, message: answer('无用量'), stream: [] }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 2 })
    session.append('assistant/message', { turn: 2, step: 2, message: answer('新回复'), stream: [],
      usage: { inputTokens: 400, outputTokens: 60, cacheReadTokens: 7600 } }, { surfaceOp: 'append' })
    return session
  }

  it('从真实 Session 的 assistant/message 读取宿主 usage，跳过未上报的步骤', () => {
    const summary = sessionCacheUsage(factory())
    expect(summary.turns.map(turn => [turn.turn, turn.steps])).toEqual([[1, 1], [2, 1]])
    expect(summary.turns[1]!.hitRate).toBeCloseTo(7600 / 8000)
  })

  it('分支继承的父会话事件已在父会话计费，不重复统计', () => {
    const session = factory()
    const inherited = session.snapshotEvents().findIndex(event => event.type === 'turn/start' && event.data.turn === 2)
    const summary = sessionCacheUsage({ snapshotEvents: () => session.snapshotEvents(), inheritedEventCount: inherited as Session['inheritedEventCount'] })
    expect(summary.turns.map(turn => turn.turn)).toEqual([2])
    expect(summary.total).toMatchObject({ steps: 1, uncachedInput: 400, cacheRead: 7600 })
  })
})
