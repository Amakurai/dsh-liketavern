/**
 * 预设采样回归：导入/导出与存储边界，字段覆盖、宿主透传白名单、真实文件管线与同轮冻结。
 * 测试全部使用手写资产与临时目录，不读取用户数据、不调用真实模型。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeTavernCallConfig } from '../src/core/callConfig.js'
import { MAX_PRESET_STOP_CHARS, parsePresetSampling, resolvePresetSampling } from '../src/core/presetSampling.js'
import { DEFAULT_SAMPLING, type CharacterCard } from '../src/core/types.js'
import { exportStPreset, parseStoredPreset, parseStPreset } from '../src/state/presetStore.js'
import { importCard } from '../src/state/workspace.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import type { TavernPaths } from '../src/node/paths.js'

describe('预设采样格式与失败边界', () => {
  it('支持 ST 顶层采样，保留不透传字段并给出明确告警；保存与导出往返不丢值', () => {
    const raw = { name: '采样测试', identifier: 'sampling', prompts: [], temperature: '0.7', openai_max_tokens: 2048,
      top_p: 0.8, presence_penalty: 0.4, frequency_penalty: -0.2, stop: ['\n结束', '</reply>'] }
    const { preset, warnings } = parseStPreset(raw)
    expect(preset.sampling).toEqual({ temperature: 0.7, maxTokens: 2048, topP: 0.8, presencePenalty: 0.4,
      frequencyPenalty: -0.2, stop: ['\n结束', '</reply>'] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/top_p.*presence_penalty.*frequency_penalty.*不透传/)
    expect(parseStoredPreset(JSON.parse(JSON.stringify(preset)))).toEqual(preset)
    expect(parseStPreset(exportStPreset(preset)).preset).toEqual(preset)
    expect(exportStPreset(preset)).toMatchObject({ temperature: 0.7, openai_max_tokens: 2048, top_p: 0.8 })
  })

  it('旧预设不注入采样默认值，部分覆盖不改变思考设置，显式空值清除插件全局值', () => {
    const old = parseStPreset({ prompts: [] }).preset
    expect(old.sampling).toBeUndefined()
    expect(exportStPreset(old)).not.toHaveProperty('temperature')
    const global = { ...DEFAULT_SAMPLING, maxTokens: 8192, stop: ['global'], thinking: 'disabled' as const }
    const result = resolvePresetSampling(global, { temperature: 0, maxTokens: null, stop: [] })
    expect(result).toEqual({ ...global, temperature: 0, maxTokens: null, stop: [] })
    expect(resolvePresetSampling(global, { temperature: undefined })).toEqual(global)
    const fallback = resolvePresetSampling(global, { temperature: 0.2 })
    fallback.stop.push('mutated')
    expect(global.stop).toEqual(['global'])
    expect(fallback.thinking).toBe('disabled')
  })

  it('接收附带的 ST 自定义停止序列，保留换行与空数组语义', () => {
    expect(parseStPreset({ prompts: [], custom_stopping_strings: '["\\nEND"]' }).preset.sampling?.stop).toEqual(['\nEND'])
    expect(parseStPreset({ prompts: [], custom_stopping_strings: '' }).preset.sampling?.stop).toEqual([])
    expect(parseStPreset({ prompts: [], stop: 'END' }).preset.sampling?.stop).toEqual(['END'])
  })

  it.each([
    { temperature: 3 }, { temperature: 'bogus' }, { temperature: Number.POSITIVE_INFINITY },
    { top_p: -0.01 }, { presence_penalty: 3 }, { frequency_penalty: {} },
    { openai_max_tokens: -1 }, { openai_max_tokens: 1.5 }, { openai_max_tokens: 2_000_001 },
    { stop: [''] }, { stop: [7] }, { stop: Array.from({ length: 17 }, () => 'STOP') },
    { stop: ['x'.repeat(MAX_PRESET_STOP_CHARS + 1)] }, { custom_stopping_strings: '{"invalid":true}' },
    { custom_stopping_strings: '[' },
  ])('导入非法或超限采样明确拒绝：%j', fields => {
    expect(() => parseStPreset({ prompts: [], ...fields })).toThrow(/预设采样/)
  })

  it('内部保存也拒绝非法类型与未枚举请求字段，导出同样复核', () => {
    const preset = { identifier: 'sampling', name: 'Sampling', entries: [] }
    expect(() => parseStoredPreset({ ...preset, sampling: { temperature: '1' } })).toThrow(/预设采样/)
    expect(() => parseStoredPreset({ ...preset, sampling: { temperature: 1, provider: 'malicious' } })).toThrow(/预设采样/)
    expect(() => parsePresetSampling({ provider: 'malicious', temperature: 1 })).toThrow(/预设采样/)
    expect(() => parsePresetSampling({ thinking: 'enabled' })).toThrow(/预设采样/)
    expect(() => exportStPreset({ ...preset, sampling: { maxTokens: Number.NaN } })).toThrow(/预设采样/)
  })

  it('ST 模型专用或未知思考档位明确告警，不猜测映射也不强开思考', () => {
    const { preset, warnings } = parseStPreset({ prompts: [], reasoning_effort: 'unknown-provider-mode' })
    expect(preset.sampling).toBeUndefined()
    expect(warnings).toEqual([expect.stringMatching(/未应用.*reasoning_effort.*宿主模型/)] )
    expect(resolvePresetSampling({ ...DEFAULT_SAMPLING, thinking: 'disabled' }, preset.sampling).thinking).toBe('disabled')
  })
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'preset-sampling-'))
  roots.push(root)
  const paths: TavernPaths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const config = resolveConfig({ sampling: { temperature: 1.1, maxTokens: 8192, stop: ['GLOBAL'], thinking: 'disabled' } })
  const state = new TavernState(paths, () => config)
  await state.init()
  const card: CharacterCard = { spec: 'chara_card_v2', name: '采样角色', description: '角色定义', personality: '', scenario: '',
    firstMes: '你好', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '',
    creator: 'test', characterVersion: '', tags: [], characterBook: null, regexScripts: [], extensions: {}, depthPrompt: null, pngBytes: null, raw: {} }
  const { cardId } = await importCard(paths.characters, card)
  const { preset } = parseStPreset({ identifier: 'sampling', name: 'Sampling', prompts: [{ identifier: 'main', content: 'Test preset' }],
    temperature: 0.3, top_p: 0.9, presence_penalty: 0.2, openai_max_tokens: 2048, stop: ['PRESET'] })
  const presetId = await state.savePreset(preset)
  await saveBinding(paths, { sessionId: 'sampling-session', cardId, cardName: card.name, presetId, personaId: null,
    lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  return { paths, state, config, preset, presetId }
}

describe('真实文件预设采样管线', () => {
  it('重启加载保留采样；同轮资产编辑冻结采样，下一轮才生效；请求只合入宿主支持字段', async () => {
    const { paths, config, presetId, preset } = await setup()
    const state = new TavernState(paths, () => config)
    await state.init()
    expect((await state.loadPreset(presetId))?.sampling).toEqual(preset.sampling)
    const run = () => runTavernPipeline({ state, sessionId: 'sampling-session', agent: null, mode: 'live',
      historyOverride: [{ role: 'user', content: '你好' }] })
    await onTurnStart(state, 'sampling-session', 1)
    const first = await run()
    expect(first?.sampling).toEqual({ ...config.sampling, ...preset.sampling })
    const request = mergeTavernCallConfig({ provider: 'mock', model: 'mock' }, first!.sampling, undefined)
    expect(request).toEqual({ provider: 'mock', model: 'mock', temperature: 0.3, maxTokens: 2048, stop: ['PRESET'] })

    await state.savePreset({ ...preset, sampling: { temperature: 0.6 } })
    const sameTurn = await run()
    expect(sameTurn?.sampling).toEqual(first?.sampling)
    await onTurnEnd(state, 'sampling-session')
    await onTurnStart(state, 'sampling-session', 2)
    const next = await run()
    expect(next?.sampling).toEqual({ ...config.sampling, temperature: 0.6 })
    expect(next?.sampling.thinking).toBe('disabled')
    await onTurnEnd(state, 'sampling-session')
  })

  it('回复预算使用预设上限，超过可用窗口时拒绝 live 组装', async () => {
    const { state, preset } = await setup()
    await state.savePreset({ ...preset, sampling: { maxTokens: 131072 } })
    await onTurnStart(state, 'sampling-session', 1)
    await expect(runTavernPipeline({ state, sessionId: 'sampling-session', agent: null, mode: 'live',
      historyOverride: [{ role: 'user', content: '你好' }] })).rejects.toThrow(/可用窗口/)
    expect(state.turnPlans.has('sampling-session')).toBe(false)
  })
})
