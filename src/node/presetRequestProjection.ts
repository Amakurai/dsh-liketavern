/**
 * 预设请求投影：用公开用户消息的来源元数据持久化冻结布局，只在适配器副本中放置插件消息。
 * 宿主历史、附件、工具配对与日志均保持原值；锚点失效时明确拒绝，绝不按正文猜位置或复活压缩历史。
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage, MessageId, type GenerateOptions, type LlmResolvedModelInfo, type Message, type RequestMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-compaction-basic'
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import { BOUND_DISCIPLINE, TURN_PLAYBOOK } from '../core/dshPrompt.js'
import { PromptLayoutSchema, type PromptHistoryAnchor, type PromptLayout, type PromptLayoutEntry } from '../core/promptLayout.js'
import { estimateTokens } from '../core/tokenize.js'

export const PRESET_PLAN_MESSAGE_TEXT = '【Tavern 提示词布局快照】'

export interface PresetRequestPlan {
  version: 1
  sessionId: string
  turn: number
  layout: PromptLayout
  /** 宿主 tavern:standing 的完整已冻结文本，包含 BOUND_DISCIPLINE。 */
  standingText: string
  /** 宿主 tavern:turn 的完整已冻结文本，包含 TURN_PLAYBOOK。 */
  contextText: string
}

export type PresetProjectionDiagnostic = {
  kind: 'compaction-clamp'
  messageId: string
  summaryMessageId: string
} | { kind: 'leading-system-only' } | { kind: 'messages-system-layout' } | {
  kind: 'text-budget'
  beforeTextTokens: number
  afterTextTokens: number
  contextWindow?: number
  reservedOutputTokens: number
  availableTextTokens?: number
  exceedsAvailable: boolean
}

type ProjectionModel = Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'context' | 'defaultMaxTokens'>

export interface PresetProjectionOptions {
  onDiagnostic?: (diagnostic: PresetProjectionDiagnostic) => void
  /** 未提供时只生成逻辑布局；真实适配器必须提供本次 prepareCall 冻结的模型能力。 */
  model?: ProjectionModel
  /** DeepSeek Messages 只允许 user/tool 之后、assistant 之前或请求末尾更新 system。 */
  messagesApi?: boolean
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tavern-prompt-plan': { kind: 'tavern-prompt-plan'; plan: PresetRequestPlan }
  }
}

// 来源元数据会经过磁盘与分支恢复；不能把 TypeScript 类型当作 JSON 校验。
const textSchema = z.string().max(2_000_000)
const planSchema = z.strictObject({ version: z.literal(1), sessionId: z.string().min(1).max(4096), turn: z.number().int().nonnegative(),
  standingText: textSchema.min(1), contextText: textSchema, layout: PromptLayoutSchema })

function parsePlan(value: unknown): PresetRequestPlan {
  const result = planSchema.safeParse(value)
  if (!result.success) throw new Error(`Tavern 提示词布局快照无效：${result.error.issues[0]?.message ?? '未知格式'}`)
  // 分块计数避免先为超量布局分配一整份巨大 JSON 字符串。
  let bytes = Buffer.byteLength(JSON.stringify({ ...result.data, layout: { version: 1, history: [], entries: [] } }))
  for (const item of [...result.data.layout.history, ...result.data.layout.entries]) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1
    if (bytes > 8 * 1024 * 1024) throw new Error('Tavern 提示词布局快照超过 8 MiB 上限')
  }
  if (bytes > 8 * 1024 * 1024) throw new Error('Tavern 提示词布局快照超过 8 MiB 上限')
  return result.data
}

/** 交给 pre-step 的正常接收批次；本函数不写日志、不自行注入或创建模型调用。 */
export function createPresetPlanMessage(plan: PresetRequestPlan): UserMessage {
  return createUserMessage({ source: { kind: 'tavern-prompt-plan', plan: parsePlan(plan) },
    content: [{ type: 'text', text: PRESET_PLAN_MESSAGE_TEXT }] })
}

/** 在宿主已接收的最后一条用户消息附加非正文元数据；不改身份、角色、来源 kind 或任何内容块。 */
export function attachPresetPlanMessage(message: UserMessage, plan: PresetRequestPlan): UserMessage {
  return freezeMessage({ ...message, source: { ...message.source, tavernPromptPlan: parsePlan(plan) } })
}

function planFromMessage(message: Message): PresetRequestPlan | undefined {
  const value = 'tavernPromptPlan' in message.source ? message.source.tavernPromptPlan
    : message.source.kind === 'tavern-prompt-plan' ? message.source.plan : undefined
  if (value === undefined) return undefined
  if (message.role !== 'user') throw new Error('Tavern 提示词布局载体必须是 user/message')
  return parsePlan(value)
}

/** 接收批次及已持久化日志共用的轮次判定；存在但损坏的元数据仍明确失败。 */
export function hasPresetPlanMessage(message: Message, sessionId: string, turn: number): boolean {
  const plan = planFromMessage(message)
  return plan !== undefined && plan.sessionId === sessionId && plan.turn === turn
}

/** 私有布局字段只属于持久化计划；适配器副本保留其余来源字段与原始内容块。 */
function stripPlanMetadata(message: Message): Message {
  if (message.role !== 'user' || !('tavernPromptPlan' in message.source)) return message
  const { tavernPromptPlan: _plan, ...source } = message.source
  return Object.freeze({ ...message, source: Object.freeze(source) })
}

function activeTurn(session: Session): number {
  for (const event of [...session.snapshotEvents()].reverse()) {
    if (event.type === 'turn/end') throw new Error('Tavern 提示词投影没有正在进行的轮次')
    if (event.type === 'turn/start') return event.data.turn
  }
  throw new Error('Tavern 提示词投影缺少 turn/start')
}

function currentPlan(messages: readonly Message[], session: Session): { plan: PresetRequestPlan; carrier: UserMessage } {
  const turn = activeTurn(session)
  const candidates: Message[] = [...messages].reverse()
  for (const event of [...session.snapshotEvents()].reverse()) {
    if (event.type === 'user/message') candidates.push(event.data)
  }
  for (const message of candidates) {
    const plan = planFromMessage(message)
    if (!plan || plan.sessionId !== session.id || plan.turn !== turn) continue
    return { plan, carrier: message as UserMessage }
  }
  throw new Error(`Tavern 第 ${turn} 轮缺少当前会话的冻结提示词布局；旧轮次计划不能复用，请开启下一轮`)
}

function plainText(message: Message): string {
  if (message.content.some(block => block.type !== 'text')) throw new Error('宿主提示词包含非文本块，不能安全替换 Tavern 段')
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** 只重写宿主声明的段；其它来源、图片、工具与模型 replayState 保留同一 Message 对象。 */
function hostMessages(messages: readonly Message[], plan: PresetRequestPlan): Message[] {
  const systems = messages.filter(message => message.role === 'system'
    && message.source.kind === 'system-prompt')
  const latest = systems.at(-1)
  if (!latest) throw new Error('Tavern 请求缺少宿主完整 system 消息，不能安全投影预设')
  const systemText = plainText(latest)
  const at = systemText.indexOf(plan.standingText)
  if (at < 0 || at !== systemText.lastIndexOf(plan.standingText) || !plan.standingText.includes(BOUND_DISCIPLINE)) {
    throw new Error('Tavern standing 与冻结布局不匹配，不能安全移除旧段；请开启下一轮')
  }
  const cleanedSystem = freezeMessage({ ...latest, content: [{ type: 'text' as const,
    text: systemText.slice(0, at) + BOUND_DISCIPLINE + systemText.slice(at + plan.standingText.length) }] })
  const result: Message[] = [cleanedSystem]
  for (const original of messages) {
    if (original.source.kind === 'tavern-prompt-plan') continue
    const message = stripPlanMetadata(original)
    if (message.role === 'system' && message.source.kind === 'system-prompt') continue
    // runtime-context 的来源声明未由宿主包入口导出；校验真实数据，避免伪造模块类型。
    if (message.role === 'user') {
      const snapshot = z.object({ kind: z.literal('runtime-context'), form: z.literal('snapshot'),
        sections: z.array(z.object({ name: z.string(), text: z.string() })) }).safeParse(message.source)
      if (snapshot.success) {
        const sections = snapshot.data.sections.filter(section => section.name !== 'tavern:turn')
        if (sections.length === snapshot.data.sections.length) { result.push(message); continue }
        const text = joinContextSections(sections)
        if (text) result.push(freezeMessage({ ...message, source: { ...message.source, sections }, content: [{ type: 'text' as const, text }] }))
        continue
      }
    }
    result.push(message)
  }
  return result
}

function pluginMessage(plan: PresetRequestPlan, key: string, role: 'system' | 'user' | 'assistant', content: string): Message {
  const digest = createHash('sha256').update(JSON.stringify([plan.sessionId, plan.turn, key])).digest('hex')
  const fields = { id: MessageId(`tavern-prompt-${digest}`), content: [{ type: 'text' as const, text: content }] }
  // 仅存在于适配器请求副本；不追加 assistant/message，也不伪造模型历史或重放元数据。
  if (role === 'assistant') return freezeMessage({ ...fields, role, source: { kind: 'model', provider: 'tavern-preset', model: 'instruction', tavernProjection: true } })
  if (role === 'system') return freezeMessage({ ...fields, role, source: { kind: 'system-prompt', tavernProjection: true } })
  return freezeMessage({ ...fields, role, source: { kind: 'dsh-tavern', tavernProjection: true } })
}

/** in-history 的每条 system 是完整快照；旧模型只读首条，因此不能直接发送增量 system 片段。 */
function applySystemPolicy(messages: readonly Message[], projection: PresetProjectionOptions): Message[] {
  if (!projection.model) return [...messages]
  const first = messages[0]
  if (!first || first.role !== 'system') throw new Error('Tavern 模型请求缺少首条完整系统提示')
  const systems = messages.filter(message => message.role === 'system')
  const sections: string[] = []
  let accumulatedBytes = 0, emittedBytes = 0
  const complete = (message: Message): Message => {
    const text = plainText(message)
    accumulatedBytes += Buffer.byteLength(text) + (sections.length ? 2 : 0)
    emittedBytes += accumulatedBytes
    // 逐项计数先于拼接，阻止第三方大量深度条目造成二次方输出分配。
    if (emittedBytes > 16 * 1024 * 1024) throw new Error('Tavern 完整系统提示快照累计超过 16 MiB，请减少深度 system 条目')
    sections.push(text)
    return freezeMessage({ ...message, content: [{ type: 'text' as const, text: sections.join('\n\n') }] })
  }
  let incompatiblePosition = false
  if (projection.messagesApi) {
    let previous: Message['role'] | undefined, pending = false
    for (const message of messages) {
      if (message.role === 'system') {
        if (previous !== undefined) {
          pending = true
          if (previous !== 'user' && previous !== 'tool') incompatiblePosition = true
        }
      } else {
        if (pending && message.role !== 'assistant') incompatiblePosition = true
        previous = message.role
        pending = false
      }
    }
  }
  if (incompatiblePosition) projection.onDiagnostic?.({ kind: 'messages-system-layout' })
  if (projection.model.systemPromptUpdate === 'in-history' && !incompatiblePosition) {
    const grouped: Message[] = []
    const isTavernSystem = (message: Message) => message.role === 'system'
      && 'tavernProjection' in message.source && message.source.tavernProjection === true
    for (let index = 0; index < messages.length;) {
      const message = messages[index++]!
      if (!isTavernSystem(message)) { grouped.push(message); continue }
      // 相邻自有 system 中间没有其它消息可改变位置；合成一条后再累计，避免重复整份 SDK。
      // 用组内首条的稳定派生 ID，不跨真实聊天或其它来源的 system，也不改变持久布局。
      const parts = [plainText(message)]
      let bytes = Buffer.byteLength(parts[0]!)
      while (index < messages.length && isTavernSystem(messages[index]!)) {
        const text = plainText(messages[index++]!)
        bytes += Buffer.byteLength(text) + 2
        if (bytes > 16 * 1024 * 1024) throw new Error('Tavern 完整系统提示超过 16 MiB')
        parts.push(text)
      }
      grouped.push(parts.length === 1 ? message : freezeMessage({ ...message,
        content: [{ type: 'text' as const, text: parts.join('\n\n') }] }))
    }
    return grouped.map(message => message.role === 'system' ? complete(message) : message)
  }
  if (systems.length > 1 && !incompatiblePosition) projection.onDiagnostic?.({ kind: 'leading-system-only' })
  // 只构造一次首条完整 system，避免模型忽略中途系统指令；其它角色的相对位置保持不变。
  let bytes = 0
  const parts = systems.map(message => {
    const text = plainText(message)
    bytes += Buffer.byteLength(text) + 2
    if (bytes > 16 * 1024 * 1024) throw new Error('Tavern 完整系统提示超过 16 MiB')
    return text
  })
  return [freezeMessage({ ...first, content: [{ type: 'text' as const, text: parts.join('\n\n') }] }),
    ...messages.filter(message => message.role !== 'system')]
}

/** 只估可见 text 块与旧式 system；图片、工具参数/结果编码及 provider framing 不在此估算内。 */
function requestTextTokens(options: Readonly<GenerateOptions>, messages: readonly RequestMessage[]): number {
  let tokens = options.system ? estimateTokens(options.system) : 0
  for (const message of messages) for (const block of message.content) {
    if (block.type === 'text') tokens += estimateTokens(block.text)
  }
  return tokens
}

interface ToolSpan { start: number; end: number; complete: boolean }

/** 一个 assistant 批次的全部结果都在保护范围内，防止在并行工具结果之间插入提示词。 */
function toolSpans(messages: readonly Message[]): ToolSpan[] {
  const spans: ToolSpan[] = []
  const pending = new Map<string, { span: ToolSpan; remaining: number }>()
  messages.forEach((message, index) => {
    const calls = message.content.filter(block => block.type === 'tool-call')
    if (calls.length) {
      const group = { span: { start: index, end: messages.length, complete: false }, remaining: calls.length }
      spans.push(group.span)
      for (const call of calls) {
        if (pending.has(call.id)) throw new Error('Tavern 请求含重复的未完成工具调用 ID，不能安全定位工具配对')
        pending.set(call.id, group)
      }
    }
    if (message.role === 'tool') {
      const group = pending.get(message.toolCallId)
      if (group) {
        pending.delete(message.toolCallId)
        group.remaining--
        if (group.remaining === 0) { group.span.end = index; group.span.complete = true }
      }
    }
  })
  return spans
}

/** 适配器边界的唯一变换：返回新请求，原请求和 Session 永远不被修改。 */
export function projectPresetRequest(options: Readonly<GenerateOptions>, session: Session, projection: PresetProjectionOptions = {}): GenerateOptions {
  if (options.purpose) return { ...options, messages: [...options.messages] }
  if (!options.sessionId || options.sessionId !== session.id) throw new Error('Tavern 请求与会话身份不匹配')
  const requestMessages = options.messages.map(message => {
    if (message.id === undefined || message.source === undefined) throw new Error('Tavern 普通聊天请求缺少持久消息身份，不能投影预设')
    return message
  })
  const { plan, carrier } = currentPlan(requestMessages, session)
  const entries = plan.layout.entries
  if (entries.some(entry => entry.compatibilityFallback)) throw new Error('Tavern 冻结布局缺少模板精确位置，不能用于真实请求；请修订模板后开启下一轮')
  const messages = hostMessages(requestMessages, plan)
  const positions = new Map<string, number>()
  messages.forEach((message, index) => {
    if (positions.has(message.id)) throw new Error('Tavern 请求消息 ID 重复，不能可靠定位历史')
    positions.set(message.id, index)
  })
  const anchors = new Map<number, PromptHistoryAnchor>()
  for (const anchor of plan.layout.history) {
    if (anchors.has(anchor.inputIndex)) throw new Error('Tavern 布局历史 inputIndex 重复')
    anchors.set(anchor.inputIndex, anchor)
  }
  // 只沿宿主真实 surface replacement 的被覆盖集合追踪身份；额外 source 引用不能伪装为替换关系。
  const events = session.snapshotEvents()
  const eventBySeq = new Map(events.map(event => [event.seq, event]))
  const seqByMessageId = new Map<string, SessionSeq>()
  for (const event of events) {
    const message = deriveEventMessage(event)
    if (message) seqByMessageId.set(message.id, event.seq)
  }
  const replacements = new Map<SessionSeq, SessionSeq>()
  for (const replacement of foldSurface(events).replacements) {
    for (const seq of replacement.shadowedSeqs) replacements.set(seq, replacement.seq)
  }
  const surfaceNodes = new Set(session.surface.nodes)
  const reported = new Set<string>()
  const located = new Map<number, { index: number; compacted: boolean }>()
  const locate = (anchor: PromptHistoryAnchor): { index: number; compacted: boolean } => {
    const original = anchors.get(anchor.inputIndex)
    if (!original || original.messageId !== anchor.messageId || original.role !== anchor.role || original.chat !== anchor.chat) {
      throw new Error('Tavern 布局锚点不属于冻结历史')
    }
    const cached = located.get(anchor.inputIndex)
    if (cached) return cached
    const index = anchor.messageId === undefined ? undefined : positions.get(anchor.messageId)
    if (index !== undefined) {
      if (messages[index]?.role !== anchor.role) throw new Error('Tavern 历史锚点角色已变化')
      const result = { index, compacted: false }
      located.set(anchor.inputIndex, result)
      return result
    }
    let seq = anchor.messageId === undefined ? undefined : seqByMessageId.get(anchor.messageId)
    while (seq !== undefined && replacements.has(seq)) {
      const replacementSeq = replacements.get(seq)!
      const event = eventBySeq.get(replacementSeq)
      // 官方压缩检查点来源固定 compact-checkpoint；编辑、删除、任意 producer 的替换不能按摘要放宽。
      if (!event || event.type !== 'user/message' || event.data.source.kind !== 'compact-checkpoint') break
      const summaryIndex = positions.get(event.data.id)
      if (summaryIndex !== undefined && surfaceNodes.has(replacementSeq)) {
        if (!reported.has(anchor.messageId!)) {
          reported.add(anchor.messageId!)
          projection.onDiagnostic?.({ kind: 'compaction-clamp', messageId: anchor.messageId!, summaryMessageId: event.data.id })
        }
        const result = { index: summaryIndex, compacted: true }
        located.set(anchor.inputIndex, result)
        return result
      }
      seq = replacementSeq
    }
    throw new Error('Tavern 历史锚点已缺失且没有合法压缩映射；不会恢复旧正文，请开启下一轮')
  }
  // 载体在首次接收批次末尾：后续工具步骤保留在它之后，尾条绝不重新附到工具结果之后。
  const carrierIndex = requestMessages.findIndex(message => message.id === carrier.id)
  let frontierEnd: number | undefined
  const frontier = (): number => {
    if (frontierEnd !== undefined) return frontierEnd
    if (carrierIndex < 0) throw new Error('Tavern 首次输入边界已被压缩，不能重排本轮尾条；请开启下一轮')
    let end = 1
    for (const message of requestMessages.slice(0, carrierIndex + 1)) {
      const at = positions.get(message.id)
      if (at !== undefined) end = Math.max(end, at + 1)
    }
    frontierEnd = end
    return end
  }
  const spans = toolSpans(messages)
  const safeGaps = { before: new Map<number, number>(), after: new Map<number, number>() }
  const safeGap = (gap: number, side: 'before' | 'after'): number => {
    const cached = safeGaps[side].get(gap)
    if (cached !== undefined) return cached
    let result = gap
    for (const span of spans) {
      if (span.start < result && result <= span.end) {
        if (!span.complete) throw new Error('Tavern 提示词位置穿过未完成的工具调用，拒绝拆开工具配对')
        result = side === 'before' ? span.start : span.end + 1
      }
    }
    safeGaps[side].set(gap, result)
    return result
  }
  const byKey = new Map<string, PromptLayoutEntry>()
  for (const entry of entries) {
    if (byKey.has(entry.key)) throw new Error('Tavern 冻结布局条目 key 重复')
    byKey.set(entry.key, entry)
  }
  const gaps = new Map<string, number>()
  const resolving = new Set<string>()
  const gapFor = (entry: PromptLayoutEntry): number => {
    const cached = gaps.get(entry.key)
    if (cached !== undefined) return cached
    if (resolving.has(entry.key)) throw new Error('Tavern 模板插入位置出现循环引用')
    if (resolving.size >= 512) throw new Error('Tavern 模板插入位置嵌套超过 512 层')
    resolving.add(entry.key)
    const placement = entry.placement
    let gap: number
    switch (placement.kind) {
      case 'entry-relative': {
        const target = byKey.get(placement.entryKey)
        if (!target) throw new Error('Tavern 模板插入目标不存在')
        gap = gapFor(target)
        break
      }
      case 'before-history': gap = placement.anchor ? safeGap(locate(placement.anchor).index, 'before') : 1; break
      case 'after-history': {
        if (placement.anchor) locate(placement.anchor)
        gap = safeGap(frontier(), 'after'); break
      }
      case 'history-relative': gap = safeGap(locate(placement.anchor).index + (placement.side === 'after' ? 1 : 0), placement.side); break
      case 'depth': {
        const previous = placement.previous ? locate(placement.previous) : undefined
        const next = placement.next ? locate(placement.next) : undefined
        if (previous !== undefined && next !== undefined && previous.index >= next.index) {
          if (previous.index !== next.index || !previous.compacted || !next.compacted) throw new Error('Tavern 冻结历史锚点顺序已变化')
          gap = safeGap(next.index + 1, 'after')
        } else gap = next !== undefined ? safeGap(next.index, 'before') : safeGap(frontier(), 'after')
        break
      }
    }
    resolving.delete(entry.key)
    gaps.set(entry.key, gap)
    return gap
  }
  for (const entry of entries) gapFor(entry)
  const slots = new Map<number, Message[]>()
  // 大量条目常共享一个尾部边界；只追加本次投影自有数组，避免反复复制造成平方级分配。
  const append = (gap: number, message: Message) => {
    const slot = slots.get(gap)
    if (slot) slot.push(message)
    else slots.set(gap, [message])
  }
  const firstChat = plan.layout.history.find(anchor => anchor.chat)
  const playbookGap = firstChat ? safeGap(locate(firstChat).index, 'before') : 1
  append(playbookGap, pluginMessage(plan, 'host:turn-playbook', 'system', TURN_PLAYBOOK))
  const before = new Map<string, PromptLayoutEntry[]>(), after = new Map<string, PromptLayoutEntry[]>()
  for (const entry of entries) {
    if (entry.placement.kind !== 'entry-relative') continue
    const target = entry.placement.side === 'before' ? before : after
    const siblings = target.get(entry.placement.entryKey)
    if (siblings) siblings.push(entry)
    else target.set(entry.placement.entryKey, [entry])
  }
  const emit = (entry: PromptLayoutEntry, depth = 0): void => {
    if (depth >= 512) throw new Error('Tavern 模板插入位置嵌套超过 512 层')
    for (const child of before.get(entry.key) ?? []) emit(child, depth + 1)
    if (entry.content.trim()) append(gapFor(entry), pluginMessage(plan, entry.key, entry.role, entry.content))
    for (const child of after.get(entry.key) ?? []) emit(child, depth + 1)
  }
  for (const entry of entries) if (entry.placement.kind !== 'entry-relative') emit(entry)
  const projected: Message[] = []
  for (let index = 0; index <= messages.length; index++) {
    projected.push(...(slots.get(index) ?? []))
    const message = messages[index]
    if (message) projected.push(message)
  }
  const effective = applySystemPolicy(projected, projection)
  if (projection.model) {
    const contextWindow = projection.model.context?.contextWindow
    const reservedOutputTokens = options.maxTokens ?? projection.model.defaultMaxTokens ?? 0
    const availableTextTokens = contextWindow === undefined ? undefined : Math.max(0, contextWindow - reservedOutputTokens)
    const afterTextTokens = requestTextTokens(options, effective)
    projection.onDiagnostic?.({ kind: 'text-budget', beforeTextTokens: requestTextTokens(options, options.messages), afterTextTokens,
      ...(contextWindow === undefined ? {} : { contextWindow, availableTextTokens }), reservedOutputTokens,
      exceedsAvailable: availableTextTokens !== undefined && afterTextTokens > availableTextTokens })
  }
  return { ...options, messages: effective }
}

/** 从当前 SessionStore 读取当前轮日志；注册适配器无需捕获角色资产或可变预设状态。 */
export function createPresetRequestProjector(ctx: Pick<Context, 'sessions'>, projection: Omit<PresetProjectionOptions, 'model'> = {}): {
  project(options: Readonly<GenerateOptions>, model: ProjectionModel): GenerateOptions
} {
  return { project(options, model) {
    if (options.purpose) return { ...options, messages: [...options.messages] }
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : undefined
    if (!session) throw new Error('Tavern 请求找不到当前 Session，不能读取冻结提示词布局')
    return projectPresetRequest(options, session, { ...projection, model, messagesApi: true })
  } }
}
