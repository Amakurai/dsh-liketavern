/** 原生 PTC 集成：真实宿主注册表/worker/Session 与临时剧情文件，验证呈现隔离、并行读、写屏障和 WAL 回滚。 */
import { mkdir, mkdtemp, rm, readFile, rename, symlink, writeFile } from 'node:fs/promises'
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
import { TURN_PLAYBOOK, TURN_STEP_NOTICE_PREFIX, TURN_WRITE_ACK_PREFIX } from '../src/core/dshPrompt.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { assetOutputTokens } from '../src/core/assetRead.js'
import { defaultPreset } from '../src/core/assemble.js'
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
  new LocalFileSystem(ctx, LocalFileSystem.Config({}))
  new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  // 仅执行本文件手写程序，不运行第三方脚本；测试使用真实 Node PTC 子进程。
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
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

it('资产工具拒绝链接目录指向剧情外的文本，目录也不广告链接', async () => {
  const ws = await workspace()
  const privateDir = join(root, 'private')
  await mkdir(privateDir)
  await writeFile(join(privateDir, 'secret.md'), '剧情外的私有文本')
  await mkdir(join(ws.fs.root, 'memory'), { recursive: true })
  await symlink(privateDir, join(ws.fs.root, 'memory', 'linked.md'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await run(`
    const file = await tools.tavern_asset_read({path:'memory/linked.md/secret.md'});
    const catalog = await tools.tavern_asset_list({});
    return {file, files:catalog.files};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { file: { ok: false, error: '资产路径不能经过链接' } } })
  expect(JSON.stringify(result.value)).not.toContain('剧情外的私有文本')
  expect(JSON.stringify(result.value)).not.toContain('memory/linked.md')
})

it('资产路径大小写变化仍读取绑定剧情，不能退回角色初始状态', async () => {
  const ws = await workspace(), assets = await state.workspace(cardId)
  const paths = ['JOURNAL.md', 'INDEX.json', 'MEMORY/case.md', 'STATE/case.json', 'ASSETS/CHAT-LOREBOOK.json']
  for (const path of paths) {
    await assets.fs.writeText(path, '角色初始状态')
    await ws.fs.writeText(path, '当前绑定剧情')
  }
  // 共享静态资产仍由角色目录提供，路由只改变剧情可变路径。
  await assets.fs.writeText('ASSETS/shared.json', '共享静态资产')
  const result = await run(`
    const paths = ${JSON.stringify(paths)};
    const files = await Promise.all(paths.map(path => tools.tavern_asset_read({path})));
    const shared = await tools.tavern_asset_read({path:'ASSETS/shared.json'});
    return {bodies:files.map(file => file.file.content), shared:shared.file.content};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { bodies: paths.map(() => '当前绑定剧情'), shared: '共享静态资产' } })
  expect(JSON.stringify(result.value)).not.toContain('角色初始状态')
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

it('世界状态拒绝无法解析的过期时间，合法 ISO 时间照常落盘', async () => {
  vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const result = await run(`
    const bad = await tools.tavern_worldstate_update({type:'add', content:'城门明天关闭', expiresAt:'明天傍晚'});
    const good = await tools.tavern_worldstate_update({type:'add', content:'集市今日开放', expiresAt:'2999-01-01T00:00:00.000Z'});
    return {bad, good};
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { bad: { ok: false }, good: { ok: true } } })
  expect(JSON.stringify(result.value)).toContain('invalid-args')
  const deltas = await (await workspace()).deltas.list()
  expect(deltas.map(delta => [delta.content, delta.expires])).toEqual([['集市今日开放', '2999-01-01T00:00:00.000Z']])
})

it('世界状态拒绝被 Date.parse 宽松解析成旧年份的写法与已过去的时间，避免写入即过期、静默不可见', async () => {
  vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const result = await run(`
    const out = [];
    for (const expiresAt of ['3', 'day 3', 'June 5', '2001-01-01']) out.push(await tools.tavern_worldstate_update({type:'add', content:expiresAt, expiresAt}));
    out.push(await tools.tavern_worldstate_update({type:'add', content:'日期形态', expiresAt:'2999-06-05'}));
    return out;
  `)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const out = (result.value as { result: Array<{ ok: boolean; error?: string }> }).result
  expect(out.map(item => item.ok)).toEqual([false, false, false, false, true])
  expect(out[3]!.error).toContain('已经过去')
  const deltas = await (await workspace()).deltas.list({ includeRevoked: true })
  expect(deltas.map(delta => delta.content)).toEqual(['日期形态'])
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

it('相似记忆拒绝只返回有界正文预览，保留完整定位与原剧情事实', async () => {
  const ws = await workspace()
  const body = '北门钥匙由守卫保管。'.repeat(1000)
  const entry = await ws.memory.write({ body, keys: ['北门钥匙'] })
  const result = await run("return await tools.tavern_memory_write({body:'北门钥匙由守卫保管',keys:['北门钥匙']});")
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { ok: boolean; status: string; similarId: string;
    similarBody: string; similarBodyTruncated: boolean; tokensUsed: number } }).result
  expect(output).toMatchObject({ ok: false, status: 'similar-found', similarId: entry.id })
  expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
  expect(output.tokensUsed).toBe(assetOutputTokens(output))
  expect(output.similarBodyTruncated).toBe(true)
  expect(output.similarBody).toContain('已截断')
  expect(await ws.memory.list()).toHaveLength(1)
  expect((await ws.memory.get(entry.id))?.body).toBe(body)
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

it('资产索引只返回实际可读条目与规范摘要，任意附带私有 JSON 不能随目录泄漏', async () => {
  const ws = await workspace()
  await ws.fs.writeText('journal.md', '旅人走到了港口')
  await ws.fs.writeText('index.json', JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', privateNote: '内部私有字段', files: [
    { path: 'journal.md', summary: '港口见闻', tokens: 8, privateSnapshot: '条目私有字段' },
    { path: 'state/wal/private.json', summary: 'WAL 私有摘要', tokens: 1 },
    { path: 'stories/sibling/journal.md', summary: '兄弟剧情私有摘要', tokens: 1 },
    { path: 'missing.md', summary: '不存在的条目', tokens: 1 },
    { path: 'card.png', summary: '二进制条目', tokens: 1 },
  ] }))
  const result = await run('return await tools.tavern_asset_list({});')
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { index: { files: Array<{ path: string; summary: string; tokens: number }>; count: number; omitted: number; truncated: boolean } } }).result
  expect(output.index.files).toEqual([{ path: 'journal.md', summary: '港口见闻', tokens: 8, truncated: false }])
  expect(output.index).toMatchObject({ count: 5, omitted: 4, truncated: true })
  expect(JSON.stringify(output)).not.toMatch(/私有字段|私有摘要|不存在的条目|二进制条目/)
})

it('资产文件与预设目录共同受 token/条数预算约束，定位字段不截断为假路径或假 identifier', async () => {
  const ws = await workspace(), preset = defaultPreset()
  const paths = Array.from({ length: 240 }, (_, i) => `state/catalog/${'nested-'.repeat(12)}/${String(i).padStart(3, '0')}-${'file-'.repeat(12)}.md`)
  await Promise.all(paths.map(path => ws.fs.writeText(path, '目录工厂正文')))
  await ws.fs.writeText('index.json', JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', files: paths.map(path => ({ path, summary: '巨大摘要'.repeat(100), tokens: 8 })) }))
  preset.identifier = 'catalog-budget-factory'; preset.name = '巨大预设名'.repeat(2000)
  const entry = preset.entries[0]!
  const hugeIdentifier = '不可裁剪定位'.repeat(80)
  preset.entries = [{ ...entry, identifier: 'anchor', name: '可读取锚点', content: '锚点正文' },
    { ...entry, identifier: hugeIdentifier, name: '超长定位字段', content: '不可广告的条目' },
    ...Array.from({ length: 260 }, (_, i) => ({ ...entry, identifier: `entry-${i}`, name: '巨大条目名'.repeat(500), content: '有界预览' }))]
  const presetId = await state.savePreset(preset)
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId })
  const result = await run(`const list = await tools.tavern_asset_list({}); const catalog = await tools.tavern_asset_read({preset:'list'}); const anchor = await tools.tavern_asset_read({preset:'anchor'}); return {list,catalog,anchor};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { list: { files: string[]; fileCount: number; filesOmitted: number; filesTruncated: boolean; tokensUsed: number; index: { files: unknown[] }; preset: { entries: Array<{ identifier: string }>; omitted: number; count: number; truncated: boolean } }; catalog: { preset: { entries: Array<{ identifier: string }>; omitted: number; count: number; truncated: boolean } }; anchor: { preset: { content: string } } } }).result
  expect(estimateTokens(JSON.stringify(output.list, null, 2))).toBeLessThanOrEqual(3000)
  expect(estimateTokens(JSON.stringify(output.catalog, null, 2))).toBeLessThanOrEqual(3000)
  expect(output.list.files.length).toBeLessThanOrEqual(200)
  expect(output.list.filesOmitted).toBe(output.list.fileCount - output.list.files.length)
  expect(output.list.filesTruncated).toBe(true)
  for (const path of output.list.files) expect((await ws.fs.exists(path)) || path.startsWith('assets/') || path === 'card.json').toBe(true)
  for (const catalog of [output.list.preset, output.catalog.preset]) {
    expect(catalog.entries.length).toBeLessThanOrEqual(200)
    expect(catalog).toMatchObject({ count: preset.entries.length, omitted: preset.entries.length - catalog.entries.length, truncated: true })
    expect(catalog.entries.every(item => preset.entries.some(entry => entry.identifier === item.identifier))).toBe(true)
  }
  expect(output.anchor.preset.content).toBe('锚点正文')
})

it('同时读取预设与文件也遵守完整 JSON 预算，超长元数据与转义正文不会挤爆工具输出', async () => {
  const ws = await workspace(), preset = defaultPreset()
  preset.identifier = 'content-budget-factory'; preset.name = '巨大预设名称'.repeat(2000)
  preset.entries = [{ ...preset.entries[0]!, identifier: 'body', name: '巨大条目名称'.repeat(2000), markerId: '巨大标记定位'.repeat(2000), content: '\u0000'.repeat(20000) }]
  const presetId = await state.savePreset(preset)
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId })
  await ws.fs.writeText('journal.md', '当前港口剧情'.repeat(2000))
  const result = await run(`return await tools.tavern_asset_read({preset:'body',path:'journal.md'});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { ok: boolean; tokensUsed: number; truncated: boolean; preset: { identifier: string; truncated: boolean; content: string; metadataTruncated: boolean; markerIdOmitted: boolean }; file: { path: string; truncated: boolean; content: string } } }).result
  expect(output.ok).toBe(true)
  expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(3000)
  expect(output).toMatchObject({ truncated: true, preset: { identifier: 'body', truncated: true, metadataTruncated: true, markerIdOmitted: true }, file: { path: 'journal.md', truncated: true } })
  expect(output.preset.content.length).toBeGreaterThan(0)
  expect(output.file.content.length).toBeGreaterThan(0)
})

it('资产定位参数超长时返回有界拒绝，not-found 错误也不能原样回显巨型输入', async () => {
  const result = await run(`return await Promise.all([
    tools.tavern_asset_read({preset:'未知预设'.repeat(10000)}),
    tools.tavern_asset_read({path:'state/'+'很长路径'.repeat(10000)+'.json'})
  ]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const outputs = (result.value as { result: Array<{ ok: boolean; error: string }> }).result
  for (const output of outputs) {
    expect(output.ok).toBe(false)
    expect(output.error).toContain('asset-output-too-large')
    expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(3000)
  }
})

it('定位字段接近 3000 token 时未知目标的错误包装仍有界，合法定位前后空白不改变读取', async () => {
  const path = `state/${Array.from({ length: 15 }, (_, i) => '字'.repeat(i === 14 ? 190 : 200)).join('/')}.md`
  const result = await run(`const errors = await Promise.all([
    tools.tavern_asset_read({preset:'字'.repeat(2990)}),
    tools.tavern_asset_read({path:${JSON.stringify(path)}})
  ]); const entry = await tools.tavern_asset_read({preset:' '.repeat(10000)+'main'+' '.repeat(10000)}); return {errors,entry};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { errors: Array<{ ok: boolean; error: string }>; entry: { ok: boolean; preset: { identifier: string } } } }).result
  for (const error of output.errors) {
    expect(error.ok).toBe(false)
    expect(estimateTokens(JSON.stringify(error, null, 2))).toBeLessThanOrEqual(3000)
  }
  expect(output.entry).toMatchObject({ ok: true, preset: { identifier: 'main' } })
})

it('完整预算容纳的长 identifier、markerId 与嵌套路径仍可在目录发现并实际读取', async () => {
  const ws = await workspace(), preset = defaultPreset()
  const identifier = '合法定位'.repeat(100), markerId = '长标记'.repeat(100)
  const path = `state/${'目录'.repeat(80)}/${'目录'.repeat(80)}/${'笔记'.repeat(50)}.md`
  await ws.fs.writeText(path, '长路径中的港口记录')
  preset.identifier = 'long-locator-factory'; preset.entries = [{ ...preset.entries[0]!, identifier, markerId, content: '长定位条目的正文' }]
  const presetId = await state.savePreset(preset)
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId })
  const result = await run(`const list = await tools.tavern_asset_list({}); const catalog = await tools.tavern_asset_read({preset:'list'}); const entry = await tools.tavern_asset_read({preset:${JSON.stringify(identifier)}}); const file = await tools.tavern_asset_read({path:${JSON.stringify(path)}}); return {list,catalog,entry,file};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { list: { files: string[]; preset: { entries: Array<{ identifier: string; markerId: string }> } }; catalog: { preset: { entries: Array<{ identifier: string; markerId: string }> } }; entry: { ok: boolean; preset: { identifier: string; markerId: string; content: string } }; file: { ok: boolean; file: { path: string; content: string } } } }).result
  expect(output.entry).toMatchObject({ ok: true, preset: { identifier, markerId, content: '长定位条目的正文' } })
  expect(output.file).toMatchObject({ ok: true, file: { path, content: '长路径中的港口记录' } })
  expect(output.list.files).toContain(path)
  for (const catalog of [output.list.preset, output.catalog.preset]) expect(catalog.entries).toContainEqual(expect.objectContaining({ identifier, markerId }))
  for (const value of Object.values(output)) expect(estimateTokens(JSON.stringify(value, null, 2))).toBeLessThanOrEqual(3000)
})

it('资产索引文件链接不能把工作区外的规范摘要读取给模型', async () => {
  const ws = await workspace(), external = join(root, 'external-index-source'), backup = join(root, 'original-story')
  await mkdir(external)
  await writeFile(join(external, 'journal.md'), '工作区外的文本')
  await writeFile(join(external, 'index.json'), JSON.stringify({ files: [{ path: 'journal.md', summary: '工作区外的私有摘要', tokens: 1 }], updatedAt: '2026-01-01T00:00:00.000Z' }))
  // Windows 文件 symlink 需要管理员权限；真实 junction 在剧情归属已复核、实际读取前
  // 替换父目录，模拟文件系统变化窗口。仅钩住这个窗口，其余绑定、工作区与 PTC 均为真实实现。
  const original = state.storyWorkspace.bind(state)
  vi.spyOn(state, 'storyWorkspace').mockImplementationOnce(async (...args) => {
    const handle = await original(...args)
    await rename(handle.fs.root, backup)
    await symlink(external, handle.fs.root, process.platform === 'win32' ? 'junction' : 'dir')
    return handle
  })
  try {
    const result = await run('return await tools.tavern_asset_list({});')
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toMatchObject({ result: { ok: false, error: '资产索引路径不能经过链接' } })
    expect(JSON.stringify(result.value)).not.toContain('工作区外的私有摘要')
  } finally {
    await rm(ws.fs.root, { recursive: true, force: true })
    await rename(backup, ws.fs.root)
  }
})
