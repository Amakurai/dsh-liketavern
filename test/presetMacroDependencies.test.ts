/** 预设宏变量依赖回归：真实隔离 worker 验证跨条目传递，真实文件系统验证同轮冻结与跨轮缓存边界。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyTemplateScopes } from '../src/core/template.js'
import { Marker, type CharacterCard, type PresetEntry, type PromptPreset } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { importCard } from '../src/state/workspace.js'

function preset(contents: string[]): PromptPreset {
  const entries: PresetEntry[] = contents.map((content, order) => ({
    identifier: `rule-${order}`, name: `rule-${order}`, enabled: true, role: 'system', position: 'relative',
    depth: 4, order, content, marker: false,
  }))
  entries.push({ identifier: Marker.ChatHistory, name: 'history', enabled: true, role: 'system', position: 'relative',
    depth: 4, order: entries.length, content: '', marker: true, markerId: Marker.ChatHistory })
  return { identifier: 'macro-dependencies', name: '宏依赖', entries }
}

function request(contents: string[], latest = 'rain', templates = false): ComputeJobs['assemble']['input'] {
  const input: ComputeJobs['assemble']['input'] = {
    preset: preset(contents), card: null, personaDescription: '', history: [{ role: 'user', content: latest }],
    wi: null, memories: [], worldDeltas: [], regexRules: [], macroCtx: { char: 'Alice', user: 'Bob' }, seed: 42,
    budget: { maxTokens: 100000, reserveForOutput: 0 },
  }
  if (templates) input.templates = { variables: emptyTemplateScopes(), char: 'Alice', user: 'Bob', card: {},
    entries: [], presets: input.preset.entries, history: input.history, now: 1000, seed: 42, phase: 'generate' }
  return input
}

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function story(presetValue: PromptPreset) {
  const root = await mkdtemp(join(tmpdir(), 'preset-macro-dependencies-')); roots.push(root)
  const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const state = new TavernState(paths, () => resolveConfig({})); await state.init()
  const card: CharacterCard = { spec: 'chara_card_v2', name: 'Alice', description: '角色', personality: '', scenario: '', firstMes: '',
    alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '',
    characterVersion: '', tags: [], characterBook: null, regexScripts: [], extensions: {}, pngBytes: null, raw: {}, depthPrompt: null }
  const { cardId } = await importCard(paths.characters, card)
  const presetId = await state.savePreset(presetValue)
  await saveBinding(paths, { sessionId: 's1', cardId, cardName: 'Alice', presetId, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const run = (latest: string) => runTavernPipeline({ state, sessionId: 's1', agent: null, mode: 'live',
    historyOverride: [{ role: 'user', content: latest }] })
  return { state, paths, cardId, run }
}

describe('预设变量依赖在隔离器内展开', () => {
  it.each([false, true])('动态 setvar 的跨条目读取进入本轮通道（模板执行=%s）', async (templates) => {
    const input = request([
      '{{setvar::style::warm}}',
      ...(templates ? ['<% /* 让真实 worker 启动模板来源序列 */ %>'] : []),
      '{{setvar::topic::{{lastusermessage}}}}',
      'RULE={{getvar::topic}}',
      'STYLE={{getvar::style}}',
    ], 'rain', templates)
    const original = structuredClone(input)
    const result = await isolated('assemble', input)
    expect(result.messages.some(message => message.content === 'RULE=rain')).toBe(true)
    expect(result.turnContext).toContain('RULE=rain')
    expect(result.standing).not.toContain('RULE=')
    expect(result.standing).toContain('STYLE=warm')
    expect(input).toEqual(original)
  })

  it('局部/全局别名及多层变量引用传递动态依赖，静态重赋值恢复稳定内容', async () => {
    const result = await isolated('assemble', request([
      '{{setglobalvar :: topic ::{{lastusermessage}}}}',
      '{{setlocalvar::copy::{{getglobalvar::topic}}}}',
      '{{setvar::rule::{{getlocalvar::copy}}}}',
      'FIRST={{getvar::rule}}',
      '{{setvar::topic::fixed}}',
      'STATIC={{getglobalvar::topic}}',
      'DYNAMIC={{getvar::copy}}/{{lastusermessage}}',
    ]))
    expect(result.turnContext).toContain('FIRST=rain')
    expect(result.turnContext).toContain('DYNAMIC=rain/rain')
    expect(result.standing).toContain('STATIC=fixed')
    expect(result.standing).not.toContain('FIRST=')
  })

  it('addvar 读取原值并传播依赖，纯静态累加保持稳定', async () => {
    const result = await isolated('assemble', request([
      '{{setvar::counter::{{lastusermessage}}}}',
      '{{addvar::counter::2}}',
      '{{setvar::copied::{{getvar::counter}}}}',
      'COUNT={{getvar::copied}}',
      '{{setvar::static::3}}',
      '{{addvar::static::2}}',
      'STATIC={{getvar::static}}',
      '{{setvar::static::8}}',
      'UPDATED={{getvar::static}}/{{lastusermessage}}',
    ], '5'))
    expect(result.turnContext).toContain('COUNT=7')
    expect(result.turnContext).toContain('UPDATED=8/5')
    expect(result.standing).toContain('STATIC=5')
    expect(result.standing).not.toContain('COUNT=')
  })

  it('卡字段里的动态赋值及读取沿字段引用传递', async () => {
    const input = request(['{{description}}', 'RULE={{scenario}}'])
    input.macroCtx.description = '{{setvar::topic::{{lastusermessage}}}}'
    input.macroCtx.scenario = '{{getvar::topic}}'
    const result = await isolated('assemble', input)
    expect(result.turnContext).toContain('RULE=rain')
    expect(result.standing).not.toContain('RULE=')
  })

  it('隔离 worker 保留静态 charPrompt，charInstruction 内最后消息只进入本轮', async () => {
    const input = request(['{{charPrompt}}', '{{charInstruction}}'])
    input.macroCtx.charPrompt = 'STYLE=calm {{user}}'
    input.macroCtx.charInstruction = 'RECENT={{lastMessage}}'
    input.macroCtx.lastUserMessage = 'earlier question'
    input.macroCtx.lastMessage = 'latest answer'
    const result = await isolated('assemble', input)
    expect(result.standing).toContain('STYLE=calm Bob')
    expect(result.standing).not.toContain('RECENT=')
    expect(result.turnContext).toContain('RECENT=latest answer')
    expect(result.turnContext).not.toContain('earlier question')
    expect(result.log.filter(item => item.kind === 'unknown-macro')).toEqual([])
  })

  it('未启用或未触发的动态赋值不污染普通静态变量', async () => {
    const input = request(['{{setvar::topic::fixed}}', '{{setvar::topic::{{lastusermessage}}}}',
      '{{setvar::topic::{{lastcharmessage}}}}', 'RULE={{getvar::topic}}'])
    input.preset.entries[1]!.enabled = false
    input.preset.entries[2]!.injectionTrigger = ['continue']
    const result = await isolated('assemble', input)
    expect(result.standing).toContain('RULE=fixed')
    expect(result.turnContext).not.toContain('RULE=')
  })

  it('计算变量名按本轮上下文保守处理，不向稳定前缀泄漏用户输入', async () => {
    const result = await isolated('assemble', request([
      '{{setvar::{{char}}::{{lastusermessage}}}}', 'RULE={{getvar::Alice}}',
    ]))
    expect(result.turnContext).toContain('RULE=rain')
    expect(result.standing).not.toContain('RULE=')
  })

  it('外部变量与只读剧情变量保持本轮语义', async () => {
    const input = request(['SUPPLIED={{getvar::topic}}', '{{setvar::hp::{{getvar::stat_data.hp}}}}', 'HP={{getvar::hp}}'])
    input.macroCtx.store = new Map([['topic', 'rain']])
    input.macroCtx.readonlyStatData = { hp: 7 }
    const result = await isolated('assemble', input)
    expect(result.turnContext).toContain('SUPPLIED=rain')
    expect(result.turnContext).toContain('HP=7')
    expect(result.standing).not.toContain('SUPPLIED=')
    expect(result.standing).not.toContain('HP=')
  })

  it('同条读取动态变量并重赋值时，在展开前冻结本轮归属', async () => {
    const result = await isolated('assemble', request([
      '{{setvar::topic::{{lastusermessage}}}}',
      'RULE={{getvar::topic}}{{setvar::topic::fixed}}',
    ]))
    // 宏引擎在同串内先执行赋值再读取；即使最终恰好为常量，也不能在求值后改判通道。
    expect(result.turnContext).toContain('RULE=fixed')
    expect(result.standing).not.toContain('RULE=')
  })
})

describe('宏变量计划在真实剧情中的冻结', () => {
  it('同轮重放完整依赖结果，下轮更新动态值且保留静态前缀字节', async () => {
    const { state, run } = await story(preset(['{{setvar::style::warm}}', 'STYLE={{getvar::style}}',
      '{{setvar::topic::{{lastusermessage}}}}', '{{setvar::copy::{{getvar::topic}}}}', 'RULE={{getvar::copy}}']))
    await onTurnStart(state, 's1', 1)
    const first = (await run('rain'))!
    const replay = (await run('same turn changed history'))!
    expect(first.turnContext).toContain('RULE=rain')
    expect(replay.turnContext).toBe(first.turnContext)
    expect(first.standing).toContain('STYLE=warm')
    expect(first.standing).not.toContain('RULE=')
    await onTurnEnd(state, 's1')
    await onTurnStart(state, 's1', 2)
    const second = (await run('sun'))!
    expect(second.turnContext).toContain('RULE=sun')
    expect(second.turnContext).not.toContain('RULE=rain')
    expect(second.standing).toBe(first.standing)
  })

  it.each([
    { label: '关键词动态值与默认初始化', initial: '{{setvar::topic::default}}', dormant: 'default', activated: 'rain',
      entry: { key: ['rain'], content: '{{setvar::topic::{{lastusermessage}}}}', constant: false } },
    { label: '关键词常量与未赋值读取', initial: '', dormant: '', activated: 'wet',
      entry: { key: ['rain'], content: '{{setvar::topic::wet}}', constant: false } },
    { label: '模板条件与默认初始化', initial: '{{setvar::topic::default}}', dormant: 'default', activated: 'wet',
      entry: { key: [], content: '@@if getChatMessage(-1).includes("rain")\n{{setvar::topic::wet}}', constant: true } },
  ])('潜在世界书写入从首轮起隔离，连续三轮不残留旧前缀：$label', async ({ initial, dormant, activated, entry }) => {
    const value = preset([`{{setvar::style::warm}}${initial}`, '', 'RULE={{getvar::derived}}', 'STYLE={{getvar::style}}'])
    value.entries[1] = { ...value.entries[1]!, identifier: Marker.WorldInfoBefore, marker: true, markerId: Marker.WorldInfoBefore }
    const { state, cardId, run } = await story(value)
    await state.saveCharacter(cardId, { characterBook: { entries: [
      { uid: 1, order: 1, ...entry },
      { uid: 2, order: 2, key: [], constant: true, content: '{{setvar::derived::{{getvar::topic}}}}' },
    ] } })
    const standing: string[] = []
    for (const [turn, latest, expected] of [[1, 'calm', dormant], [2, 'rain', activated], [3, 'sun', dormant]] as const) {
      await onTurnStart(state, 's1', turn)
      const result = (await run(latest))!
      standing.push(result.standing)
      expect(result.messages.some(message => message.content === `RULE=${expected}`)).toBe(true)
      expect(result.turnContext).toContain(`RULE=${expected}`)
      expect(result.standing).not.toContain('RULE=')
      expect(result.standing).toContain('STYLE=warm')
      await onTurnEnd(state, 's1')
    }
    expect(standing[1]).toBe(standing[0])
    expect(standing[2]).toBe(standing[0])
  })
})
