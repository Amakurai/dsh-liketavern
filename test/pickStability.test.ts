/** {{pick}} 与旧式宏的真实组装链路：管线按聊天世系提供 pickSeed，分支沿用根会话结果，老卡 <USER>/<BOT> 按身份展开。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { expandMacros } from '../src/core/macros.js'
import type { CharacterCard } from '../src/core/types.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernState } from '../src/node/state.js'
import { importCard } from '../src/state/workspace.js'

const OPTIONS = Array.from({ length: 20 }, (_, i) => `色${i}`).join('::')
const DESCRIPTION = `<BOT>看着<USER>，发色：{{pick::${OPTIONS}}}`
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-pick-'))
  roots.push(root)
  const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  const card: CharacterCard = { spec: 'chara_card_v2', name: 'Alice', description: DESCRIPTION, personality: '', scenario: '', firstMes: '',
    alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '1',
    tags: [], characterBook: null, regexScripts: [], extensions: {}, pngBytes: null, raw: {}, depthPrompt: null }
  const { cardId } = await importCard(paths.characters, card)
  const base = { cardId, cardName: card.name, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() }
  await saveBinding(paths, { ...base, sessionId: 'root' })
  await saveBinding(paths, { ...base, sessionId: 'branch', walLineage: [{ sessionId: 'root', throughTurn: 2 }] })
  await saveBinding(paths, { ...base, sessionId: 'other' })
  return state
}

const standingOf = async (state: TavernState, sessionId: string) =>
  (await runTavernPipeline({ state, sessionId, agent: null, mode: 'preview', historyOverride: [{ role: 'user', content: '你好' }] }))!.standing

it('管线按世系根会话提供聊天身份：分支沿用同一 pick，旧式宏按身份展开', async () => {
  const state = await setup()
  const expected = expandMacros(DESCRIPTION, { char: 'Alice', user: 'User', pickSeed: 'root' })
  expect(expected).toMatch(/^Alice看着User，发色：色\d+$/)
  const root = await standingOf(state, 'root')
  expect(root).toContain(expected)
  expect(await standingOf(state, 'root')).toBe(root)
  expect(await standingOf(state, 'branch')).toContain(expected)
  // 独立会话有自己的聊天身份
  expect(await standingOf(state, 'other')).toContain(expandMacros(DESCRIPTION, { char: 'Alice', user: 'User', pickSeed: 'other' }))
})
