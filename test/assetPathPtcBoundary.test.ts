/** 资产路径的原生 PTC 边界：不可表示路径返回有界业务错误，合法长路径可读，真实 I/O 故障仍明确失败。 */
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
import { assetOutputTokens, resolveReadableAssetPath } from '../src/core/assetRead.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, cardId: string, storyId: string
let call = 0
const workspace = () => state.storyWorkspace(cardId, storyId)
const run = (code: string) => ctx.tools.execute({ agent, callId: ToolCallId(`asset-path-${++call}`), name: 'run_code',
  arguments: { code, description: '验证资产路径业务拒绝与并行读取' }, signal: new AbortController().signal })

/** 沿用既有 PTC 工厂的真实宿主、YAML selector 和 Node 子进程链，只建立读取所需的临时剧情。 */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-asset-path-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init(); cardId = (await state.createCharacter('路径工厂角色')).cardId
  await state.saveBinding({ sessionId: 'asset-path-story', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('asset-path-story'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('asset-path-story'))
  ctx.provide('tavern', { state }); applyAgent(agent.ctx)
  const rows = parse(await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8'))
  agent.ctx.plugin(presentation, rows.find((row: { id: string }) => row.id === 'tool-presentation').config)
  await vi.waitFor(() => expect(ctx.tools.modeFor(agent)).toBe('ptc'))
  await (await workspace()).fs.writeText('journal.md', '正常读取的港口记录')
})

afterEach(async () => {
  await ctx?.fiber.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
})

it('任一文件系统阶段的 ENAMETOOLONG 不回显系统路径，也不终止同批正常读取', async () => {
  const ws = await workspace(), path = `state/${'字'.repeat(1000)}.json`
  const original = WorkspaceFs.prototype.readText
  // Windows 与 Linux 对长文件名的 errno 不同；只在真实读取入口注入 Linux 的原始故障，验证实际宿主 PTC 收口。
  vi.spyOn(WorkspaceFs.prototype, 'readText').mockImplementation(async function (this: WorkspaceFs, relPath, options) {
    if (this.root === ws.fs.root && relPath === path) {
      const absolute = join(this.root, relPath)
      throw Object.assign(new Error(`ENAMETOOLONG: name too long, lstat '${absolute}'`), { code: 'ENAMETOOLONG', path: absolute })
    }
    return original.call(this, relPath, options)
  })
  const result = await run(`return await Promise.all([tools.tavern_asset_read({path:${JSON.stringify(path)}}),tools.tavern_asset_read({path:'journal.md'})]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const outputs = (result.value as { result: Array<{ ok: boolean; error?: string; file?: { path: string; content: string } }> }).result
  expect(outputs[0]).toMatchObject({ ok: false, error: expect.stringContaining('invalid-path') })
  expect(assetOutputTokens(outputs[0])).toBeLessThanOrEqual(3000)
  expect(JSON.stringify(outputs[0])).not.toContain(root)
  expect(JSON.stringify(outputs[0])).not.toContain(path)
  expect(outputs[1]).toMatchObject({ ok: true, file: { path: 'journal.md', content: '正常读取的港口记录' } })
})

it('真实文件系统不支持的长单段路径返回业务拒绝，不把未知目标伪造成完整可读定位', async () => {
  await (await workspace()).fs.ensureDir('state')
  const path = `state/${'字'.repeat(400)}.json`
  const result = await run(`return await Promise.all([tools.tavern_asset_read({path:${JSON.stringify(path)}}),tools.tavern_asset_read({path:'journal.md'})]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const outputs = (result.value as { result: Array<{ ok: boolean; error?: string }> }).result
  expect(outputs[0]!.ok).toBe(false)
  // POSIX 的实际单段 UTF-8 上限触发 ENAMETOOLONG；Windows 也可能报告不存在，二者都不能成为 PTC 异常。
  if (process.platform !== 'win32') expect(outputs[0]!.error).toContain('invalid-path')
  expect(assetOutputTokens(outputs[0])).toBeLessThanOrEqual(3000)
  expect(JSON.stringify(outputs[0])).not.toContain(root)
  expect(outputs[1]!.ok).toBe(true)
})

it('含 NUL 的路径在逻辑边界明确拒绝，同批正常文件仍可读取', async () => {
  const paths = ['state/坏\u0000文件.json', 'state/\u0000/笔记.md']
  const result = await run(`return await Promise.all([...${JSON.stringify(paths)}.map(path=>tools.tavern_asset_read({path})),tools.tavern_asset_read({path:'journal.md'})]);`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  for (const path of paths) expect(resolveReadableAssetPath(path)).toMatchObject({ ok: false })
  const outputs = (result.value as { result: Array<{ ok: boolean; error?: string }> }).result
  for (const output of outputs.slice(0, 2)) {
    expect(output).toMatchObject({ ok: false, error: '路径不合法' })
    expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
  }
  expect(outputs[2]!.ok).toBe(true)
})

it('合法总长超过 400 字符但每段可表示的路径保留完整定位并读取正文', async () => {
  // 末段连同 WorkspaceFs 原子写入的 .UUID.tmp 后缀也必须在 Linux 单段字节上限内。
  const path = `state/${Array.from({ length: 5 }, () => '目录'.repeat(35)).join('/')}/${'笔记'.repeat(30)}.md`
  expect(path.length).toBeGreaterThan(400)
  await (await workspace()).fs.writeText(path, '长路径中的工厂事实')
  const result = await run(`return await tools.tavern_asset_read({path:${JSON.stringify(path)}});`)
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const output = (result.value as { result: unknown }).result
  expect(output).toMatchObject({ ok: true, file: { path, content: '长路径中的工厂事实' } })
  expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
})

it.each(['EACCES', 'EPERM', 'EIO'])('真实 %s 故障不能被路径容错掩盖成 not-found 或业务拒绝', async code => {
  const ws = await workspace(), original = WorkspaceFs.prototype.readText
  vi.spyOn(WorkspaceFs.prototype, 'readText').mockImplementation(async function (this: WorkspaceFs, path, options) {
    if (this.root === ws.fs.root && path === 'journal.md') throw Object.assign(new Error(`实际存储故障 ${code}`), { code })
    return original.call(this, path, options)
  })
  const result = await run(`return await tools.tavern_asset_read({path:'journal.md'});`)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(`实际存储故障 ${code}`)
})
