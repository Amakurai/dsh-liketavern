/** 写工具的真实 PTC 回执边界：正文已保存后派生索引失败仍确认完整 id，避免程序重试重复事实，并保持楼层回滚。 */
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
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
import { TURN_WRITE_ACK_PREFIX } from '../src/core/dshPrompt.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { MemoryStore } from '../src/state/memory.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, cardId: string, storyId: string, config: ReturnType<typeof resolveConfig>
let call = 0
const workspace = () => state.storyWorkspace(cardId, storyId)
const run = (code: string) => ctx.tools.execute({ agent, callId: ToolCallId(`write-receipt-${++call}`), name: 'run_code',
  arguments: { code, description: '验证事实保存后的工具回执' }, signal: new AbortController().signal })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-write-receipt-'))
  config = resolveConfig({})
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => config)
  await state.init()
  cardId = (await state.createCharacter('写回执工厂角色')).cardId
  await state.saveBinding({ sessionId: 'write-receipt-story', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('write-receipt-story'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('write-receipt-story'))
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

it.each(['memory_write', 'memory_update', 'worldstate_update'] as const)(
  '%s 的事实已保存时索引故障仍返回完整成功回执，不引导重试，正文可回滚', async tool => {
    const ws = await workspace()
    const existing = tool === 'memory_update' ? await ws.memory.write({ body: '旧事实' }) : null
    const original = existing ? await ws.fs.readText(`memory/${existing.file}`) : null
    // 文件路径被真实目录占用，主文件仍可写；只让最后的派生 index.json 更新触发 EISDIR。
    const indexPath = join(ws.fs.root, 'index.json')
    await rm(indexPath); await mkdir(indexPath)
    const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
    const warn = vi.spyOn(agent.ctx.logger, 'warn').mockImplementation(() => undefined)
    const args = tool === 'worldstate_update' ? { type: 'add', content: '城门已打开' }
      : tool === 'memory_update' ? { id: existing!.id, body: '钥匙已交给旅人' } : { body: '商会已向旅人交出钥匙' }
    const result = await run(`
      async function write() {
        try { return await tools.tavern_${tool}(${JSON.stringify(args)}); }
        catch (error) { return {ok:false,error:String(error)}; }
      }
      const first = await write(); const retry = first.ok ? null : await write(); return {first,retry};
    `)
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const output = (result.value as { result: { first: { ok: boolean; id: string; hint: string; indexUpdated: boolean }; retry: unknown } }).result
    // 先核实际正文与通知，旧实现 worldstate 会把同一个业务事实追加两遍，且不发成功确认。
    const memories = await ws.memory.list(), deltas = await ws.deltas.list()
    expect.soft(tool === 'worldstate_update' ? deltas : memories).toHaveLength(1)
    expect.soft(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toHaveLength(1)
    expect.soft(output.retry).toBeNull()
    expect(output.first).toMatchObject({ ok: true, id: expect.any(String), indexUpdated: false, hint: expect.stringContaining('已保存') })
    expect(output.first.id).toBe(tool === 'worldstate_update' ? deltas[0]!.id : memories[0]!.id)
    expect(estimateTokens(JSON.stringify(output.first, null, 2))).toBeLessThanOrEqual(3000)
    expect(JSON.stringify(output.first)).not.toContain(root)
    expect(output.first.hint).toContain('不要重复')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EISDIR'))
    expect((await lstat(indexPath)).isDirectory()).toBe(true)
    // 外部目录故障必须先修复，回滚的派生索引刷新也会按同一真实 FS 边界明确失败。
    await rmdir(indexPath)
    const floor = state.openFloors.get(agent.id)!.floor
    await ws.wal.commitFloor(floor); await ws.wal.rollbackFloor(floor, ws.fs.root)
    expect(await ws.deltas.list()).toEqual([])
    if (existing) expect(await ws.fs.readText(`memory/${existing.file}`)).toBe(original)
    else expect(await ws.memory.list()).toEqual([])
  })

it('正常索引保持原回执与通知，索引字段按真实事实更新，全部事实同层回滚', async () => {
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined), ws = await workspace()
  const indexBefore = await ws.fs.readText('index.json')
  const result = await run(`const first = await tools.tavern_memory_write({body:'旅人持有北门钥匙'});
    const updated = await tools.tavern_memory_update({id:first.id,body:'旅人已交出北门钥匙'});
    const delta = await tools.tavern_worldstate_update({type:'add',content:'北门已经打开'}); return {first,updated,delta};`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: Record<string, { ok: boolean; id: string }> }).result
  for (const value of Object.values(output)) {
    expect(value).toMatchObject({ ok: true, id: expect.any(String) })
    expect(value).not.toHaveProperty('indexUpdated')
    expect(value).not.toHaveProperty('hint')
    expect(estimateTokens(JSON.stringify(value, null, 2))).toBeLessThanOrEqual(3000)
  }
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toHaveLength(3)
  const index = JSON.parse((await ws.fs.readText('index.json'))!) as { files: Array<{ path: string; tokens: number }> }
  const deltaText = (await ws.fs.readText('state/world-delta.jsonl'))!
  expect(index.files.find(file => file.path === 'state/world-delta.jsonl')?.tokens).toBe(estimateTokens(deltaText))
  expect(index.files.find(file => file.path === `memory/${output.first!.id}.md`)).toBeDefined()
  const floor = state.openFloors.get(agent.id)!.floor
  await ws.wal.commitFloor(floor); await ws.wal.rollbackFloor(floor, ws.fs.root)
  expect(await ws.memory.list()).toEqual([]); expect(await ws.deltas.list()).toEqual([])
  expect(JSON.parse((await ws.fs.readText('index.json'))!).files).toEqual(JSON.parse(indexBefore!).files)
})

it('成功通知注入抛错不丢主事实的结构化成功回执', async () => {
  vi.spyOn(agent, 'inject').mockImplementation(() => { throw new Error('通知不可用') })
  const result = await run(`return await tools.tavern_worldstate_update({type:'add',content:'灯塔已点亮'});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { ok: true, id: expect.any(String) } })
  expect(await (await workspace()).deltas.list()).toHaveLength(1)
})

it('索引故障的日志后端同步抛错也不丢成功回执，巨型正文不扩大回执预算', async () => {
  const ws = await workspace(), indexPath = join(ws.fs.root, 'index.json')
  await rm(indexPath); await mkdir(indexPath)
  const warn = vi.spyOn(agent.ctx.logger, 'warn').mockImplementation(() => { throw new Error('日志后端不可用') })
  const body = '\u0000"\\\n界'.repeat(4000)
  const result = await run(`return await tools.tavern_worldstate_update({type:'add',content:${JSON.stringify(body)}});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: { ok: boolean; id: string; indexUpdated: boolean } }).result
  expect(output).toMatchObject({ ok: true, id: expect.any(String), indexUpdated: false })
  expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(3000)
  expect((await ws.deltas.list())[0]).toMatchObject({ id: output.id, content: body })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('EISDIR'))
})

it('主写入的真实文件故障仍拒绝成功，不能被派生索引容错吞掉', async () => {
  const ws = await workspace(), deltaPath = join(ws.fs.root, 'state', 'world-delta.jsonl')
  await mkdir(deltaPath)
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  const walBefore = await Promise.all((await ws.fs.list('state/wal')).map(async path => [path, await ws.fs.readText(`state/wal/${path}`)]))
  const result = await run(`try { return await tools.tavern_worldstate_update({type:'add',content:'不能保存'}); }
    catch (error) { return {ok:false,error:String(error)}; }`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { ok: false, error: expect.stringContaining('EISDIR') } })
  expect(result.value).not.toHaveProperty('result.id')
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toEqual([])
  expect(await Promise.all((await ws.fs.list('state/wal')).map(async path => [path, await ws.fs.readText(`state/wal/${path}`)]))).toEqual(walBefore)
})

it('记忆容量检查故障在主写入前拒绝，正文、WAL 与成功通知都不变化', async () => {
  const ws = await workspace(), existing = await ws.memory.write({ body: '原来的记忆正文' })
  const before = await ws.fs.readText(`memory/${existing.file}`)
  const walBefore = await Promise.all((await ws.fs.list('state/wal')).map(async path => [path, await ws.fs.readText(`state/wal/${path}`)]))
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  vi.spyOn(MemoryStore.prototype, 'stats').mockRejectedValueOnce(new Error('容量读取故障'))
  const result = await run(`try { return await tools.tavern_memory_update({id:${JSON.stringify(existing.id)},body:'不应落盘的替换'}); }
    catch (error) { return {ok:false,error:String(error)}; }`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { ok: false, error: expect.stringContaining('容量读取故障') } })
  expect(await ws.fs.readText(`memory/${existing.file}`)).toBe(before)
  expect(await Promise.all((await ws.fs.list('state/wal')).map(async path => [path, await ws.fs.readText(`state/wal/${path}`)]))).toEqual(walBefore)
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toEqual([])
  expect(state.pendingMemoryCompress.has(storyId)).toBe(false)
})

it('记忆更新的容量预测使用持久化正文 token，等于预算不压缩，超一 token 才标记', async () => {
  const ws = await workspace(), existing = await ws.memory.write({ body: '旧' })
  await ws.memory.write({ body: '其它记忆' })
  config.memory.maxTokens = 9
  const normalizedBody = '新正文界\nabc', input = `\r\n\r\n${normalizedBody.replace('\n', '\r\n')}\r\n\r\n`
  expect(estimateTokens(normalizedBody) + estimateTokens('其它记忆')).toBe(9)
  expect(estimateTokens(input) + estimateTokens('其它记忆')).toBeGreaterThan(9)
  const result = await run(`const first = await tools.tavern_memory_update({id:${JSON.stringify(existing.id)},body:${JSON.stringify(input)}});
    return first;`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { ok: true, id: existing.id } })
  expect(await ws.memory.get(existing.id)).toMatchObject({ body: normalizedBody })
  expect(state.pendingMemoryCompress.has(storyId)).toBe(false)
  const exceeded = await run(`return await tools.tavern_memory_update({id:${JSON.stringify(existing.id)},body:${JSON.stringify(normalizedBody + '界')}});`)
  expect(exceeded.isError, JSON.stringify(exceeded.content)).toBe(false)
  expect((await ws.memory.stats()).tokens).toBe(10)
  expect(state.pendingMemoryCompress.has(storyId)).toBe(true)
})

it('记忆更新主文件拒绝写入时不发布容量压缩标记或成功确认', async () => {
  const ws = await workspace(), existing = await ws.memory.write({ body: '旧' })
  config.memory.maxTokens = 0
  const before = await ws.fs.readText(`memory/${existing.file}`)
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  vi.spyOn(ws.wal, 'recordChange').mockRejectedValueOnce(new Error('WAL 拒绝主文件快照'))
  const result = await run(`try { return await tools.tavern_memory_update({id:${JSON.stringify(existing.id)},body:'新事实'}); }
    catch (error) { return {ok:false,error:String(error)}; }`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ result: { ok: false, error: expect.stringContaining('WAL 拒绝') } })
  expect(await ws.fs.readText(`memory/${existing.file}`)).toBe(before)
  expect(state.pendingMemoryCompress.has(storyId)).toBe(false)
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toEqual([])
})

it('新增记忆被 WAL 拒绝时不压缩既有事实，实际保存且索引故障时仍标记容量维护', async () => {
  const ws = await workspace(), existing = await ws.memory.write({ body: '既存事实' })
  config.memory.maxTokens = 0
  const inject = vi.spyOn(agent, 'inject').mockImplementation(() => undefined)
  vi.spyOn(ws.wal, 'recordChange').mockRejectedValueOnce(new Error('WAL 拒绝新增记忆'))
  const refused = await run(`try { return await tools.tavern_memory_write({body:'与旧记录无关的新港口事实'}); }
    catch (error) { return {ok:false,error:String(error)}; }`)
  expect(refused.isError, JSON.stringify(refused.content)).toBe(false)
  expect(refused.value).toMatchObject({ result: { ok: false, error: expect.stringContaining('WAL 拒绝') } })
  expect(await ws.memory.list()).toEqual([expect.objectContaining({ id: existing.id, body: '既存事实' })])
  expect.soft(state.pendingMemoryCompress.has(storyId)).toBe(false)
  expect(inject.mock.calls.filter(([message]) => JSON.stringify(message).includes(TURN_WRITE_ACK_PREFIX))).toEqual([])
  const indexPath = join(ws.fs.root, 'index.json')
  await rm(indexPath); await mkdir(indexPath)
  vi.spyOn(agent.ctx.logger, 'warn').mockImplementation(() => undefined)
  const stored = await run(`return await tools.tavern_memory_write({body:'与旧记录无关的新港口事实'});`)
  expect(stored.isError, JSON.stringify(stored.content)).toBe(false)
  expect(stored.value).toMatchObject({ result: { ok: true, compressScheduled: true, indexUpdated: false } })
  expect(await ws.memory.list()).toHaveLength(2)
  expect(state.pendingMemoryCompress.has(storyId)).toBe(true)
})
