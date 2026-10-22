/**
 * 旧 tavern:turn 快照累积诊断。真实 AgentLoop / SystemPrompt / Session：每轮注册不同的
 * tavern:turn 文本连跑三轮，先验证宿主确实把旧快照留在历史并发给普通供应商（诊断的前提），
 * 再验证 measureStaleTurnContext 只统计最新快照之前的 tavern:turn 段。手写适配器，未调用模型。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateTokens } from '../src/core/tokenize.js'
import { measureStaleTurnContext } from '../src/node/turnContextDiagnostics.js'

const TURN_TEXTS = ['第一轮世界书：北门守卫换班。', '第二轮世界书：港口起雾，商船延误。', '第三轮世界书：钟楼敲响十二下。']
let ctx: Context, agent: Agent, turn = 0
const requests: string[] = []

beforeEach(async () => {
  turn = 0; requests.length = 0
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('stale-turn-context'))
  class FactoryAdapter extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(JSON.stringify(options.messages))
      yield { type: 'text-delta', index: 0, text: '回复' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  new LlmRuntime(ctx).registerAdapter(['factory'], new FactoryAdapter())
  ctx.systemPrompt.context({ name: 'tavern:turn', order: 20, interpolate: false, text: () => TURN_TEXTS[turn] ?? '' })
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'factory', model: 'factory' }))
})
afterEach(async () => { agent.cancel({ kind: 'disposed' }); await agent.whenIdle(); await ctx.fiber.dispose() })

it('普通供应商通道：旧 tavern:turn 快照留在历史并随请求发送，诊断只计最新快照之前的部分', async () => {
  for (turn = 0; turn < TURN_TEXTS.length; turn++) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `输入${turn}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  // 前提：第三轮请求里仍带着前两轮的快照正文。
  expect(requests).toHaveLength(3)
  for (const text of TURN_TEXTS) expect(requests[2]).toContain(text)

  const stale = measureStaleTurnContext(agent.session)
  expect(stale.snapshots).toBe(2)
  expect(stale.tokens).toBeGreaterThanOrEqual(estimateTokens(TURN_TEXTS[0]!) + estimateTokens(TURN_TEXTS[1]!))
  expect(stale.tokens).toBeLessThan(estimateTokens(TURN_TEXTS.join('')) + 1)
})

it('只有一份快照或没有快照时不报告累积', async () => {
  expect(measureStaleTurnContext(agent.session)).toEqual({ snapshots: 0, tokens: 0 })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '输入' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(measureStaleTurnContext(agent.session)).toEqual({ snapshots: 0, tokens: 0 })
})
