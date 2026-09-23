/** 原生 PTC 集成：真实宿主注册表/worker/Session 与临时剧情文件，验证呈现隔离、并行读、写屏障和 WAL 回滚。 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import * as presentation from '@deepseek-ai/dsh-agent-tool-presentation'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { parse } from 'yaml'
import { apply as applyAgent } from '../src/agent.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { TURN_PLAYBOOK, TURN_STEP_NOTICE_PREFIX, TURN_WRITE_ACK_PREFIX } from '../src/core/dshPrompt.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, native: Agent, cardId: string, storyId: string
let call = 0
const signal = () => new AbortController().signal
const workspace = () => state.storyWorkspace(cardId, storyId)
const run = (code: string) => ctx.tools.execute({ agent, callId: ToolCallId(`ptc-${++call}`),
  name: 'run_code', arguments: { code, description: '验证 Tavern 工具组合' }, signal: signal() })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-ptc-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => resolveConfig({ memory: { dedupScore: 0.1 } }))
  await state.init()
  cardId = (await state.createCharacter('PTC 工厂角色')).cardId
  await state.saveBinding({ sessionId: 'ptc-story', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('ptc-story'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new WorkerThreadCodeRuntime(ctx, { computeMs: 5000, maxWallMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 })
  const loop = new AgentLoop(ctx, { agents: [] })
  agent = await loop.create(SessionId('ptc-story')); native = await loop.create(SessionId('native-story'))
  ctx.provide('tavern', { state })
  applyAgent(agent.ctx)
  // 用真实 YAML 配置驱动官方 selector，避免测试手动设 ptc 掩盖漏挂载。
  const rows = parse(await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8'))
  const row = rows.find((item: { id: string }) => item.id === 'tool-presentation')
  expect(row.name).toBe('@deepseek-ai/dsh-agent-tool-presentation')
  agent.ctx.plugin(presentation, row.config)
  await vi.waitFor(() => expect(ctx.tools.modeFor(agent)).toBe('ptc'))
  state.currentTurns.set(agent.id, 1); state.currentSteps.set(agent.id, 1)
  const ws = await workspace(), floor = `${agent.id}#t1`
  await ws.wal.beginFloor(floor)
  state.openFloors.set(agent.id, { cardId, storyId, floor })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('只暴露 run_code 与结构化 SDK；普通模式不受影响，原生直呼不能绕过 PTC', async () => {
  const assembled = await ctx.systemPrompt.assemble({ scope: agent })
  expect(assembled.tools.map(tool => tool.name)).toEqual(['run_code'])
  const sdk = assembled.sections.find(section => section.name === 'tools:sdk')!.text
  expect(sdk).toContain('tavern_memory_search:')
  expect(sdk).toContain('similarId?: string')
  expect(sdk).toContain('body: string')
  expect(assembled.sections.findIndex(section => section.name === 'tavern:standing'))
    .toBeGreaterThan(assembled.sections.findIndex(section => section.name === 'tools:sdk'))
  expect((await ctx.systemPrompt.assemble({ scope: agent })).sections).toEqual(assembled.sections)
  expect(ctx.tools.modeFor(native)).toBe('native')
  expect((await ctx.systemPrompt.assemble({ scope: native })).tools).toEqual([])
  const denied = await ctx.tools.execute({ agent, callId: ToolCallId('direct'), name: 'tavern_asset_list', arguments: {}, signal: signal() })
  expect(denied.isError).toBe(true)
  expect(denied.error?.info?.code).toBe('UNKNOWN_TOOL')
})

it('一次程序完成并行读取并裁剪结果；多子调用只发一条步骤 notice', async () => {
  const ws = await workspace()
  await ws.fs.writeText('journal.md', '只返回这条工厂剧情事实')
  await ws.memory.write({ body: '钥匙藏在北门', keys: ['钥匙'] })
  // 两个 readText 同时到达屏障才能放行，串行执行会超时；不靠毫秒阈值判断加速。
  const original = WorkspaceFs.prototype.readText
  let arrived = 0
  const ready = Promise.withResolvers<void>()
  vi.spyOn(WorkspaceFs.prototype, 'readText').mockImplementation(async function (this: WorkspaceFs, path) {
    if (this.root === ws.fs.root && path === 'journal.md') { if (++arrived === 2) ready.resolve(); await ready.promise }
    return original.call(this, path)
  })
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const result = await run(`
    const reads = await Promise.all([tools.tavern_asset_read({path:'journal.md'}), tools.tavern_asset_read({path:'journal.md'})]);
    const memory = await tools.tavern_memory_search({query:'钥匙'});
    const lore = await tools.tavern_lore_read({query:'北门'});
    return {facts: reads.map(x => x.file.content), memory: memory.results.map(x => x.body), lore: lore.entries};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(arrived).toBe(2)
  expect(JSON.stringify(result.value)).toContain('钥匙藏在北门')
  expect(JSON.stringify(result.value)).not.toContain('tokensUsed')
  const notices = inject.mock.calls.map(([message]) => JSON.stringify(message))
  expect(notices.filter(text => text.includes(TURN_STEP_NOTICE_PREFIX))).toHaveLength(1)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(4)
})

it('读写混排保持独占顺序，结果可直接引用；同层回滚撤销全部派生事实', async () => {
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const result = await run(`
    const first = await tools.tavern_memory_write({body:'北门钥匙由守卫保管', keys:['北门钥匙']});
    const batch = await Promise.all([
      tools.tavern_memory_update({id:first.id, body:'北门钥匙交给旅人'}),
      tools.tavern_worldstate_update({type:'add', content:'北门已经打开', keys:['北门']}),
      tools.tavern_memory_search({query:'北门钥匙'})
    ]);
    const assets = await tools.tavern_asset_list({});
    const text = await tools.tavern_asset_read({preset:'list'});
    const entry = await tools.tavern_asset_read({preset:text.preset.entries[0].identifier});
    const lore = await tools.tavern_lore_read({query:'北门'});
    return {first, batch, count: assets.memory.count, preset: entry.preset.mode, lore: lore.entries};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.value)).toContain('北门钥匙交给旅人')
  expect(JSON.stringify(result.value)).toContain('"count":1')
  expect(JSON.stringify(result.value)).toContain('北门已经打开')
  const ws = await workspace(), floor = state.openFloors.get(agent.id)!.floor
  expect(await ws.memory.stats()).toMatchObject({ count: 1 })
  expect(await ws.deltas.list()).toHaveLength(1)
  const deltaText = (await ws.fs.readText('state/world-delta.jsonl'))!
  const index = JSON.parse((await ws.fs.readText('index.json'))!) as { files: Array<{ path: string; tokens: number }> }
  expect(index.files.find(file => file.path === 'state/world-delta.jsonl')?.tokens).toBe(estimateTokens(deltaText))
  expect(ws.fs.currentFloor).toBeNull()
  await ws.wal.commitFloor(floor)
  await ws.wal.rollbackFloor(floor, ws.fs.root)
  expect(await ws.memory.stats()).toMatchObject({ count: 0 })
  expect(await ws.deltas.list()).toHaveLength(0)
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toHaveLength(3)
})

it('成功写入后返回缺失字段会令外层 invalid-output，但保留单条记忆、写入确认及楼层回滚', async () => {
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const result = await run(`
    const r = await tools.tavern_memory_write({body:'工厂旅人把蓝色钥匙交给守卫', keys:['蓝色钥匙']});
    return {ok:r.ok, id:r.id, error:r.error};
  `)
  expect(result.isError).toBe(true)
  expect(result.error?.info?.code).toBe('CODE_RUN_FAILED')
  expect(JSON.stringify(result.content)).toContain('invalid-output')
  expect(JSON.stringify(result.content)).toContain('program completion must be lossless JSON')
  const ws = await workspace(), floor = state.openFloors.get(agent.id)!.floor
  const entries = await ws.memory.list()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.body).toBe('工厂旅人把蓝色钥匙交给守卫')
  const dispatches = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
  expect(dispatches).toHaveLength(1)
  expect(dispatches[0]!.data).toMatchObject({ name: 'tavern_memory_write', isError: false })
  const notices = inject.mock.calls.map(([message]) => JSON.stringify(message))
    .filter(text => text.includes(TURN_WRITE_ACK_PREFIX))
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(entries[0]!.id)
  expect(notices[0]).toContain('已落盘')
  expect(ws.fs.currentFloor).toBeNull()
  await ws.wal.commitFloor(floor)
  await ws.wal.rollbackFloor(floor, ws.fs.root)
  expect(await ws.memory.list()).toHaveLength(0)
})

it.each([
  { label: '原样返回', output: 'return r;', normalized: false },
  { label: '提示词中的缺失字段置 null 示例', output: TURN_PLAYBOOK.match(/例如 (return \{[^\n]+?\};)/)?.[1], normalized: true },
])('$label 在成功与业务拒绝时均合法，并保留 error 和 hint', async ({ output, normalized }) => {
  expect(output, '提示词必须包含可执行的安全返回示例').toBeTruthy()
  const write = `const r = await tools.tavern_memory_write({body:'工厂旅人借走灯塔的铜铃', keys:['灯塔铜铃']}); ${output}`
  const success = await run(write)
  expect(success.isError, JSON.stringify(success.content)).toBe(false)
  const ws = await workspace(), entries = await ws.memory.list()
  expect(entries).toHaveLength(1)
  expect(success.value).toMatchObject({ result: {
    ok: true, id: entries[0]!.id,
    ...(normalized ? { error: null, hint: null, status: null, similarId: null } : {}),
  } })

  const duplicate = await run(write)
  expect(duplicate.isError, JSON.stringify(duplicate.content)).toBe(false)
  expect(duplicate.value).toMatchObject({ result: {
    ok: false, status: 'similar-found', similarId: entries[0]!.id, hint: expect.stringContaining('tavern_memory_update'),
    ...(normalized ? { id: null, error: null } : {}),
  } })

  state.openFloors.delete(agent.id)
  const denied = await run(write)
  expect(denied.isError, JSON.stringify(denied.content)).toBe(false)
  expect(denied.value).toMatchObject({ result: {
    ok: false, error: expect.stringContaining('floor-not-open'),
    ...(normalized ? { id: null, hint: null, status: null, similarId: null } : {}),
  } })
  expect(await ws.memory.list()).toEqual(entries)
})

it('程序内业务拒绝可检查，路径越界与未开楼层都不能写入剧情', async () => {
  state.openFloors.delete(agent.id)
  const result = await run(`return await Promise.all([
    tools.tavern_memory_write({body:'不允许落盘'}),
    tools.tavern_asset_read({path:'../secret'}),
    tools.tavern_worldstate_update({type:'add',content:'不允许落盘'})
  ]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(JSON.stringify(result.value)).toContain('floor-not-open')
  expect(result.value).toMatchObject({ result: [
    { ok: false, error: expect.stringContaining('floor-not-open') },
    { ok: false, error: '路径不合法' },
    { ok: false, error: expect.stringContaining('floor-not-open') },
  ] })
  expect(await (await workspace()).memory.stats()).toMatchObject({ count: 0 })
  expect(await (await workspace()).deltas.list()).toHaveLength(0)
})

it('相似记忆拒绝后在同一程序内按 id 更新；宿主参数错误可捕获且不会冒充成功', async () => {
  const result = await run(`
    const args = {body:'旅人答应守卫归还北门钥匙', keys:['北门钥匙']};
    const first = await tools.tavern_memory_write(args);
    const repeated = await tools.tavern_memory_write(args);
    if (!repeated.ok && repeated.status === 'similar-found') {
      await tools.tavern_memory_update({id:repeated.similarId, body:'旅人已经归还北门钥匙'});
    }
    let invalid = '';
    try { await tools.tavern_memory_write({}); } catch (e) { invalid = e.toolName; }
    return {first:first.id, duplicate:repeated.similarId, invalid};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { first: expect.any(String), duplicate: expect.any(String), invalid: 'tavern_memory_write' } })
  const entries = await (await workspace()).memory.list()
  expect(entries).toHaveLength(1)
  expect(entries[0]!.body).toBe('旅人已经归还北门钥匙')
})
