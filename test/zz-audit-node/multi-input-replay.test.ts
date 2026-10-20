/**
 * 修复回归：同一 turn 里有多条 user/message（宿主一步可认领一批输入）时，
 * regenerate 必须按原顺序重放全部用户输入；editUserMessage 必须替换目标条并原样保留其余条。
 * 只重放第一条会让分支静默丢输入。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session as HostSession } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../../src/node/config.js'
import { editUserMessage, regenerate } from '../../src/node/floors.js'
import type { TavernPaths } from '../../src/node/paths.js'
import { TavernState } from '../../src/node/state.js'

let root: string
let state: TavernState
let ctx: Context
let source: HostSession
const followup = vi.fn()
const sessions = new Map<string, HostSession>()
let assistantId = ''

const textOf = (message: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map((block) => block.text).join('\n')

beforeEach(async () => {
  followup.mockReset()
  sessions.clear()
  root = await mkdtemp(join(tmpdir(), 'audit-multi-input-'))
  const paths: TavernPaths = {
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
  const { cardId } = await state.createCharacter('多输入角色')
  await state.saveBinding({
    sessionId: 'source', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString(),
  })

  source = HostSession.create('source' as HostSession['id'])
  source.append('agent-preset/selected', { agentPreset: 'tavern' })
  source.append('turn/start', { turn: 1 })
  source.append('step/start', { turn: 1, step: 1 })
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const assistant = createAssistantMessage({ content: [{ type: 'text', text: '回复' }], source: { provider: 'test', model: 'test' } })
  assistantId = assistant.id
  source.append('assistant/message', {
    turn: 1, step: 1,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    message: assistant,
  }, { surfaceOp: 'append' })
  source.append('step/end', { turn: 1, step: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sessions.set(source.id, source)

  const presets = { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: vi.fn() }
  ctx = {
    sessions: { get: (id: string) => sessions.get(id) },
    agents: {
      get: (id: string) => sessions.has(id) ? { options: { provider: 'test', model: 'test' }, ctx: {}, followup } : undefined,
      withoutInitiator: (fn: () => unknown) => fn(),
      create: async (options: { sessionId: string; seed: SessionEvent[] }) => {
        sessions.set(options.sessionId, HostSession.create(options.sessionId as HostSession['id'], options.seed))
        return { dispose: vi.fn() }
      },
    },
    get: (key: string) => key === 'agentPresets' ? presets : undefined,
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const driven = (): string[] => followup.mock.calls.map((call) => textOf((call[0] as { content: ReadonlyArray<{ type: string; text?: string }> })))

describe('同轮多条用户输入的重放', () => {
  it('regenerate 按原顺序把该 turn 全部用户输入合并成一条重放（宿主每轮只认领一条 followup）', async () => {
    const result = await regenerate({ ctx, state }, source.id, assistantId)
    expect(result.childSessionId).toMatch(/^session-/)
    expect(driven()).toEqual(['第一条\n第二条'])
  })

  it('editUserMessage 替换首条，其余用户输入按原顺序并入同一条', async () => {
    await editUserMessage({ ctx, state }, source.id, assistantId, '改写后的第一条')
    expect(driven()).toEqual(['改写后的第一条\n第二条'])
  })

  it('runtime context 与插件 notice 不重放', async () => {
    const noisy = HostSession.create('noisy' as HostSession['id'])
    noisy.append('agent-preset/selected', { agentPreset: 'tavern' })
    noisy.append('turn/start', { turn: 1 })
    noisy.append('step/start', { turn: 1, step: 1 })
    noisy.append('user/message', createUserMessage({ content: [{ type: 'text', text: '真实输入' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    noisy.append('user/message', createUserMessage({ content: [{ type: 'text', text: '【Tavern 同轮写入】已记下' }], source: { kind: 'dsh-tavern', form: 'notice', summary: '同轮写入确认' } }), { surfaceOp: 'append' })
    noisy.append('user/message', createUserMessage({ content: [{ type: 'text', text: '【Tavern 步骤】收口' }], source: { kind: 'dsh-tavern', form: 'notice', summary: '多步收口提示' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: '回复' }], source: { provider: 'test', model: 'test' } })
    noisy.append('assistant/message', {
      turn: 1, step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      message: assistant,
    }, { surfaceOp: 'append' })
    noisy.append('step/end', { turn: 1, step: 1 })
    noisy.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sessions.set(noisy.id, noisy)
    await state.saveBinding({
      sessionId: noisy.id, cardId: (await state.loadBinding(source.id))!.cardId, presetId: null, personaId: null,
      lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString(),
    })
    await regenerate({ ctx, state }, noisy.id, assistant.id)
    expect(driven()).toEqual(['真实输入'])
  })

  it('单条输入的 turn 行为不变', async () => {
    const single = HostSession.create('single' as HostSession['id'])
    single.append('agent-preset/selected', { agentPreset: 'tavern' })
    single.append('turn/start', { turn: 1 })
    single.append('step/start', { turn: 1, step: 1 })
    single.append('user/message', createUserMessage({ content: [{ type: 'text', text: '唯一' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: '回复' }], source: { provider: 'test', model: 'test' } })
    single.append('assistant/message', {
      turn: 1, step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      message: assistant,
    }, { surfaceOp: 'append' })
    single.append('step/end', { turn: 1, step: 1 })
    single.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sessions.set(single.id, single)
    await state.saveBinding({
      sessionId: single.id, cardId: (await state.loadBinding(source.id))!.cardId, presetId: null, personaId: null,
      lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString(),
    })
    await regenerate({ ctx, state }, single.id, assistant.id)
    expect(driven()).toEqual(['唯一'])
  })
})
