/**
 * 运行时与核心链路真实体验缺陷回归测试（覆盖 #7 P0-1/P1-2/P1-3/P1-4/P2-5/P2-6 与 #6 P1-1/P1-2）：
 * - P0-1: 历史 assistant EJS 不在后续轮次重复执行副作用，sticky 闭包正常递进到期，坏 `<%` 与用户字面 `<%` 不锁死剧情
 * - P1-2: 强制思考模型（仅公布非 off 档位）与空档位列表 `efforts: []` 不发非法 `off` 或陈旧档位，记忆压缩触发 8192 预算
 * - P1-3: 纯文本无模板角色卡走纯 V8 快路径，不产生 `templateReplay` 或空 `state/template.json`，后续启用模板仍无缝落盘
 * - P1-4 + #6 P1-1: 同正文追加/删尾并切 active 正确建分支回滚，前置增删顺移不误建分支；开场白纯切页委托 swipeGreeting 同步标题与计数
 * - #6 P1-2: collectCompleteText 透出错误详情、MISSING_CREDENTIAL 中文指引、stripHarnessIdentity 同时剔除 0.2.2-rc.3 coding agent 身份句
 * - P2-5: `defines.fn()` 与嵌套 `defines.ns.fn()` 保留执行上下文 `this` 绑定且保持 `@@if` 只读守卫
 * - P2-6: `projectPresetRequest` 在 `messagesApi: false` + `in-history` 下合并前导连续 system，不重复发送 HOST-TOOLS
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  LlmRuntime,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveTavernReasoningEffort } from '../src/core/callConfig.js'
import { BOUND_DISCIPLINE, HARNESS_IDENTITY_TEXT, TURN_PLAYBOOK, stripHarnessIdentity } from '../src/core/dshPrompt.js'
import { parseHelperMessageEdits } from '../src/core/helperChatEdits.js'
import type { PromptLayoutEntry } from '../src/core/promptLayout.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import type { CharacterCard } from '../src/core/types.js'
import { collectCompleteText } from '../src/node/collectText.js'
import { resolveConfig } from '../src/node/config.js'
import { getGreetingSwipe } from '../src/node/floors.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'
import { editHelperMessages } from '../src/node/helperChatEdits.js'
import { getHelperSnapshot } from '../src/node/helperRuntime.js'
import { compressMemoryBatch } from '../src/node/memoryMaintenance.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { PRESET_ADAPTER_PROVIDER, registerPresetAdapter } from '../src/node/presetAdapter.js'
import {
  attachPresetPlanMessage,
  createPresetPlanMessage,
  projectPresetRequest,
  type PresetProjectionDiagnostic,
  type PresetRequestPlan,
} from '../src/node/presetRequestProjection.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { MemoryStore } from '../src/state/memory.js'
import { loadTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { importCard } from '../src/state/workspace.js'
import { saveBinding } from '../src/node/bindings.js'

const tempRoots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (tempRoots.length) {
    await rm(tempRoots.pop()!, { recursive: true, force: true })
  }
})

async function makeTempState(prefix: string): Promise<{ root: string; state: TavernState }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  const paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  const state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  return { root, state }
}

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '回归测试卡',
    description: '一位守护灯塔的旅人。',
    personality: '沉静',
    scenario: '雾夜灯塔',
    firstMes: '你好，旅人。',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: '',
    characterVersion: '',
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

function appendNormalAssistant(session: Session, turn: number, text: string): number {
  const ev = session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text }],
      }),
    },
    { surfaceOp: 'append' },
  )
  return ev.seq
}

describe('P0-1: 历史消息 EJS 不重复执行副作用，坏 <% 与用户字面 <% 不锁死剧情', () => {
  it('已提交历史 assistant EJS 跨轮复用求值快照、不重跑副作用，sticky 闭包按轮递进并到期回收', async () => {
    const { state } = await makeTempState('tavern-p0-1-')
    const card = makeCard({
      description:
        '<% if (!getvar("registered")) { let n = 0; activateRegex(/MARKER/g, () => "CLOSURE#" + (++n), { uuid: "reply-closure", message: true, basic: false, sticky: 2 }); setvar("registered", true); } %>灯塔守望者',
    })
    const { cardId } = await importCard(state.paths.characters, card)
    const session = Session.create(SessionId('s-p0-1'))
    await saveBinding(state.paths, {
      sessionId: session.id,
      cardId,
      cardName: card.name,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    const agent = { options: { provider: 'test', model: 'test' }, session } as unknown as Agent

    // 第 1 轮：assistant 回复含 incvar("affinity", 5) 与 sticky MARKER
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮问候' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 1, session)
    await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    const seq1 = appendNormalAssistant(session, 1, '<% incvar("affinity", 5) %>好感度提升！ MARKER')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    const afterTurn1 = await loadTemplateState(ws.fs)
    expect(afterTurn1.variables.message.affinity).toBe(5)
    expect(afterTurn1.outputs[String(seq1)]?.text).toBe('好感度提升！ CLOSURE#1')

    // 第 2 轮：历史里已有 Turn 1 原始 assistant EJS，不能重跑 incvar，且组装模拟历史应复用求值快照
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮继续' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 2, session)
    const plan2 = await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    expect(plan2!.history.some((m) => m.role === 'assistant' && m.content === '好感度提升！ CLOSURE#1')).toBe(true)
    expect(plan2!.history.some((m) => m.content.includes('incvar'))).toBe(false)
    expect((await loadTemplateState(ws.fs)).variables.message.affinity).toBe(5)

    const seq2 = appendNormalAssistant(session, 2, '第二轮回复 MARKER')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    const afterTurn2 = await loadTemplateState(ws.fs)
    expect(afterTurn2.variables.message.affinity).toBe(5)
    expect(afterTurn2.outputs[String(seq2)]?.text).toBe('第二轮回复 CLOSURE#2')

    // 第 3 轮：sticky=2 在第 2 轮结束后归零到期，第 3 轮不再替换 MARKER，且 affinity 仍保持 5
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第三轮验证到期' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 3, session)
    await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    const seq3 = appendNormalAssistant(session, 3, '第三轮回复 MARKER')
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    const afterTurn3 = await loadTemplateState(ws.fs)
    expect(afterTurn3.variables.message.affinity).toBe(5)
    expect(afterTurn3.outputs[String(seq3)]?.text).toBe('第三轮回复 MARKER')
  })

  it('历史降级失败的坏 <% 回复与用户消息字面 <% 不锁死后续轮次', async () => {
    const { state } = await makeTempState('tavern-p0-1-broken-')
    const card = makeCard({ description: '<% incvar("turns") %>轮次=<%- getvar("turns") %>' })
    const { cardId } = await importCard(state.paths.characters, card)
    const session = Session.create(SessionId('s-p0-1-broken'))
    await saveBinding(state.paths, {
      sessionId: session.id,
      cardId,
      cardName: card.name,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    const agent = { options: { provider: 'test', model: 'test' }, session } as unknown as Agent

    // 第 1 轮：assistant 返回语法损坏的 <% 未闭合标签，onTurnEnd 按确定性模板失败降级
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '用户字面 <% throw Error("user must not run") %>' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 1, session)
    const plan1 = await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    expect(plan1?.turnContext).toContain('轮次=1')
    appendNormalAssistant(session, 1, '截断坏模板 <% if (true) { throw Error("broken")')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(onTurnEnd(state, session.id, session)).rejects.toThrow()

    // 第 2 轮：即便历史中同时存在坏 assistant <% 与坏 user <% 文本，下一轮仍正常组装并推进变量
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续聊聊 <% unclosed' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 2, session)
    const plan2 = await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    expect(plan2?.turnContext).toContain('轮次=2')
    expect((await loadTemplateState(ws.fs)).variables.message.turns).toBe(2)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
  })
})

describe('P1-2: 强制思考模型不发非法 off 且空闲维护放宽至 8192，efforts: [] 不泄漏陈旧档位', () => {
  it('compressMemoryBatch 对仅公布 high 的 deepseek-official 强制思考模型不发 reasoningEffort 且放宽 maxTokens=8192', async () => {
    let captured: Record<string, unknown> | undefined
    const llm = {
      resolveModelInfo: vi.fn(async () => ({
        provider: 'deepseek-official',
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        inputModalities: ['text'],
        reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' },
      })),
      stream: vi.fn((options: Record<string, unknown>) => {
        captured = options
        return (async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'text-delta', text: '合并后的简洁记忆。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }),
    } as unknown as LlmRuntime

    const summary = await compressMemoryBatch(llm, 'deepseek-official', 'deepseek-reasoner', ['旧记忆一', '旧记忆二'])
    expect(summary).toBe('合并后的简洁记忆。')
    expect(captured?.reasoningEffort).toBeUndefined()
    expect(captured?.maxTokens).toBe(8192)
    expect(resolveTavernReasoningEffort('disabled', { efforts: [{ id: 'high' }] }, 'high', 'deepseek-official')).toBeUndefined()
    expect(resolveTavernReasoningEffort('enabled', { efforts: [] }, 'high', 'deepseek-official')).toBeUndefined()
  })
})

describe('P1-3: 纯文本无模板角色卡走纯 V8 快路径，不写空 template.json，后续启用模板正常生效', () => {
  it('纯文本卡连续多轮（含用户字面 <%）不生成 templateReplay 或 state/template.json，后续启用模板正常落盘', async () => {
    const { state } = await makeTempState('tavern-p1-3-')
    const card = makeCard({ description: '完全没有 EJS 语法的纯文本角色设定。' })
    const { cardId } = await importCard(state.paths.characters, card)
    const session = Session.create(SessionId('s-p1-3'))
    await saveBinding(state.paths, {
      sessionId: session.id,
      cardId,
      cardName: card.name,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    const agent = { options: { provider: 'test', model: 'test' }, session } as unknown as Agent

    for (let turn = 1; turn <= 3; turn++) {
      session.append('turn/start', { turn })
      const userText = turn === 2 ? '字面讨论 <% if (a) { %> 语法' : `第 ${turn} 轮普通对话`
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }), { surfaceOp: 'append' })
      await onTurnStart(state, session.id, turn, session)
      const plan = await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
      expect(plan).not.toBeNull()
      expect(plan!.templateReplay).toBeUndefined()
      appendNormalAssistant(session, turn, `第 ${turn} 轮纯文本回复`)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      await onTurnEnd(state, session.id, session)
      expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    }

    // 第 4 轮启用模板回复后，messageVariables 与 outputs 正常初始化并持久化
    session.append('turn/start', { turn: 4 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '启用模板' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 4, session)
    await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    const seq4 = appendNormalAssistant(session, 4, '<% setMessageVar("hp", 42) %>生命=<%- getMessageVar("hp") %>')
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    const saved = await loadTemplateState(ws.fs)
    expect(saved.variables.message.hp).toBe(42)
    expect(saved.outputs[String(seq4)]?.text).toBe('生命=42')
    expect(Object.values(saved.messageVariables?.snapshots ?? {}).some((frame) => frame.values.hp === 42)).toBe(true)
  })

  it('0 EJS 纯文本卡首轮回复注册 sticky 闭包时，跨轮续存与到期回收完整生效', async () => {
    const { state } = await makeTempState('tavern-p1-3-sticky-')
    const card = makeCard({ description: '零模板纯文本角色。' })
    const { cardId } = await importCard(state.paths.characters, card)
    const session = Session.create(SessionId('s-p1-3-sticky'))
    await saveBinding(state.paths, {
      sessionId: session.id,
      cardId,
      cardName: card.name,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    const agent = { options: { provider: 'test', model: 'test' }, session } as unknown as Agent

    // 第 1 轮：纯文本卡走快路径，但回复正文注册了 sticky=3 的消息闭包与变量写入
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮' }] }), { surfaceOp: 'append' })
    await onTurnStart(state, session.id, 1, session)
    const plan1 = await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
    expect(plan1?.templateReplay).toBeUndefined()
    const seq1 = appendNormalAssistant(
      session,
      1,
      '<% incvar("affinity", 15); let n = 0; activateRegex(/MARKER/g, () => "CLOSURE#" + (++n), { uuid: "reply-sticky", message: true, basic: false, after: true, sticky: 3 }); %>第一轮 MARKER',
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    const after1 = await loadTemplateState(ws.fs)
    expect(after1.variables.message.affinity).toBe(15)
    expect(after1.outputs[String(seq1)]?.text).toBe('第一轮 CLOSURE#1')
    expect(after1.continuation?.replay).toBeDefined()

    // 第 2 轮与第 3 轮：闭包继续跨轮生效，历史第 1 轮不重跑 incvar
    for (const [turn, expected] of [[2, '第二轮 CLOSURE#2'], [3, '第三轮 CLOSURE#3'], [4, '第四轮 MARKER']] as const) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮` }] }), { surfaceOp: 'append' })
      await onTurnStart(state, session.id, turn, session)
      await runTavernPipeline({ state, sessionId: session.id, agent, mode: 'live' })
      const seq = appendNormalAssistant(session, turn, `第${['', '一', '二', '三', '四'][turn]}轮 MARKER`)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      await onTurnEnd(state, session.id, session)
      const current = await loadTemplateState(ws.fs)
      expect(current.variables.message.affinity).toBe(15)
      expect(current.outputs[String(seq)]?.text).toBe(expected)
      if (turn === 4) {
        expect(current.continuation?.state.regex.message).toEqual([])
        expect(current.continuation?.replay).toBeUndefined()
      }
    }
  })
})

describe('P1-4 & #6 P1-1: editHelperMessages 同正文切页建分支与开场白纯切页委托 swipeGreeting', () => {
  async function makeHelperFixture(mode: 'turns' | 'greeting-only') {
    const { state } = await makeTempState('tavern-helper-fix-')
    const card = makeCard({
      name: '星辰旅人',
      firstMes: '开场白一：灯塔微亮。',
      alternateGreetings: ['开场白二：雾气弥漫。', '开场白三：潮声渐近。'],
    })
    const { cardId } = await importCard(state.paths.characters, card)
    const sessions = new Map<string, Session>()
    const source = Session.create(SessionId('session-parent'))
    source.append('agent-preset/selected', { agentPreset: 'tavern' })
    if (mode === 'greeting-only') {
      for (const ev of greetingTurnEvents(card.firstMes)) {
        // 写入与真实 ensureGreeting 相同的开场白种子
        if (ev.type === 'turn/start') source.append('turn/start', ev.data)
        else if (ev.type === 'step/start') source.append('step/start', ev.data)
        else if (ev.type === 'assistant/message') source.append('assistant/message', ev.data, { surfaceOp: 'append' })
        else if (ev.type === 'step/end') source.append('step/end', ev.data)
        else if (ev.type === 'turn/end') source.append('turn/end', ev.data)
      }
    } else {
      for (let turn = 1; turn <= 2; turn++) {
        source.append('turn/start', { turn })
        source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `user-${turn}` }] }), { surfaceOp: 'append' })
        source.append('step/start', { turn, step: 1 })
        appendNormalAssistant(source, turn, `assistant-${turn}`)
        source.append('step/end', { turn, step: 1 })
        source.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    }
    sessions.set(source.id, source)
    const presets = { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: vi.fn() }
    const ctx = {
      sessions: { get: (id: string) => sessions.get(id) },
      get: (key: string) => (key === 'agentPresets' ? presets : undefined),
      logger: { warn: vi.fn() },
      agents: {
        get: (id: string) => (sessions.has(id) ? { options: { provider: 'test', model: 'test' }, ctx: {} } : undefined),
        withoutInitiator: (fn: () => unknown) => fn(),
        create: async (options: { sessionId: Session['id']; seed: SessionEvent[] }) => {
          sessions.set(options.sessionId, Session.create(options.sessionId, options.seed))
          return { dispose: vi.fn() }
        },
      },
    } as unknown as Context
    await saveBinding(state.paths, {
      sessionId: source.id,
      cardId,
      cardName: card.name,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(source.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    if (mode === 'turns') {
      for (let turn = 1; turn <= 2; turn++) {
        const floor = `${source.id}#t${turn}`
        await ws.wal.beginFloor(floor)
        await new MemoryStore(ws.fs.withFloor(floor)).write({ body: `fact-${turn}` })
        await ws.wal.commitFloor(floor)
      }
    }
    const submitEdit = async (targetSession: Session, edits: unknown) => {
      const msgSeq = targetSession.snapshotEvents().findLast((e) => e.type === 'assistant/message' && e.surfaceOp === 'append')!.seq
      const snapshot = await getHelperSnapshot(ctx, state, targetSession.id, msgSeq)
      const parsed = parseHelperMessageEdits(edits)
      const before = parsed
        .filter((row) => row.data !== undefined || row.extra !== undefined || row.pages !== undefined)
        .map((row) => {
          const target = snapshot.messages.at(row.message_id)!
          return {
            message_id: row.message_id,
            ...(row.data !== undefined ? { data: target.data } : {}),
            ...(row.extra !== undefined ? { extra: target.extra } : {}),
            ...(row.pages !== undefined
              ? { pages: target.swipe ?? { active: 0, pages: [{ message: target.message, data: target.data, extra: target.extra }] } }
              : {}),
          }
        })
      return editHelperMessages(ctx, state, targetSession.id, msgSeq, {
        storyId: snapshot.storyId,
        historyRevision: snapshot.historyRevision,
        edits,
        before,
      })
    }
    return { state, ctx, cardId, source, sessions, submitEdit }
  }

  it('P1-4: 同正文追加或删尾并切换 active 必须创建分支并回滚派生事实，前置增删顺移仍原地保留', async () => {
    const { state, cardId, source, sessions, submitEdit } = await makeHelperFixture('turns')
    const pageA = { message: 'assistant-1', data: {}, extra: {} }
    const pageB = { message: 'alt-B', data: {}, extra: {} }
    const pageX = { message: 'prepended-X', data: {}, extra: {} }

    // 1. 先原地新增未选中页 [A, B], active=0 -> 不建分支
    expect((await submitEdit(source, [{ message_id: 1, pages: { active: 0, pages: [pageA, pageB] } }])).branch).toBeNull()

    // 2. 前置插入未选中页导致顺移 [X, A, B], active=1 -> 纯顺移，不建分支
    expect((await submitEdit(source, [{ message_id: 1, pages: { active: 1, pages: [pageX, pageA, pageB] } }])).branch).toBeNull()

    // 3. 前置删除未选中页导致顺移回 [A, B], active=0 -> 纯顺移，不建分支
    expect((await submitEdit(source, [{ message_id: 1, pages: { active: 0, pages: [pageA, pageB] } }])).branch).toBeNull()

    // 4. 同时追加同正文页并切 active 0 -> 2（[A, B, A], active=2）-> 必须建分支并撤销 turn 1 起事实
    const appendedBranch = await submitEdit(source, [{ message_id: 1, pages: { active: 2, pages: [pageA, pageB, pageA] } }])
    expect(appendedBranch.branch).not.toBeNull()
    const childBinding = (await state.loadBinding(appendedBranch.branch!.childSessionId))!
    expect((await (await state.storyWorkspace(cardId, childBinding.storyId)).memory.list())).toEqual([])

    // 5. 删尾同时切 active（[A, A, B], active=1 -> [A, A], active=0）-> 必须建分支
    const child = sessions.get(appendedBranch.branch!.childSessionId)!
    const child2 = sessions.get((await submitEdit(child, [{ message_id: 1, pages: { active: 1, pages: [pageA, pageA, pageB] } }])).branch!.childSessionId)!
    const trimmedSwitch = await submitEdit(child2, [{ message_id: 1, pages: { active: 0, pages: [pageA, pageA] } }])
    expect(trimmedSwitch.branch).not.toBeNull()

    // 6. 同时前置插入且改写后缀页（[A, B], active=0 -> [X, A, C], active=1）-> 后缀变化不得误判为纯前置顺移，必须建分支
    const pageC = { message: 'modified-suffix-C', data: {}, extra: {} }
    const suffixMutated = await submitEdit(source, [{ message_id: 1, pages: { active: 1, pages: [pageX, pageA, pageC] } }])
    expect(suffixMutated.branch).not.toBeNull()
  })

  it('#6 P1-1: 开场白纯切页委托 swipeGreetingLocked 同步计数与标题，且在持锁内复核角色开场白变更防 TOCTOU', async () => {
    const { state, ctx, cardId, source, sessions, submitEdit } = await makeHelperFixture('greeting-only')
    const pages = [
      { message: '开场白一：灯塔微亮。', data: {}, extra: {} },
      { message: '开场白二：雾气弥漫。', data: {}, extra: {} },
      { message: '开场白三：潮声渐近。', data: {}, extra: {} },
    ]

    // 模拟交互卡 `/swipe right` 或 `setChatMessages([{ message_id: 0, swipe_id: 1 }])`
    const swipe1 = await submitEdit(source, [{ message_id: 0, message: pages[1]!.message, data: {}, extra: {}, pages: { active: 1, pages } }])
    expect(swipe1.branch).not.toBeNull()
    expect(swipe1.branch!.title).toContain('开场白 2/3')
    expect(swipe1.branch!.title).not.toContain('编辑聊天消息')

    const child1 = sessions.get(swipe1.branch!.childSessionId)!
    const binding1 = (await state.loadBinding(child1.id))!
    expect(binding1.greetingIndex).toBe(1)
    const msg1 = child1.snapshotEvents().find((e) => e.type === 'assistant/message')!
    if (msg1.type !== 'assistant/message') throw new Error('missing greeting')
    expect(await getGreetingSwipe({ ctx, state }, child1.id, msg1.data.message.id)).toEqual({
      isGreeting: true,
      started: false,
      swipe: { index: 1, total: 3 },
    })

    // 连续再切一次到 3/3
    const swipe2 = await submitEdit(child1, [{ message_id: 0, message: pages[2]!.message, data: {}, extra: {}, pages: { active: 2, pages } }])
    expect(swipe2.branch!.title).toContain('开场白 3/3')
    expect((await state.loadBinding(swipe2.branch!.childSessionId))?.greetingIndex).toBe(2)

    // 带自定义 data 的切换不是纯开场白 swipe，仍走编辑分支保留 data
    const customPages = pages.map((p, idx) => (idx === 1 ? { ...p, data: { custom: true } } : p))
    const edited = await submitEdit(source, [{ message_id: 0, message: pages[1]!.message, data: { custom: true }, extra: {}, pages: { active: 1, pages: customPages } }])
    expect(edited.branch!.title).toContain('编辑聊天消息')

    // TOCTOU 复核：在获取快照后、进入 swipeGreetingLocked 前角色卡删减开场白，必须明确拒绝而非静默取模切到错误开场白
    const msgSeq = source.snapshotEvents().findLast((e) => e.type === 'assistant/message' && e.surfaceOp === 'append')!.seq
    const snapshot = await getHelperSnapshot(ctx, state, source.id, msgSeq)
    const beforeCount = sessions.size
    await state.saveCharacter(cardId, { alternateGreetings: ['开场白二：雾气弥漫。'] })
    await expect(
      editHelperMessages(ctx, state, source.id, msgSeq, {
        storyId: snapshot.storyId,
        historyRevision: snapshot.historyRevision,
        edits: [{ message_id: 0, message: pages[2]!.message, data: {}, extra: {}, pages: { active: 2, pages } }],
        before: [{ message_id: 0, data: {}, extra: {}, pages: snapshot.messages[0]!.swipe! }],
      }),
    ).rejects.toThrow(/开场白已改变|已被另一卡面修改/)
    expect(sessions.size).toBe(beforeCount)

    // 并发竞态窗口（在 editHelperMessages 内部 CAS 校验通过后、进入 swipeGreetingLocked 前角色卡改写开场白正文）同样拒绝且不创建分支
    const snapshot2 = await getHelperSnapshot(ctx, state, source.id, msgSeq)
    const twoPages = pages.slice(0, 2)
    let injected = false
    const origLoadBinding = state.loadStoryBinding.bind(state)
    const spy = vi.spyOn(state, 'loadStoryBinding').mockImplementation(async (sid, opts) => {
      const loaded = await origLoadBinding(sid, opts)
      // strictRead 仅在 editHelperMessages 全部校验通过、即将进入 swipeGreetingLocked 时调用
      if (!injected && opts?.strictRead) {
        injected = true
        await state.saveCharacter(cardId, { alternateGreetings: ['开场白二：已被并发改写。'] })
      }
      return loaded
    })
    await expect(
      editHelperMessages(ctx, state, source.id, msgSeq, {
        storyId: snapshot2.storyId,
        historyRevision: snapshot2.historyRevision,
        edits: [{ message_id: 0, message: twoPages[1]!.message, data: {}, extra: {}, pages: { active: 1, pages: twoPages } }],
        before: [{ message_id: 0, data: {}, extra: {}, pages: snapshot2.messages[0]!.swipe! }],
      }),
    ).rejects.toThrow(/角色开场白正文已改变/)
    spy.mockRestore()
    expect(sessions.size).toBe(beforeCount)
  })
})

describe('#6 P1-2 & #7 P2-6: 报错透传、本地化缺失凭证、coding agent 身份剔除与非 Messages 前导合并', () => {
  it('collectCompleteText 透出错误帧具体原因与错误码，非错误终止帧保持原文案', async () => {
    const errorStream = (async function* (): AsyncIterable<StreamChunk> {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            kind: 'auth',
            code: 'MISSING_CREDENTIAL',
            message: '未配置 DeepSeek API 密钥',
            retryable: false,
          } as never,
        },
      }
    })()
    await expect(collectCompleteText(errorStream, new AbortController().signal)).rejects.toThrow(
      '模型未正常完成：未配置 DeepSeek API 密钥（MISSING_CREDENTIAL）',
    )

    const lengthStream = (async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'length' } }
    })()
    await expect(collectCompleteText(lengthStream, new AbortController().signal)).rejects.toThrow('模型未正常完成：length')
  })

  it('presetAdapter 缺失凭证返回带明确中文指引与 MISSING_CREDENTIAL 错误码的错误', async () => {
    const ctx = new Context()
    try {
      const llm = new LlmRuntime(ctx)
      ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
      ctx.provide('settings', {
        describe: () => [{ ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'factory', name: 'Factory', contextWindow: 64000, inputModalities: ['text'] }] } }],
      } as never)
      ctx.provide('credentials', { resolve: async () => undefined } as never)
      registerPresetAdapter(ctx, (options) => options).ensureRegistered()
      const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
      const chunks: StreamChunk[] = []
      for await (const chunk of prepared.stream({
        ...prepared.config,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
      })) {
        chunks.push(chunk)
      }
      const last = chunks.at(-1)
      expect(last).toMatchObject({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'MISSING_CREDENTIAL',
            message: expect.stringMatching(/未配置 DeepSeek API 密钥.*DEEPSEEK_API_KEY.*设置 → 模型/),
          },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stripHarnessIdentity 同时移除 harness:identity 与 0.2.2-rc.3 coding agent 身份句，且诊断仅在真实剔除时报告', () => {
    const codingLine = 'You are a coding agent powered by the deepseek-flash model.'
    expect(stripHarnessIdentity(`${codingLine}\n\nHOST-TOOLS`)).toBe('HOST-TOOLS')
    expect(stripHarnessIdentity(`${HARNESS_IDENTITY_TEXT}\n\n${codingLine}\n\nHOST-TOOLS  \n\n\n\nKEEP`)).toBe('HOST-TOOLS  \n\n\n\nKEEP')
    expect(stripHarnessIdentity(`${codingLine}\n\n${HARNESS_IDENTITY_TEXT}\n\nHOST-TOOLS`)).toBe('HOST-TOOLS')
    expect(stripHarnessIdentity(`HEAD\n\n${codingLine}\n\nTAIL`)).toBe('HEAD\n\nTAIL')
    expect(stripHarnessIdentity(`角色台词：${codingLine} 请勿改写。`)).toBe(`角色台词：${codingLine} 请勿改写。`)

    const buildProjection = (hostPrefix: string, hideHarnessIdentity: boolean) => {
      const session = Session.create(SessionId('sess-identity'))
      const standingText = `${BOUND_DISCIPLINE}\n\nSTANDING`
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append(
        'system/message',
        { turn: 1, step: 1, message: createSystemMessage(`${hostPrefix}HOST-TOOLS\n\n${standingText}`, '@deepseek-ai/dsh-system-prompt') },
        { surfaceOp: 'append' },
      )
      const userMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '玩家输入' }] })
      session.append('user/message', userMsg, { surfaceOp: 'append' })
      const plan: PresetRequestPlan = {
        version: 1,
        sessionId: session.id,
        turn: 1,
        standingText,
        contextText: '',
        cleanup: { hideHarnessIdentity },
        layout: {
          version: 1,
          history: [{ inputIndex: 0, messageId: userMsg.id, role: 'user', chat: true }],
          entries: [],
        },
      }
      session.append('user/message', createPresetPlanMessage(plan), { surfaceOp: 'append' })
      const diagnostics: PresetProjectionDiagnostic[] = []
      const out = projectPresetRequest(
        { provider: 'factory', model: 'factory', sessionId: session.id, messages: session.deriveMessages() },
        session,
        { model: { systemPromptUpdate: 'in-history' }, onDiagnostic: (d) => diagnostics.push(d) },
      )
      return { out, diagnostics }
    }

    const stripped = buildProjection(`${HARNESS_IDENTITY_TEXT}\n\n${codingLine}\n\n`, true)
    const sysText = stripped.out.messages[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(sysText).not.toContain(HARNESS_IDENTITY_TEXT)
    expect(sysText).not.toContain('coding agent')
    expect(stripped.diagnostics).toContainEqual({ kind: 'request-cleanup', hideHarnessIdentity: true, droppedWorkspaceInstructions: 0 })

    // 宿主前缀不含任何身份句时，不应误报 hideHarnessIdentity=true
    const noIdentity = buildProjection('', true)
    expect(noIdentity.diagnostics.some((d) => d.kind === 'request-cleanup')).toBe(false)
  })

  it('P2-6: projectPresetRequest 在 messagesApi=false + in-history 下合并前导连续 system，不重复发送 HOST-TOOLS', () => {
    const session = Session.create(SessionId('sess-p2-6'))
    const bigSdk = 'HOST-TOOLS ' + 'S'.repeat(2000)
    const standingText = `${BOUND_DISCIPLINE}\n\nSTANDING`
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage(`${bigSdk}\n\n${standingText}`, '@deepseek-ai/dsh-system-prompt') },
      { surfaceOp: 'append' },
    )
    const userMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] })
    const anchor = { inputIndex: 0, messageId: userMsg.id, role: 'user' as const, chat: true }
    const plan: PresetRequestPlan = {
      version: 1,
      sessionId: session.id,
      turn: 1,
      standingText,
      contextText: TURN_PLAYBOOK,
      layout: {
        version: 1,
        history: [anchor],
        entries: [
          {
            key: 'before-main',
            role: 'system',
            content: 'PRESET-BEFORE',
            sourceKeys: ['before-main'],
            turnLocal: true,
            placement: { kind: 'before-history', anchor },
          } satisfies PromptLayoutEntry,
          {
            key: 'depth-0',
            role: 'system',
            content: 'DEPTH-0',
            sourceKeys: ['depth-0'],
            turnLocal: true,
            placement: { kind: 'depth', depth: 0, order: 10, previous: anchor },
          } satisfies PromptLayoutEntry,
        ],
      },
    }
    session.append('user/message', attachPresetPlanMessage(userMsg, plan), { surfaceOp: 'append' })

    const req: GenerateOptions = {
      provider: 'factory',
      model: 'factory',
      sessionId: session.id,
      messages: session.deriveMessages(),
    }
    for (const messagesApi of [false, undefined] as const) {
      const out = projectPresetRequest(req, session, {
        ...(messagesApi !== undefined ? { messagesApi } : {}),
        model: { systemPromptUpdate: 'in-history', context: { contextWindow: 64000 }, defaultMaxTokens: 1000 },
      })
      const userIdx = out.messages.findIndex((m: Message) => m.id === userMsg.id)
      const leadingSystems = out.messages.slice(0, userIdx).filter((m) => m.role === 'system')
      expect(leadingSystems).toHaveLength(1)
      const text = leadingSystems[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      expect(text.match(/HOST-TOOLS/g)).toHaveLength(1)
      expect(text).toContain('PRESET-BEFORE')
      expect(text).toContain(TURN_PLAYBOOK)
    }
  })
})

describe('P2-5: defines.fn() 与嵌套 defines.ns.fn() 保持上下文 this 绑定与 @@if 只读守卫', () => {
  it('通过 defines 命名空间调用函数保留 this（含 evalTemplate 局部数据），且 @@if 仍拒绝改写 defines', async () => {
    await TemplateSandbox.prepare()
    const ctx: TemplateContext = {
      variables: emptyTemplateScopes(),
      char: 'Alice',
      user: 'Bob',
      card: { name: 'Alice' },
      entries: [],
      presets: [],
      history: [{ role: 'user', content: 'hi' }],
      historyIdentities: [{ messageId: 'm0', hostMessageId: 1, swipeId: 0 }],
      now: 1000,
      seed: 1,
      phase: 'generate',
    }
    const sandbox = await TemplateSandbox.create(ctx)
    try {
      const out = sandbox.render(`<%
        setvar("hp", 77);
        define("readChar", function () { return this.char + ":" + this.getvar("hp"); });
        define("ns.readLocal", function () { return this.label + ":" + this.getvar("hp"); });
        const nested = await evalTemplate("<" + "%- defines.ns.readLocal() %" + ">|<" + "%- ns.readLocal() %" + ">", { label: "SUB" });
      %><%- readChar() %>|<%- defines.readChar() %>|<%- nested %>`)
      expect(out).toBe('Alice:77|Alice:77|SUB:77|SUB:77')
      expect(() => sandbox.condition('((defines.evil = 1), true)')).toThrow(/@@if 条件必须只读/)
      expect(() => sandbox.condition('((delete defines.readChar), true)')).toThrow(/@@if 条件必须只读/)
    } finally {
      sandbox.dispose()
    }
  })
})
