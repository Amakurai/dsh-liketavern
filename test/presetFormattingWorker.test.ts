/** 预设世界书格式在真实 worker 与剧情缓存中的回归：保留来源正文、模板副作用及条件宏写入。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, Marker, type CharacterCard } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { importCard } from '../src/state/workspace.js'

function preset(format: string, main = 'MAIN') {
  const value = defaultPreset()
  value.identifier = 'format-worker'
  value.entries = value.entries.filter(entry => ['main', Marker.WorldInfoBefore, Marker.ChatHistory].includes(entry.identifier))
    .map((entry, order) => ({ ...entry, order, ...(entry.identifier === 'main' ? { content: main } : {}) }))
  value.formatting = { worldInfo: format }
  return value
}

function request(lore: Record<string, unknown>[], format = '<lore>{0}</lore>', main = '<% /* 启用模板来源序列 */ %>MAIN'): ComputeJobs['assemble']['input'] {
  const value = preset(format, main)
  const entries = parseLorebook({ entries: lore.map((entry, index) => ({ uid: index + 1, order: index, constant: true, ...entry })) },
    { source: 'character', sourceRef: 'factory-card' })
  const history = [{ role: 'user' as const, content: 'rain' }]
  return {
    preset: value, card: null, personaDescription: '', history, wi: null, memories: [], worldDeltas: [], regexRules: [],
    macroCtx: { char: 'Alice', user: 'Bob' }, seed: 42, budget: { maxTokens: 100000, reserveForOutput: 0 },
    templates: { variables: emptyTemplateScopes(), char: 'Alice', user: 'Bob', card: {}, entries,
      presets: value.entries, history, now: 1000, seed: 42, phase: 'generate' },
    wiEvaluation: { entries, messages: history, settings: DEFAULT_WI_SETTINGS, timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 100000, reservedTokens: 0, seed: 42 },
  }
}

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('世界书包装保留隔离来源', () => {
  it('其它预设含 EJS 时，纯文本 wi_format 仍保留全部正文和模板副作用', async () => {
    const input = request([
      { content: 'TOWN' },
      { content: '<% incvar("loreRuns") %>COUNT=<%- getvar("loreRuns") %>' },
    ])
    const original = structuredClone(input)
    const result = await isolated('assemble', input)
    expect(result.system).toContain('TOWN')
    expect(result.system).toContain('COUNT=1')
    expect(result.system).toContain('<lore>')
    expect(result.system).not.toContain('{0}')
    expect(result.templateVariables?.message).toMatchObject({ loreRuns: 1 })
    expect(input).toEqual(original)
  })

  it('包装自身包含 EJS 时，包装与正文各执行一次且不留下来源占位', async () => {
    const result = await isolated('assemble', request([
      { content: '<% incvar("loreRuns") %>TOWN' },
    ], '<% incvar("wrapperRuns") %><lore>{0}</lore>', 'MAIN'))
    expect(result.system).toContain('<lore>TOWN</lore>')
    expect(result.system).not.toContain('{0}')
    expect(result.templateVariables?.message).toMatchObject({ loreRuns: 1, wrapperRuns: 1 })
  })

  it('同位置的静态与触发正文分别保留，不因包装来源缓存复用而互相替换', async () => {
    const result = await isolated('assemble', request([
      { content: 'TOWN' },
      { key: ['rain'], constant: false, content: '<% incvar("eventRuns") %>RAIN-EVENT' },
    ]))
    expect(result.system).toContain('<lore>TOWN</lore>')
    expect(result.turnContext).toContain('<lore>RAIN-EVENT</lore>')
    expect(result.templateVariables?.message).toMatchObject({ eventRuns: 1 })
  })

  it('activewi 重组保留同位置新增来源，旧来源的模板副作用不重复执行', async () => {
    const result = await isolated('assemble', request([
      { content: '<% incvar("firstRuns"); await activewi("extra") %>FIRST' },
      { comment: 'extra', key: ['never'], constant: false, content: '<% incvar("extraRuns") %>EXTRA' },
    ]))
    expect(result.system).toContain('FIRST')
    expect(result.system).toContain('EXTRA')
    expect(result.system).not.toContain('{0}')
    expect(result.templateVariables?.message).toMatchObject({ firstRuns: 1, extraRuns: 1 })
  })
})

describe('世界书格式条件副作用的跨轮缓存', () => {
  it('包装尚未执行的首轮也不钉死其变量读取，命中后和再次未命中都使用当轮值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preset-formatting-worker-')); roots.push(root)
    const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
      presets: join(root, 'library', 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
    const state = new TavernState(paths, () => resolveConfig({})); await state.init()
    const card: CharacterCard = { spec: 'chara_card_v2', name: 'Alice', description: '', personality: '', scenario: '', firstMes: '',
      alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '',
      tags: [], characterBook: { entries: [{ uid: 1, key: ['rain'], content: 'TOWN', constant: false }] }, regexScripts: [], extensions: {},
      pngBytes: null, raw: {}, depthPrompt: null }
    const { cardId } = await importCard(paths.characters, card)
    const value = preset('{{setvar::heading::wrapped}}<lore>{0}</lore>', '{{setvar::style::warm}}MAIN')
    const history = value.entries.find(entry => entry.identifier === Marker.ChatHistory)!
    history.order = 4
    value.entries.push({ identifier: 'format-result', name: 'format-result', content: 'RULE={{getvar::heading}}', role: 'system',
      enabled: true, marker: false, order: 2, depth: 4, position: 'relative' },
    { identifier: 'static-result', name: 'static-result', content: 'STYLE={{getvar::style}}', role: 'system',
      enabled: true, marker: false, order: 3, depth: 4, position: 'relative' })
    const presetId = await state.savePreset(value)
    await saveBinding(paths, { sessionId: 'format-session', cardId, cardName: card.name, presetId, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const standings: string[] = []
    for (const [turn, latest, expected] of [[1, 'calm', ''], [2, 'rain', 'wrapped'], [3, 'sun', '']] as const) {
      await onTurnStart(state, 'format-session', turn)
      const result = (await runTavernPipeline({ state, sessionId: 'format-session', agent: null, mode: 'live',
        historyOverride: [{ role: 'user', content: latest }] }))!
      expect(result.messages.some(message => message.content === `RULE=${expected}`)).toBe(true)
      expect(result.turnContext).toContain(`RULE=${expected}`)
      expect(result.standing).not.toContain('RULE=')
      expect(result.standing).toContain('STYLE=warm')
      standings.push(result.standing)
      await onTurnEnd(state, 'format-session')
    }
    expect(standings[1]).toBe(standings[0])
    expect(standings[2]).toBe(standings[0])
  })
})
