/** 世界书工具完整输出预算：真实资产/剧情与原生 PTC 验证目录、转义正文及定位字段不突破 JSON 预算。 */
import { mkdtemp, rm } from 'node:fs/promises'
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
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { registerTavernTools } from '../src/node/tools.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { LORE_READ_TOKEN_BUDGET } from '../src/core/loreQuery.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, call = 0
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lore-output-budget-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const { cardId } = await state.createCharacter('世界书预算工厂角色')
  await state.saveBinding({ sessionId: 'lore-budget', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
  new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
  // 仅执行手写 PTC 程序；世界书字段始终作为数据，不运行第三方脚本或模型。
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
  new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('lore-budget'))
  registerTavernTools(agent.ctx, state)
  agent.ctx.plugin(presentation, { mode: 'ptc' })
  await vi.waitFor(() => expect(ctx.tools.modeFor(agent)).toBe('ptc'))
})
afterEach(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

async function saveBook(entries: Record<string, unknown>) {
  const id = await state.saveLorebook('预算工厂世界书', { name: '预算工厂世界书', entries })
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, lorebookIds: [id] })
  return id
}
async function run(code: string) {
  const result = await ctx.tools.execute({ agent, callId: ToolCallId(`lore-budget-${++call}`), name: 'run_code',
    arguments: { code, description: '验证世界书完整 JSON 输出' }, signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  return (result.value as { result: Record<string, unknown> }).result
}
function bounded(output: unknown) { expect(estimateTokens(JSON.stringify(output, null, 2))).toBeLessThanOrEqual(LORE_READ_TOKEN_BUDGET) }

it('合法巨大注释/触发键和转义正文也受完整输出预算约束，schema透传裁剪标记', async () => {
  const keys = Array.from({ length: 100 }, (_, i) => `${i}-${'trigger'.repeat(8)}`)
  const bookId = await saveBook({ target: { comment: '巨大世界书注释'.repeat(3000), key: keys, content: '\u0000'.repeat(4000), disable: true } })
  const output = await run('return await tools.tavern_lore_read({uid:"target"});')
  bounded(output)
  expect(output).toMatchObject({ ok: true, mode: 'content', truncated: true, omitted: 0 })
  const entry = (output.entries as Array<Record<string, unknown>>)[0]!
  expect(entry).toMatchObject({ uid: 'target', key: `global:${bookId}:target`, enabled: false, metadataTruncated: true, truncated: true })
  expect(entry.keysOmitted).toBeGreaterThan(0)
  for (const key of entry.keys as string[]) expect(keys).toContain(key)
  expect(output.tokensUsed).toBe(estimateTokens(JSON.stringify(output, null, 2)))
})

it('许多合法目录条目按完整JSON预算省略，返回定位仍可原样补读正文', async () => {
  const entries = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`uid-${i}`, { comment: '目录注释', key: ['港口'], content: '有界预览'.repeat(20) }]))
  await saveBook(entries)
  const output = await run('const catalog = await tools.tavern_lore_read({}); const read = await tools.tavern_lore_read({uid:catalog.entries[0].key}); return {catalog,read};')
  const catalog = output.catalog as { entries: Array<{ uid: string; key: string }>; count: number; omitted: number; tokensUsed: number }
  const read = output.read as { entries: Array<{ uid: string; key: string; content: string }> }
  bounded(catalog); bounded(read)
  expect(catalog).toMatchObject({ ok: true, mode: 'catalog', count: 100, truncated: true })
  expect(catalog.omitted).toBe(100 - catalog.entries.length)
  expect(catalog.omitted).toBeGreaterThan(0)
  expect(catalog.tokensUsed).toBe(estimateTokens(JSON.stringify(catalog, null, 2)))
  expect(read.entries[0]).toMatchObject({ uid: catalog.entries[0]!.uid, key: catalog.entries[0]!.key, content: entries[catalog.entries[0]!.uid]!.content })
})

it('过大定位省略整条但仍发现后续条目，可装下的长uid保持完整且过大精确阅读明确失败', async () => {
  const huge = 'huge-'.repeat(5000), long = 'long-'.repeat(280)
  const bookId = await saveBook({ [huge]: { content: '过大定位正文' }, [long]: { content: '合法长定位正文' }, tail: { content: '目录尾部锚点' } })
  const output = await run(`const catalog = await tools.tavern_lore_read({}); const long = await tools.tavern_lore_read({uid:${JSON.stringify(long)}}); const huge = await tools.tavern_lore_read({uid:${JSON.stringify(huge)}}); return {catalog,long,huge};`)
  for (const item of Object.values(output)) bounded(item)
  expect(output.catalog).toMatchObject({ count: 3, omitted: 1, truncated: true })
  expect((output.catalog as { entries: Array<{ uid: string }> }).entries.map(entry => entry.uid)).toEqual([long, 'tail'])
  expect(output.long).toMatchObject({ ok: true, entries: [{ uid: long, key: `global:${bookId}:${long}`, content: '合法长定位正文' }] })
  expect(output.huge).toMatchObject({ ok: false, error: expect.stringContaining('lore-output-too-large') })
})
