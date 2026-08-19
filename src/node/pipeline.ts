/**
 * 组装管线：绑定 + 工作区 + 预设 + 世界书/记忆/变化层 + 正则 → AssembledPrompt。
 *
 * 世界书引擎按「每 turn 只评估一次」使用（定时器以消息数为单位，多步 turn 内复用缓存），
 * 只有每轮首次评估（live 模式）才持久化新的定时状态——经 WorkspaceFs 写入，
 * 因而落入当前楼层 WAL，可随回退/swipe 回滚。
 * 每步仍重新组装 standing/turn：长上下文下靠最新 runtime context 快照重放本轮世界书/记忆，
 * 遗忘则按条用工具补读，而不是跳过组装。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import { assemblePrompt, defaultPreset, type AssembledPrompt } from '../core/assemble.js'
import { isSyntheticUserText } from '../core/dshPrompt.js'
import { memorySearchOptions, selectMemoryBodies } from '../core/memoryRetrieval.js'
import { estimateTokens } from '../core/tokenize.js'
import type { ChatMessage, MacroContext, WIEngineResult, WorldDelta, WorldInfoEntry } from '../core/types.js'
import { EMPTY_TIMER_STATE } from '../core/types.js'
import { evaluateWorldInfo } from '../core/worldbook.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { parseLorebook } from '../state/lorebook.js'
import type { TavernState } from './state.js'

const FALLBACK_CONTEXT_WINDOW = 131072
const FALLBACK_RESERVE_OUTPUT = 8192

export interface PipelineInput {
  state: TavernState
  sessionId: string
  /** 会话历史来源；preview 模式可传 null 并给 historyOverride。 */
  agent: Agent | null
  /** 用于解析上下文窗口；缺失或解析失败回退 128K。 */
  llm?: LlmRuntime
  mode: 'live' | 'preview'
  /** preview 且无 live agent 时的历史（纯文本）。 */
  historyOverride?: ChatMessage[]
}

export interface PipelineResult {
  /** 角色定义 + 预设骨架（写入 system 段，绑定不变则字节级稳定）。 */
  standing: string
  /** 本轮世界书/记忆/变化层（写入 runtime context，不进 system 前缀）。 */
  turnContext: string
  /** standing + turnContext（预览用）。 */
  system: string
  /** ST 语义全量序列（预览用）。 */
  messages: ChatMessage[]
  /** 入模历史（经正则与预算裁剪后）。 */
  history: ChatMessage[]
  assembled: AssembledPrompt
  logLines: string[]
  /** 当前 {{user}} 展示名；改名后须打穿 standing 钉死。 */
  userName: string
  personaDescription: string
}

/** deriveMessages 拍平：只取 text 块拼成纯文本；空消息丢弃。 */
export function flattenMessages(messages: readonly Message[], charName: string, userName: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (!text.trim()) continue
    const name = m.role === 'assistant' ? charName : m.role === 'user' ? userName : undefined
    out.push({ role: m.role, content: text, ...(name ? { name } : {}) })
  }
  return out
}

/** 解析模型上下文窗口；任何失败都回退默认值。元数据经 TavernState 进程内缓存，每步调用不重复解析。 */
async function resolveContextWindow(input: PipelineInput): Promise<number> {
  const provider = input.agent?.options.provider
  const model = input.agent?.options.model
  if (!input.llm || !provider || !model) return FALLBACK_CONTEXT_WINDOW
  try {
    const info = await input.state.resolveModelInfoCached(input.llm, provider, model)
    return info.context?.contextWindow ?? FALLBACK_CONTEXT_WINDOW
  } catch {
    return FALLBACK_CONTEXT_WINDOW
  }
}

export async function loadBoundLoreEntries(state: TavernState, binding: NonNullable<Awaited<ReturnType<TavernState['loadBinding']>>>): Promise<{ entries: WorldInfoEntry[]; deltas: WorldDelta[] }> {
  const ws = await state.workspace(binding.cardId)
  const groups: WorldInfoEntry[][] = []

  // 全局世界书
  for (const id of binding.lorebookIds) {
    groups.push(await state.loadLorebookEntries(id, 'global'))
  }
  // 主世界书（Character Lore）：绑定指定库文件 > 卡内嵌书（card.json / assets/character-book.json）
  if (binding.characterLorebookId) {
    groups.push(await state.loadLorebookEntries(binding.characterLorebookId, 'character'))
  } else {
    const embedded = await state.loadCharacterLorebookRaw(binding.cardId)
    if (embedded) groups.push(parseLorebook(embedded.json, { source: 'character', sourceRef: binding.cardId }))
  }
  // 聊天世界书（会话级，存工作区）
  const chatRaw = await ws.fs.readText('assets/chat-lorebook.json')
  if (chatRaw !== null) {
    try {
      groups.push(parseLorebook(JSON.parse(chatRaw), { source: 'chat', sourceRef: 'chat-lorebook' }))
    } catch {
      // 坏文件跳过
    }
  }

  const base = groups.flat()
  // 变化层：ref 的 order 解析先查 character 条目，再查其余
  const deltas = await ws.deltas.list()
  const resolveRefOrder = (ref: string): number | null => {
    const bySource = (source: WorldInfoEntry['source']) => base.find((e) => e.source === source && e.uid === ref)?.order
    return bySource('character') ?? base.find((e) => e.uid === ref)?.order ?? null
  }
  const deltaEntries = ws.deltas.toEngineEntries(deltas, resolveRefOrder)
  return { entries: [...base, ...deltaEntries], deltas }
}

/** 组装一次 Tavern 提示词。绑定缺失或角色不存在时返回 null。 */
export async function runTavernPipeline(input: PipelineInput): Promise<PipelineResult | null> {
  const { state, sessionId } = input
  // turn/start 的监听器异步开 WAL；提示词/工具热路径必须等它完成后才能产生工作区写入。
  await state.waitForSessionTasks(sessionId)
  const binding = await state.loadBinding(sessionId)
  if (!binding) return null
  const charWs = await state.loadCharacter(binding.cardId)
  if (!charWs) return null
  const card = charWs.card
  const ws = await state.workspace(binding.cardId)

  const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset()
  const persona = await state.resolvePersona(binding.personaId)
  const userName = persona?.name ?? DEFAULT_USER_NAME
  const rawHistory = input.agent
    ? flattenMessages(input.agent.session.deriveMessages(), card.name, userName)
    : (input.historyOverride ?? [])
  const history = rawHistory.filter((m) => !(m.role === 'user' && isSyntheticUserText(m.content)))

  // 待入日志的本轮输入：去重（与历史末条相同则视为已入日志）
  const pending = state.pendingInputs.get(sessionId) ?? []
  const lastContent = history.at(-1)?.content
  const pendingFresh = pending.filter((t) => t !== lastContent)
  const scanMessages: ChatMessage[] = [
    ...history,
    ...pendingFresh.map((content) => ({ role: 'user' as const, content, name: userName })),
  ]
  const lastUserMessage = pendingFresh.at(-1) ?? [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const macroCtx: MacroContext = { char: card.name, user: userName, lastUserMessage }

  const config = state.config
  const contextWindow = await resolveContextWindow(input)
  const turn = state.currentTurns.get(sessionId) ?? -1

  // ── WI / 记忆 / 变化层：每 turn 评估一次并缓存 ──
  let wi: WIEngineResult
  let memories: string[]
  let deltas: WorldDelta[]
  const cached = state.wiCache.get(sessionId)
  if (cached && cached.turn === turn) {
    ;({ wi, memories, deltas } = cached)
  } else {
    const { entries, deltas: liveDeltas } = await loadBoundLoreEntries(state, binding)
    deltas = liveDeltas
    const timerState = input.mode === 'live' ? await state.loadTimers(binding.cardId, sessionId) : structuredClone(EMPTY_TIMER_STATE)
    const reservedTokens = estimateTokens(scanMessages.map((m) => m.content).join('\n'))
    wi = evaluateWorldInfo({
      entries,
      messages: scanMessages,
      settings: config.worldInfo,
      timerState,
      contextWindowTokens: contextWindow,
      reservedTokens,
      estimateTokens,
      macroCtx: { char: card.name, user: userName },
    })
    if (input.mode === 'live') {
      await state.saveTimers(binding.cardId, sessionId, wi.timerState)
    }

    // 记忆检索：本轮输入 + 最近 N 条历史做查询
    const queryMessages = [pendingFresh.join('\n'), ...scanMessages.slice(-config.memory.queryMessages).map((m) => m.content)]
      .filter((t) => t.trim())
      .join('\n')
    memories = []
    if (queryMessages.trim()) {
      const hits = await ws.memory.search(
        queryMessages,
        memorySearchOptions(config.memory.retrievalTopK, config.memory.halfLifeDays),
      )
      memories = selectMemoryBodies(hits, config.memory.retrievalTokenBudget)
    }

    state.wiCache.set(sessionId, { turn, wi, memories, deltas })
  }

  const assembled = assemblePrompt({
    preset,
    card,
    personaDescription: persona?.description ?? '',
    history: scanMessages,
    wi,
    memories,
    worldDeltas: deltas,
    macroCtx,
    regexRules: await state.rulesFor(binding),
    estimateTokens,
    budget: {
      maxTokens: contextWindow,
      reserveForOutput: config.sampling.maxTokens ?? FALLBACK_RESERVE_OUTPUT,
    },
  })

  const logLines = formatLogs(wi, assembled)
  state.recordTriggerLog(sessionId, logLines)
  return {
    standing: assembled.standing,
    turnContext: assembled.turnContext,
    system: assembled.system,
    messages: assembled.messages,
    history: assembled.history,
    assembled,
    logLines,
    userName,
    personaDescription: persona?.description ?? '',
  }
}

function formatLogs(wi: WIEngineResult, assembled: AssembledPrompt): string[] {
  const lines: string[] = []
  for (const entry of wi.log) {
    lines.push(`[wi:${entry.kind}] ${entry.entryKey} — ${entry.detail}`)
  }
  lines.push(`[wi:budget] limit=${wi.budget.limit} used=${wi.budget.used}${wi.budget.overflowed ? '（溢出）' : ''}`)
  for (const entry of assembled.log) {
    lines.push(`[assemble:${entry.kind}] ${entry.detail}`)
  }
  const { tokensBefore, tokensAfter, trimmedSections } = assembled.stats
  lines.push(`[assemble:budget] ${tokensBefore} → ${tokensAfter} tokens${trimmedSections.length ? `；裁剪：${trimmedSections.join(', ')}` : ''}`)
  return lines
}
