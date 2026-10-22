/**
 * 上下文用量：按宿主 token-meter 投影的真实状态形状读取。
 * contextBreakdown 状态是 { nodes, breakdown: {...} }（0.1.5 与 0.1.7 相同）；此前按扁平对象读取，
 * 面板里 system/tools/messages 三项恒为空。投影缺席或形状不完整时返回 null，不编造数字。
 */
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TavernService, type TavernSettingsScope } from '../src/node/service.js'
import type { TavernState } from '../src/node/state.js'

function service(states: Record<string, unknown> | undefined, options: { provider?: string; presetAdapter?: boolean; events?: unknown[] } = {}) {
  // 模型可见面：events 按 seq（下标 + 1）排列，全部在 surface 上。
  const events = options.events ?? []
  const session = { id: 'session', surface: { nodes: events.map((_, index) => index + 1) }, eventAt: (seq: number) => events[seq - 1] }
  const agent = { options: { provider: options.provider ?? 'factory', model: 'm' }, session: {} }
  const ctx = {
    reflect: { provide: () => {} },
    sessions: { get: (id: string) => id === 'session' ? session : undefined },
    agents: { get: (id: string) => id === 'session' ? agent : undefined },
    get: (name: string) => name === 'sessionProjections' && states
      ? { stateOf: (subject: unknown, key: string) => subject === session ? states[key] : undefined }
      : undefined,
  } as unknown as Context
  const state = { presetAdapter: options.presetAdapter ? {} : undefined } as unknown as TavernState
  return new TavernService(ctx, state, { get: () => ({}) } as unknown as TavernSettingsScope)
}

it('按 token-meter 状态形状读取占用与构成', () => {
  const usage = service({
    contextPressure: { contextWindow: 128000, pressureTokens: 32000, surfaceTokens: 30000 },
    contextBreakdown: { nodes: [{ seq: 1, heuristicTokens: 900, system: true }],
      breakdown: { systemTokens: 9000, toolsTokens: 3000, messageTokens: 18000 } },
  }).getContextUsage({ sessionId: 'session' }).usage
  expect(usage).toEqual({ surfaceTokens: 30000, pressureTokens: 32000, contextWindow: 128000, percent: 25,
    systemTokens: 9000, toolsTokens: 3000, messageTokens: 18000 })
})

it('构成投影缺席时仍返回占用，三项构成为 null', () => {
  const usage = service({ contextPressure: { surfaceTokens: 500 } }).getContextUsage({ sessionId: 'session' }).usage
  expect(usage).toMatchObject({ surfaceTokens: 500, percent: null, systemTokens: null, toolsTokens: null, messageTokens: null })
})

it('没有投影服务或会话不在线时不编造数字', () => {
  expect(service(undefined).getContextUsage({ sessionId: 'session' }).usage).toBeNull()
  expect(service({}).getContextUsage({ sessionId: 'missing' }).usage).toBeNull()
})

const snapshot = (text: string) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'tavern:turn', text }, { name: 'other', text: '宿主其它上下文' }] } } })

it('报告最新快照之前的旧 tavern:turn 快照，并区分 DeepSeek 投影通道', () => {
  const events = [snapshot('第一轮世界书'), { type: 'assistant/message', data: {} }, snapshot('第二轮世界书'), snapshot('当前轮')]
  const plain = service(undefined, { events }).getContextUsage({ sessionId: 'session' })
  expect(plain.usage).toBeNull()
  expect(plain.staleTurnContext).toMatchObject({ snapshots: 2, projected: false })
  expect(plain.staleTurnContext!.tokens).toBeGreaterThan(0)
  const projected = service(undefined, { events, provider: 'deepseek-official', presetAdapter: true }).getContextUsage({ sessionId: 'session' })
  expect(projected.staleTurnContext).toMatchObject({ snapshots: 2, projected: true })
  // 没有预设适配器时即使是 deepseek-official 也不会剔除。
  expect(service(undefined, { events, provider: 'deepseek-official' }).getContextUsage({ sessionId: 'session' }).staleTurnContext?.projected).toBe(false)
})

it('会话历史不可读时不报告累积，也不影响占用读取', () => {
  const broken = service({ contextPressure: { surfaceTokens: 500 } }, { events: [snapshot('a'), snapshot('b')] })
  const live = (broken as unknown as { ctx: { sessions: { get: (id: string) => { eventAt: unknown } } } }).ctx.sessions.get('session')
  live.eventAt = () => { throw new Error('history unavailable') }
  const result = broken.getContextUsage({ sessionId: 'session' })
  expect(result.staleTurnContext).toBeNull()
  expect(result.usage).toMatchObject({ surfaceTokens: 500 })
})
