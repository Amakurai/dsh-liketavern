/** 写工具错误展示的真实 PTC 集成：巨型输入、JSON 转义与绑定拒绝有界，拒绝不写正文/WAL，合法大正文仍可保存。 */
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
let call = 0
const workspace = () => state.storyWorkspace(cardId, storyId)
const run = (code: string) => ctx.tools.execute({ agent, callId: ToolCallId(`tool-error-${++call}`), name: 'run_code',
  arguments: { code, description: '验证工具错误完整 JSON 预算' }, signal: new AbortController().signal })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-tool-error-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('错误预算工厂角色')).cardId
  await state.saveBinding({ sessionId: 'tool-error-story', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('tool-error-story'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('tool-error-story'))
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

it.each([{ label: '汉字', input: '界'.repeat(5000) }, { label: '控制字符与转义', input: '\u0000"\\\n'.repeat(4000) }])(
  '$label 的写工具错误回显必须有界并明确裁剪，拒绝不产生正文或 WAL', async ({ input }) => {
    const ws = await workspace(), index = await ws.fs.readText('index.json')
    const walSnapshot = async () => Promise.all((await ws.fs.list('state/wal')).map(async path => [path, await ws.fs.readText(`state/wal/${path}`)]))
    const wal = await walSnapshot()
    const result = await run(`return await Promise.all([
      tools.tavern_memory_update({id:${JSON.stringify(input)},body:'不能落盘'}),
      tools.tavern_worldstate_update({type:'add',content:'不能落盘',expiresAt:${JSON.stringify(input)}})
    ]);`)
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const output = (result.value as { result: Array<{ ok: boolean; error: string; errorTruncated: boolean; tokensUsed: number }> }).result
    for (const [i, item] of output.entries()) {
      const tokens = estimateTokens(JSON.stringify(item, null, 2))
      expect.soft(tokens, i === 0 ? '记忆更新错误 JSON' : '世界变化错误 JSON').toBeLessThanOrEqual(3000)
      if (tokens > 3000) continue
      expect(item).toMatchObject({ ok: false, errorTruncated: true })
      expect(item.error).toContain(i === 0 ? 'not-found' : 'invalid-args')
      expect(item.tokensUsed).toBe(estimateTokens(JSON.stringify(item, null, 2)))
    }
    expect(await ws.memory.list()).toEqual([])
    expect(await ws.deltas.list()).toEqual([])
    expect(await ws.fs.readText('index.json')).toBe(index)
    expect(await walSnapshot()).toEqual(wal)
  })

it('完整短定位与合法巨型正文、关键词保持可写，成功结果不伪造裁剪后的定位', async () => {
  const ws = await workspace(), entry = await ws.memory.write({ body: '原事实' })
  const body = '港口事实'.repeat(2000), keys = ['关键词'.repeat(2000)]
  const result = await run(`const memory = await tools.tavern_memory_update({id:${JSON.stringify(entry.id)},body:${JSON.stringify(body)},keys:${JSON.stringify(keys)}});
    const delta = await tools.tavern_worldstate_update({type:'add',content:${JSON.stringify(body)},keys:${JSON.stringify(keys)},expiresAt:'2999-01-01'}); return {memory,delta};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { memory: { ok: true, id: entry.id }, delta: { ok: true, id: expect.any(String) } } })
  expect(await ws.memory.get(entry.id)).toMatchObject({ body, keys })
  expect((await ws.deltas.list())[0]).toMatchObject({ content: body, keys })
})

it('合法长小数秒的过去时间错误有界，未来时间仍按原值完整保存', async () => {
  const fraction = '0'.repeat(20000), past = `2001-01-01T00:00:00.${fraction}Z`, future = `2999-01-01T00:00:00.${fraction}Z`
  expect(Date.parse(past)).toBe(Date.parse('2001-01-01T00:00:00.000Z'))
  expect(Date.parse(future)).toBe(Date.parse('2999-01-01T00:00:00.000Z'))
  const result = await run(`const past = await tools.tavern_worldstate_update({type:'add',content:'不能落盘',expiresAt:${JSON.stringify(past)}});
    const future = await tools.tavern_worldstate_update({type:'add',content:'未来有效事实',expiresAt:${JSON.stringify(future)}}); return {past,future};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { past: { ok: boolean; errorTruncated: boolean; tokensUsed: number }; future: { ok: boolean; id: string } } }).result
  expect(output.past).toMatchObject({ ok: false, errorTruncated: true })
  expect(estimateTokens(JSON.stringify(output.past, null, 2))).toBeLessThanOrEqual(3000)
  expect(output.future).toMatchObject({ ok: true, id: expect.any(String) })
  expect((await (await workspace()).deltas.list()).map(delta => [delta.content, delta.expires])).toEqual([['未来有效事实', future]])
})

it('通用写工具换绑拒绝不回显巨型角色名，固定错误仍返回原本的拒绝原因', async () => {
  const giantName = '巨大绑定名称'.repeat(2000), other = await state.createCharacter(giantName)
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, cardId: other.cardId, storyId: undefined })
  const result = await run(`return await Promise.all([
    tools.tavern_memory_write({body:'不能落盘'}), tools.tavern_memory_update({id:'missing',body:'不能落盘'}),
    tools.tavern_worldstate_update({type:'add',content:'不能落盘'})
  ]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: Array<{ ok: boolean; error: string }> }).result
  for (const item of output) {
    expect(item).toMatchObject({ ok: false, error: expect.stringContaining('binding-changed') })
    expect(estimateTokens(JSON.stringify(item, null, 2))).toBeLessThanOrEqual(3000)
    expect(item.error).not.toContain('巨大绑定名称')
  }
})
