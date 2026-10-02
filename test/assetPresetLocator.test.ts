/** 预设目录定位回归：完整 identifier 不能因前后空白被改指其它条目；真实剧情文件和原生 PTC 验证目录到正文一致。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { defaultPreset } from '../src/core/assemble.js'
import { assetOutputTokens, findPresetEntry, listPresetCatalog } from '../src/core/assetRead.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

it('完整 identifier 精确匹配优先，只有未精确命中时才使用去空白兼容查询', () => {
  const preset = defaultPreset(), entry = preset.entries[0]!
  preset.entries = [{ ...entry, identifier: 'anchor', content: '普通定位正文' },
    { ...entry, identifier: ' anchor ', content: '含空白定位的独立正文' }]
  expect(listPresetCatalog(preset).map(item => item.identifier)).toEqual(['anchor', ' anchor '])
  expect(findPresetEntry(preset, 'anchor')?.content).toBe('普通定位正文')
  expect(findPresetEntry(preset, ' anchor ')?.content).toBe('含空白定位的独立正文')
  expect(findPresetEntry(preset, '\tanchor\n')?.identifier).toBe('anchor')
  expect(findPresetEntry(preset, ' missing ')).toBeUndefined()
  expect(findPresetEntry(preset, ' anchor ', { exact: true })?.identifier).toBe(' anchor ')
  expect(findPresetEntry(preset, '\tanchor\n', { exact: true })).toBeUndefined()
})

describe('原生 PTC 预设定位', () => {
  let root: string, ctx: Context, state: TavernState, agent: Agent
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-preset-locator-'))
    state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
      personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
    await state.init()
    const cardId = (await state.createCharacter('预设定位工厂角色')).cardId
    await state.saveBinding({ sessionId: 'preset-locator-story', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    ctx = new Context()
    new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
    new LocalFileSystem(ctx, LocalFileSystem.Config({})); new LocalSubprocessRuntime(ctx)
    new LocalSandboxProvider(ctx, LocalSandboxProvider.Config({}))
    new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: root })
    new NodePtcRuntime(ctx, NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1_048_576, maxOldGenerationSizeMb: 128 }))
    agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('preset-locator-story'))
    ctx.provide('tavern', { state }); applyAgent(agent.ctx)
    const rows = parse(await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8'))
    agent.ctx.plugin(presentation, rows.find((row: { id: string }) => row.id === 'tool-presentation').config)
    await vi.waitFor(() => expect(ctx.tools.modeFor(agent)).toBe('ptc'))
  })
  afterEach(async () => {
    await ctx?.fiber.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
  })

  it('实际保存并按两种目录返回的 identifier 读取，含空白条目不能静默读成另一正文', async () => {
    const preset = defaultPreset(), entry = preset.entries[0]!
    preset.identifier = 'exact-preset-locator'
    preset.entries = [{ ...entry, identifier: 'anchor', content: '普通定位正文' },
      { ...entry, identifier: ' anchor ', enabled: false, content: '含空白定位的独立正文' }]
    const presetId = await state.savePreset(preset)
    await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId })
    expect((await state.loadPreset(presetId))!.entries.map(item => item.identifier)).toEqual(['anchor', ' anchor '])
    const result = await ctx.tools.execute({ agent, callId: ToolCallId('preset-locator'), name: 'run_code', signal: new AbortController().signal,
      arguments: { description: '验证目录定位原样读取', code: `
        const list = await tools.tavern_asset_list({});
        const catalog = await tools.tavern_asset_read({preset:'list'});
        const identifiers = list.preset.entries.map(entry=>entry.identifier);
        const reads = await Promise.all(identifiers.map(preset=>tools.tavern_asset_read({preset})));
        const compatible = await tools.tavern_asset_read({preset:' '.repeat(10000)+'anchor'+' '.repeat(10000)});
        return {list,catalog,reads,compatible};
      ` } })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const output = (result.value as { result: { list: { preset: { entries: Array<{ identifier: string }> } }; catalog: { preset: { entries: Array<{ identifier: string }> } };
      reads: Array<{ ok: boolean; preset: { identifier: string; content: string; enabled: boolean } }>; compatible: { preset: { identifier: string; content: string } } } }).result
    for (const catalog of [output.list.preset, output.catalog.preset]) expect(catalog.entries.map(item => item.identifier)).toEqual(['anchor', ' anchor '])
    expect(output.reads).toMatchObject([{ ok: true, preset: { identifier: 'anchor', content: '普通定位正文' } },
      { ok: true, preset: { identifier: ' anchor ', content: '含空白定位的独立正文', enabled: false } }])
    expect(output.compatible.preset).toMatchObject({ identifier: 'anchor', content: '普通定位正文' })
    for (const value of [output.list, output.catalog, ...output.reads, output.compatible]) expect(assetOutputTokens(value)).toBeLessThanOrEqual(3000)
    expect((await state.loadPreset(presetId))!.entries).toEqual(preset.entries)
  })

  it('精确参数可读取目录命令同名及纯空白条目，旧目录命令兼容且双字段明确拒绝', async () => {
    const preset = defaultPreset(), entry = preset.entries[0]!
    const identifiers = ['list', 'catalog', '*', 'all', 'anchor', ' anchor ', ' ']
    preset.identifier = 'reserved-preset-locator'
    preset.entries = identifiers.map((identifier, index) => ({ ...entry, identifier, content: `独立条目正文${index}` }))
    const presetId = await state.savePreset(preset)
    await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId })
    const result = await ctx.tools.execute({ agent, callId: ToolCallId('preset-exact-locator'), name: 'run_code', signal: new AbortController().signal,
      arguments: { description: '验证完整 identifier 与目录命令互不歧义', code: `
        const list = await tools.tavern_asset_list({});
        const reads = await Promise.all(list.preset.entries.map(entry=>tools.tavern_asset_read({presetIdentifier:entry.identifier})));
        const catalogs = await Promise.all(['list','catalog','*'].map(preset=>tools.tavern_asset_read({preset})));
        const legacy = await tools.tavern_asset_read({preset:'all'});
        const missing = await tools.tavern_asset_read({presetIdentifier:'  anchor  '});
        const conflicts = await Promise.all([
          {preset:'list',presetIdentifier:'anchor'}, {preset:'',presetIdentifier:'anchor'}, {preset:'anchor',presetIdentifier:''}
        ].map(args=>tools.tavern_asset_read(args)));
        const tooLarge = await tools.tavern_asset_read({presetIdentifier:'字'.repeat(3001)});
        return {list,reads,catalogs,legacy,missing,conflicts,tooLarge};
      ` } })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const output = (result.value as { result: { list: { hint: string; preset: { entries: Array<{ identifier: string }> } }; reads: Array<{ ok: boolean; preset: { identifier: string; content: string } }>;
      catalogs: Array<{ preset: { mode: string } }>; legacy: { preset: { identifier: string; content: string } }; missing: { ok: boolean; error: string };
      conflicts: Array<{ ok: boolean; error: string }>; tooLarge: { ok: boolean; error: string } } }).result
    expect(output.list.preset.entries.map(item => item.identifier)).toEqual(identifiers)
    expect(output.reads).toMatchObject(identifiers.map((identifier, index) => ({ ok: true, preset: { identifier, content: `独立条目正文${index}` } })))
    expect(output.list.hint).toContain('presetIdentifier')
    for (const catalog of output.catalogs) expect(catalog.preset.mode).toBe('catalog')
    expect(output.legacy.preset).toMatchObject({ identifier: 'all', content: '独立条目正文3' })
    expect(output.missing).toMatchObject({ ok: false, error: expect.stringContaining('not-found') })
    for (const conflict of output.conflicts) expect(conflict).toMatchObject({ ok: false, error: expect.stringContaining('invalid-args') })
    expect(output.tooLarge).toMatchObject({ ok: false, error: expect.stringContaining('asset-output-too-large') })
    for (const value of [output.list, ...output.reads, ...output.catalogs, output.legacy, output.missing, ...output.conflicts, output.tooLarge]) {
      expect(assetOutputTokens(value)).toBeLessThanOrEqual(3000)
    }
    const sdk = (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(section => section.name === 'tools:sdk')!.text
    expect(sdk).toContain('presetIdentifier?: string')
    expect((await state.loadPreset(presetId))!.entries).toEqual(preset.entries)
  })
})
