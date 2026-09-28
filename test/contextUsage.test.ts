/**
 * 上下文用量：按宿主 token-meter 投影的真实状态形状读取。
 * contextBreakdown 状态是 { nodes, breakdown: {...} }（0.1.5 与 0.1.7 相同）；此前按扁平对象读取，
 * 面板里 system/tools/messages 三项恒为空。投影缺席或形状不完整时返回 null，不编造数字。
 */
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TavernService, type TavernSettingsScope } from '../src/node/service.js'
import type { TavernState } from '../src/node/state.js'

function service(states: Record<string, unknown> | undefined) {
  const session = { id: 'session' }
  const ctx = {
    reflect: { provide: () => {} },
    sessions: { get: (id: string) => id === 'session' ? session : undefined },
    get: (name: string) => name === 'sessionProjections' && states
      ? { stateOf: (subject: unknown, key: string) => subject === session ? states[key] : undefined }
      : undefined,
  } as unknown as Context
  return new TavernService(ctx, {} as TavernState, { get: () => ({}) } as unknown as TavernSettingsScope)
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
