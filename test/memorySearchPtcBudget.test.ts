/** 记忆检索预算的原生 PTC 集成：真实临时剧情/WAL、宿主注册表和 worker，验证合法元数据不能绕过完整 JSON 预算。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as presentation from '@deepseek-ai/dsh-agent-tool-presentation'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { parse } from 'yaml'
import { apply as applyAgent } from '../src/agent.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { estimateTokens } from '../src/core/tokenize.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, cardId: string, storyId: string
let budget = 1200, call = 0
const workspace = () => state.storyWorkspace(cardId, storyId)
const run = (code: string) => ctx.tools.execute({ agent, callId: ToolCallId(`memory-budget-${++call}`), name: 'run_code',
  arguments: { code, description: '验证记忆检索 JSON 预算' }, signal: new AbortController().signal })

beforeEach(async () => {
  budget = 1200
  root = await mkdtemp(join(tmpdir(), 'tavern-memory-budget-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({ memory: { retrievalTokenBudget: budget } }))
  await state.init()
  cardId = (await state.createCharacter('记忆预算工厂角色')).cardId
  await state.saveBinding({ sessionId: 'memory-budget-story', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('memory-budget-story'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('memory-budget-story'))
  ctx.provide('tavern', { state }); applyAgent(agent.ctx)
  const rows = parse(await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8'))
  agent.ctx.plugin(presentation, rows.find((row: { id: string }) => row.id === 'tool-presentation').config)
  await vi.waitFor(() => expect(ctx.tools.modeFor(agent)).toBe('ptc'))
  state.currentTurns.set(agent.id, 1); state.currentSteps.set(agent.id, 1)
  const ws = await workspace(), floor = `${agent.id}#t1`
  await ws.wal.beginFloor(floor); state.openFloors.set(agent.id, { cardId, storyId, floor })
})

afterEach(async () => {
  await ctx?.fiber.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
})

it('合法 5000 字标签仍可保存，检索完整响应有界且 tokensUsed 如实计算 JSON', async () => {
  const result = await run(`await tools.tavern_memory_write({body:'北门钥匙由守卫保管',keys:['北门钥匙'],tags:['界'.repeat(5000)]}); return await tools.tavern_memory_search({query:'北门钥匙'});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { ok: boolean; tokensUsed: number; results: Array<{ tags: string[]; metadataTruncated: boolean; tagsTruncated: boolean; body: string }> } }).result
  expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(1200)
  expect(output.tokensUsed).toBe(estimateTokens(JSON.stringify(output, null, 2)))
  expect(output).toMatchObject({ ok: true, results: [{ metadataTruncated: true, tagsTruncated: true, body: '北门钥匙由守卫保管' }] })
  expect((await (await workspace()).memory.list())[0]!.tags).toEqual(['界'.repeat(5000)])
})

it('耗尽预算后省略整条命中，长来源明确省略而转义标签不膨胀输出', async () => {
  const ws = await workspace()
  for (let i = 0; i < 20; i++) await ws.memory.write({ body: `北门钥匙记录 ${i} ${'灯塔'.repeat(1000)}`, keys: ['北门钥匙'], tags: ['\u0000'.repeat(5000)], sourceRange: '来源楼层'.repeat(2000) })
  const result = await run(`return await tools.tavern_memory_search({query:'北门钥匙',topK:20});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { count: number; omitted: number; tokensUsed: number; results: Array<{ sourceRange?: string; sourceRangeOmitted?: boolean }> } }).result
  expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(1200)
  expect(output.count).toBe(20)
  expect(output.omitted).toBe(20 - output.results.length)
  expect(output.omitted).toBeGreaterThan(0)
  expect(output.results[0]).toMatchObject({ sourceRangeOmitted: true })
  expect(output.results[0]?.sourceRange).toBeUndefined()
})

it('正常短元数据与完整定位保留，零预算明确业务拒绝而不继续灌入命中', async () => {
  const ws = await workspace(), entry = await ws.memory.write({ body: '北门钥匙已经归还', keys: ['北门钥匙'], tags: ['事实'], sourceRange: 't17' })
  const normal = await run(`return await tools.tavern_memory_search({query:'北门钥匙'});`)
  expect(normal.isError, JSON.stringify(normal.content)).toBe(false)
  expect(normal.value).toMatchObject({ result: { ok: true, results: [{ id: entry.id, path: `memory/${entry.id}.md`, archived: false, sourceRange: 't17', tags: ['事实'], keys: ['北门钥匙'], body: '北门钥匙已经归还' }] } })
  budget = 0
  const denied = await run(`return await tools.tavern_memory_search({query:'北门钥匙'});`)
  expect(denied.isError, JSON.stringify(denied.content)).toBe(false)
  expect(denied.value).toMatchObject({ result: { ok: false, error: expect.stringContaining('memory-budget-too-small') } })
  expect(JSON.stringify(denied.value)).not.toContain('北门钥匙已经归还')
})
