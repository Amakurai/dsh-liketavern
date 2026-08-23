/**
 * 缓存回归守卫（对应 Reasonix 的 cache-guard：缓存命中相关的字节稳定性不许退化）。
 * 覆盖：
 * - 连续两轮 live 组装，standing 字节完全一致（DeepSeek 前缀缓存从第 0 个 token 精确匹配）；
 * - 同轮第 2 步 history 增长（assistant 中间步文本 + 上一轮 runtime context 快照）
 *   不改变本轮 turnContext 快照字节（lastCharMessage/journalText 同轮冻结，宿主按字节去重才不失效）；
 * - standing-safe 常驻条目（constant + probability=0）端到端恒定注入 standing；
 * - 指纹不变时 pinStanding 复用钉死文本（reused=true），资产编辑 bump 修订号后重钉。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { standingFingerprint } from '../src/core/standingPin.js'
import type { CharacterCard } from '../src/core/types.js'
import { saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { importCard } from '../src/state/workspace.js'

let root: string
let paths: TavernPaths
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pipeline-cache-test-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '测试角色',
    description: '描述',
    personality: '',
    scenario: '',
    firstMes: '你好',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    characterVersion: '1',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: {},
    depthPrompt: null,
    ...overrides,
  }
}

const TURN1_HISTORY = [{ role: 'user' as const, content: '苹果好吃吗' }]

describe('缓存字节稳定性守卫', () => {
  it('跨轮 standing 字节一致；同轮两步快照字节一致；常驻条目恒定注入', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    // 常驻条目故意给 probability=0：standing-safe 豁免掷骰，必须恒定出现在 standing 里
    await state.saveLorebook('g1', {
      entries: {
        '1': { uid: 1, key: [], content: 'CONST-LORE', constant: true, probability: 0, useProbability: true },
        '2': { uid: 2, key: ['苹果'], content: 'KW-LORE', constant: false },
      },
    })
    const binding: SessionBinding = {
      sessionId: 's1',
      cardId,
      cardName: '测试角色',
      presetId: null,
      personaId: null,
      lorebookIds: ['g1'],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    }
    await saveBinding(paths, binding)

    const run = (turn: number, history: { role: 'user' | 'assistant'; content: string }[]) => {
      state.currentTurns.set('s1', turn)
      return runTavernPipeline({ state, sessionId: 's1', agent: null, mode: 'live', generationType: 'normal', historyOverride: history })
    }

    // turn 1, step 1
    const t1s1 = await run(1, TURN1_HISTORY)
    expect(t1s1).not.toBeNull()
    // standing-safe 常驻条目豁免概率：probability=0 也进 standing；关键词命中进 turnContext
    expect(t1s1!.standing).toContain('CONST-LORE')
    expect(t1s1!.standing).not.toContain('KW-LORE')
    expect(t1s1!.turnContext).toContain('KW-LORE')

    // turn 1, step 2：history 多出 assistant 中间步文本与上一轮快照（合成 user 文本）
    const t1s2 = await run(1, [
      ...TURN1_HISTORY,
      { role: 'assistant', content: '中间步说了话' },
      { role: 'user', content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nx' },
    ])
    expect(t1s2!.standing).toBe(t1s1!.standing)
    expect(t1s2!.turnContext).toBe(t1s1!.turnContext)

    // turn 2：正常历史增长，standing 字节必须逐字节一致
    const t2s1 = await run(2, [
      ...TURN1_HISTORY,
      { role: 'assistant', content: '好吃' },
      { role: 'user', content: '再来点' },
    ])
    expect(t2s1!.standing).toBe(t1s1!.standing)

    // 钉死：指纹不变 → reused；资产编辑 bump 修订号 → 重钉
    const fp = standingFingerprint(
      { cardId, presetId: null, personaId: null },
      { name: 'User', description: '' },
      state.standingRevTags({ ...binding, cardId }),
      'normal',
    )
    const first = state.pinStanding('s1', 'normal', fp, t1s1!.standing)
    expect(first.reused).toBe(false)
    const second = state.pinStanding('s1', 'normal', fp, 'CHANGED-BYTES')
    expect(second.reused).toBe(true)
    expect(second.text).toBe(t1s1!.standing)
    await state.saveLorebook('g1', { entries: { '1': { uid: 1, key: [], content: 'CONST-LORE-V2', constant: true } } })
    const fp2 = standingFingerprint(
      { cardId, presetId: null, personaId: null },
      { name: 'User', description: '' },
      state.standingRevTags({ ...binding, cardId }),
      'normal',
    )
    expect(fp2).not.toBe(fp)
  })
})
