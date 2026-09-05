/**
 * Prompt 组装管线（纯函数），对齐 SillyTavern Prompt Manager 语义：
 *
 * 1. 输入侧正则（input/send 然后 prompt/assemble）作用于历史副本，不动存储原文。
 * 2. 预设骨架定序：relative 条目按 order 升序置于历史之前；in-chat 条目按
 *    depth 插入历史（depth 0 = 最后一条之后），同深度按 order 升序。
 *    条目带 injection_trigger 时只在当前生成场景（generationType，现有 normal）
 *    命中才纳入序列（对齐 ST shouldTrigger）；ST 对未触发的 main 留空占位是为了
 *    扩展 relative 插入，本插件没有该机制，直接排除。
 * 3. marker 占位替换：chatHistory / worldInfoBefore / worldInfoAfter /
 *    charDescription / charPersonality / scenario / dialogueExamples /
 *    personaDescription / agentMemory（新增）/ worldState（新增）。第三方 ST 预设通常
 *    没有后两种私有 marker，存在动态内容时自动在 chatHistory 前补虚拟 system 注入。
 *    内容 marker（chatHistory/dialogueExamples 之外）放在 in-chat 位置时，解析出的
 *    内容按 depth 注入历史（对齐 ST：系统提示合并时继承 marker 的 injection_*）。
 *    chatHistory / dialogueExamples 在 ST 里只按栈位锚定、in-chat 深度无意义，跳过并记日志。
 * 4. 世界书落位：before/afterCharDefs 经 marker；变化层先参与世界书触发，但统一从
 *    worldState 落位，避免命中后在 worldInfo 与 worldState 重复注入；EM top/bottom 依附
 *    dialogueExamples marker（marker 缺席则记日志丢弃）；AN top 置于历史之前、
 *    AN bottom 置于全序列最末；@D 按 depth/role 插入历史。
 *    世界书：常驻且无本轮宏的进 standing（会话钉死后不随预算抖动）；
 *    关键词命中进 turnContext；含 EJS/STscript 的条目不注入（本插件不执行脚本）。
 * 5. 宏展开（{{char}}/{{user}}/{{description}}/{{persona}}/{{outlet::Name}}/{{setvar}} 等），
 *    outlet 内容来自世界书结果。
 *    卡级 system_prompt / post_history_instructions 里的 {{original}} 引用预设 main /
 *    jailbreak 原文（对齐 ST preparePrompt(prompt, original)）；预设对应槽位
 *    forbid_overrides=true 时卡级覆盖不注入。
 *    历史里的 {{user}}/{{char}} 在正则之前先展开，开场白才能按人设名匹配。
 * 6. Token 预算裁剪：历史永远最后裁（裁最旧的消息）；非历史内容按
 *    agentMemory → worldState → worldInfo → 示例 → 角色定义 的顺序裁。
 *
 * 输出三通道（dsh 不复制 ST「每轮整包塞进 system」）：
 * - `messages`：SillyTavern 语义全量序列（预览/调试）。
 * - `standing`：缓存稳定前缀——角色定义 + 预设骨架 + 常驻世界书 + 静态深度注入（无脚本/记忆/时钟）。
 * - `turnContext`：本轮才变的触发层——关键词世界书、记忆、变化层、AN、本轮宏、触发型 @D。
 * - `system`：standing + turnContext 的合并（预览/兼容旧调用方）。
 * live 路径把 standing 写入 system 段（order 210，在工具说明之后）、
 * turnContext 写入 runtime context；standing 再按会话指纹钉死字节。
 */
import { isSyntheticUserText } from './dshPrompt.js'
import { expandIdentityMacros, expandMacros, hasTurnLocalMacros, hasUnevaluatedScript, type MacroContext } from './macros.js'
import { applyRegexToMessages } from './regex.js'
import { isStandingSafeEntry } from './worldbook.js'
import {
  Marker,
  WIPosition,
  WIRole,
  type ChatMessage,
  type ChatRole,
  type CharacterCard,
  type PresetEntry,
  type PromptPreset,
  type RegexRule,
  type WIActivation,
  type WIEngineResult,
  type WorldDelta,
} from './types.js'

export interface AssembleInput {
  preset: PromptPreset
  card: CharacterCard | null
  /** 当前用户人设描述（空串 = 无）。 */
  personaDescription: string
  /** 会话历史（新的在后），含当前用户输入。 */
  history: ChatMessage[]
  /** 世界书引擎结果（null = 无世界书）。 */
  wi: WIEngineResult | null
  /** BM25 检索到的记忆正文（已排序截断）。 */
  memories: string[]
  /** 生效中的世界状态变化层（调用方过滤 revoked/expires）。 */
  worldDeltas: WorldDelta[]
  /** 会话作者注释（进 turn，不进 standing）。 */
  authorNote?: string
  /** 角色笔记 journal.md（进 turn；调用方已按预算裁过）。 */
  journalText?: string
  macroCtx: MacroContext
  regexRules: RegexRule[]
  /**
   * ST 生成场景（injection_trigger 评估）：normal / continue / impersonate / …。
   * live 轮由 agent 面按 pendingInputs 判定（续写指令 → continue）；impersonate 走 preview。
   * 场景改变序列内容，已并入 standing 钉死指纹与钉位（standingPin.ts，粒度 = 会话 × 场景）。
   */
  generationType?: string
  estimateTokens: (text: string) => number
  /** 总预算：maxTokens = 上下文窗口；reserveForOutput = 为输出保留。 */
  budget: { maxTokens: number; reserveForOutput: number }
}

export interface AssembleLogEntry {
  kind: 'unknown-marker' | 'unknown-macro' | 'dropped-marker-content' | 'dropped-script' | 'auto-marker' | 'regex-error' | 'trim'
  detail: string
}

export interface AssembledPrompt {
  /** ST 语义全量序列（含历史与注入）。 */
  messages: ChatMessage[]
  /** 角色定义 + 预设骨架 + 常驻世界书；不含关键词世界书/记忆/脚本。 */
  standing: string
  /** 本轮世界书命中、检索记忆、变化层、作者注释。 */
  turnContext: string
  /** standing + turnContext（预览与旧调用方）。 */
  system: string
  /** dsh 通道之外的历史（= 输入历史经正则与裁剪后的形态，供预览）。 */
  history: ChatMessage[]
  log: AssembleLogEntry[]
  stats: { tokensBefore: number; tokensAfter: number; trimmedSections: string[] }
}

const WI_ROLE_MAP: Record<WIRole, ChatRole> = {
  [WIRole.System]: 'system',
  [WIRole.User]: 'user',
  [WIRole.Assistant]: 'assistant',
}

function joinContents(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}

/** mes_example 按 <START> 切块（对齐 SillyTavern）。 */
export function splitExampleMessages(mesExample: string): string[] {
  return mesExample
    .split(/<START>/i)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
}

interface DepthInjection {
  depth: number
  order: number
  role: ChatRole
  content: string
  /** 本轮才变（触发型世界书/含本轮宏）= true；静态内容 = false（live 侧进 standing 钉死）。 */
  turn: boolean
}

const CLOCK_FROZEN = { time: '', date: '', datetime: '', weekday: '' } as const

/** 快照尾部「命中但未注入」清单最多列出的条数（超出折叠为「等 N 条」）。 */
const WI_TRUNCATED_HINT_MAX = 8

function joinPromptParts(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}

/** 跳过 dsh runtime-context 快照，避免把每轮变化的 user 消息当成 {{lastusermessage}}。 */
function lastRealUserMessage(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role !== 'user') continue
    if (isSyntheticUserText(m.content)) continue
    return m.content
  }
  return ''
}

/** 最近一条 assistant 消息（{{lastCharMessage}}；assistant 文本无合成快照问题）。 */
function lastRealCharMessage(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role === 'assistant') return m.content
  }
  return ''
}

/**
 * 变化层条目本轮是否进快照渲染：无 keys = 常驻事实；有 keys = 本轮被 WI 引擎命中才注入。
 * 本函数由 assemble（渲染过滤）与 pipeline（进快照预算裁剪）共用，两处判定不得漂移。
 */
export function isDeltaRenderedInTurn(delta: WorldDelta, activatedDeltaIds: ReadonlySet<string>): boolean {
  return delta.keys.length === 0 || activatedDeltaIds.has(delta.id)
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const log: AssembleLogEntry[] = []
  const unknownMacros = new Set<string>()
  const generationType = (input.generationType ?? 'normal').toLowerCase()
  // injection_trigger（对齐 ST shouldTrigger）：空/缺省 = 全场景；否则须含当前场景。
  const triggered = (e: PresetEntry): boolean =>
    (e.injectionTrigger?.length ?? 0) === 0 || e.injectionTrigger!.includes(generationType)
  const macroCtx: MacroContext = {
    ...input.macroCtx,
    // 卡字段/人设/开场白宏：调用方可显式覆盖，缺省从组装输入取
    description: input.macroCtx.description ?? input.card?.description ?? '',
    personality: input.macroCtx.personality ?? input.card?.personality ?? '',
    scenario: input.macroCtx.scenario ?? input.card?.scenario ?? '',
    persona: input.macroCtx.persona ?? input.personaDescription,
    firstMessage: input.macroCtx.firstMessage ?? input.card?.firstMes ?? '',
    lastCharMessage: input.macroCtx.lastCharMessage ?? lastRealCharMessage(input.history),
    outlets: undefined, // outlet 在世界书求值后填充，见下
    store: input.macroCtx.store ?? new Map(),
    lastUserMessage: input.macroCtx.lastUserMessage ?? lastRealUserMessage(input.history),
    onUnknown: (name) => {
      if (!unknownMacros.has(name)) {
        unknownMacros.add(name)
        log.push({ kind: 'unknown-macro', detail: `{{${name}}}` })
      }
    },
  }

  const namedHistory = input.history.map((m) =>
    m.content.includes('{{') ? { ...m, content: expandIdentityMacros(m.content, macroCtx) } : m,
  )

  // ── 1. 输入侧正则（历史副本：先 input/send，再 prompt/assemble） ──────────
  const inputRegex = applyRegexToMessages(
    namedHistory,
    input.regexRules,
    { scope: 'input', timing: 'send' },
    macroCtx,
  )
  const regexRes = applyRegexToMessages(
    inputRegex.messages,
    input.regexRules,
    { scope: 'prompt', timing: 'assemble' },
    macroCtx,
  )
  const sendRegex = applyRegexToMessages(regexRes.messages, input.regexRules, { scope: 'prompt', timing: 'send' }, macroCtx)
  let history: ChatMessage[] = sendRegex.messages
  for (const e of [...inputRegex.errors, ...regexRes.errors, ...sendRegex.errors]) {
    log.push({ kind: 'regex-error', detail: `${e.ruleId}: ${e.message}` })
  }

  // ── 2. 世界书结果分桶 ────────────────────────────────────────────────────
  const wi = input.wi
  const outlets: Record<string, string> = {}
  if (wi) {
    for (const [name, acts] of Object.entries(wi.outlets)) {
      // outlet 内容同样做宏展开（与定位条目一致）；此处 macroCtx.outlets 尚未赋值，
      // 故内容中嵌套的 {{outlet::X}} 不会递归解析（对齐「禁止嵌套 outlet」）。
      outlets[name] = joinContents(
        acts.map((a) => (hasUnevaluatedScript(a.entry.content) ? '' : expandMacros(a.entry.content, macroCtx))),
      )
    }
  }
  macroCtx.outlets = outlets
  // standing 用独立 store：本轮 setvar（含 lastusermessage）不得泄漏进骨架 getvar。
  const turnStore = macroCtx.store ?? new Map<string, string>()
  macroCtx.store = turnStore
  const standingStore = new Map<string, string>()
  const standingCtx: MacroContext = {
    ...macroCtx,
    store: standingStore,
    outlets: {},
    vars: { ...macroCtx.vars, ...CLOCK_FROZEN },
    lastUserMessage: '',
    lastCharMessage: '',
  }
  const expandStanding = (text: string, ctx: MacroContext = standingCtx) => {
    const out = expandMacros(text, ctx)
    for (const [k, v] of standingStore) {
      if (!turnStore.has(k)) turnStore.set(k, v)
    }
    return out
  }
  const expandTurn = (text: string) => expandMacros(text, macroCtx)
  /**
   * turn 侧消息按对象身份追踪，不按内容字节：两条展开后同字节的消息若分属 standing/turn，
   * 按字节匹配会把 standing 那条误踢进每轮重付的 turn 层（前缀缓存白丢）。
   */
  const turnMessages = new Set<ChatMessage>()
  const asTurn = <T extends ChatMessage>(message: T): T => {
    if (message.content.trim()) turnMessages.add(message)
    return message
  }
  const skippedScripts = new Set<string>()
  const memoryPromptMessages = new Set<ChatMessage>()
  const worldStatePromptMessages = new Set<ChatMessage>()
  const worldInfoPromptMessages = new Set<ChatMessage>()
  const examplePromptMessages = new Set<ChatMessage>()
  const characterDefinitionMessages = new Set<ChatMessage>()
  const trackedMessage = (role: ChatRole, content: string, group: Set<ChatMessage>): ChatMessage => {
    const message: ChatMessage = { role, content }
    group.add(message)
    return message
  }
  const skipScript = (label: string, text: string): boolean => {
    if (!hasUnevaluatedScript(text)) return false
    if (!skippedScripts.has(label)) {
      skippedScripts.add(label)
      log.push({ kind: 'dropped-script', detail: `${label} 含未执行 EJS/STscript，已跳过注入` })
    }
    return true
  }

  const wiAt = (pos: WIPosition): WIActivation[] => wi?.byPosition[pos] ?? []
  /**
   * 世界书/记忆在 standing 与快照里默认是裸文本拼接，模型难以识别为「设定事实」。
   * 落消息时统一加来源标签（AN 走 wiText 不加，保留作者注释原始语义与尾部注意力位置）。
   */
  const WI_LABEL_STANDING = '【世界书·常驻】'
  const WI_LABEL_TURN = '【世界书·本轮触发】'
  const labelWi = (text: string, standingSide: boolean): string => `${standingSide ? WI_LABEL_STANDING : WI_LABEL_TURN}\n${text}`
  /** 常驻无脚本进 standing；关键词命中进 turn；EJS 丢弃。 */
  const wiChunks = (pos: WIPosition): { standing: string; turn: string } => {
    const standingParts: string[] = []
    const turnParts: string[] = []
    for (const a of wiAt(pos)) {
      // delta 内容由 worldState marker 统一落位；这里仍保留它参与引擎匹配/递归的结果。
      if (a.entry.source === 'delta') continue
      if (skipScript(`世界书「${a.entry.key}」`, a.entry.content)) continue
      // standing/turn 分流与引擎的预算豁免共用同一判定（isStandingSafeEntry），不得漂移。
      const standingSafe = isStandingSafeEntry(a.entry)
      const text = (standingSafe ? expandStanding(a.entry.content) : expandTurn(a.entry.content)).trim()
      if (!text) continue
      if (standingSafe) standingParts.push(text)
      else turnParts.push(text)
    }
    return { standing: joinContents(standingParts), turn: joinContents(turnParts) }
  }
  const wiMessages = (pos: WIPosition, role: ChatRole): ChatMessage[] => {
    const { standing, turn } = wiChunks(pos)
    const out: ChatMessage[] = []
    if (standing) out.push(trackedMessage(role, labelWi(standing, true), worldInfoPromptMessages))
    if (turn) out.push(asTurn(trackedMessage(role, labelWi(turn, false), worldInfoPromptMessages)))
    return out
  }
  const wiText = (pos: WIPosition): string => {
    const { standing, turn } = wiChunks(pos)
    return joinContents([standing, turn])
  }

  // ── 3. marker 内容解析 ───────────────────────────────────────────────────
  const card = input.card
  const activatedDeltaIds = new Set(
    (wi?.activated ?? []).filter((activation) => activation.entry.source === 'delta').map((activation) => activation.entry.uid),
  )
  const formatDelta = (delta: WorldDelta): string => {
    if (delta.type === 'update') return `【当前状态·更新】${delta.content}`
    if (delta.type === 'invalidate') return `【当前状态·已失效】${delta.content}`
    return delta.content
  }
  const deltaText = joinContents(
    input.worldDeltas
      .filter((delta) => isDeltaRenderedInTurn(delta, activatedDeltaIds))
      .map((delta) => expandTurn(formatDelta(delta))),
  )
  const memoryBodies = joinContents(input.memories.map((m) => expandTurn(m)))
  // 检索记忆同样加来源标签（与世界书标签同一目的：让模型识别为事实层而非叙述）。
  const memoryText = memoryBodies ? `【检索记忆】\n${memoryBodies}` : ''
  // 记忆/变化层永远进 turn：在创建消息处（markerContent / insertFallbackMarkers）按对象标记。

  const markerContent = (id: string, role: ChatRole): ChatMessage[] | null => {
    switch (id) {
      case Marker.ChatHistory:
        return null // 历史由骨架流程特殊处理
      case Marker.WorldInfoBefore:
        return wiMessages(WIPosition.BeforeCharDefs, role)
      case Marker.WorldInfoAfter:
        return wiMessages(WIPosition.AfterCharDefs, role)
      case Marker.CharDescription:
        return card?.description.trim()
          ? [trackedMessage(role, expandStanding(card.description), characterDefinitionMessages)]
          : []
      case Marker.CharPersonality:
        return card?.personality.trim()
          ? [trackedMessage(role, expandStanding(card.personality), characterDefinitionMessages)]
          : []
      case Marker.Scenario:
        return card?.scenario.trim()
          ? [trackedMessage(role, expandStanding(card.scenario), characterDefinitionMessages)]
          : []
      case Marker.DialogueExamples: {
        if (!card) return []
        const blocks = splitExampleMessages(card.mesExample)
        const before = wiChunks(WIPosition.BeforeExampleMessages)
        const after = wiChunks(WIPosition.AfterExampleMessages)
        const out: ChatMessage[] = []
        if (before.standing) out.push(trackedMessage(role, labelWi(before.standing, true), worldInfoPromptMessages))
        if (before.turn) out.push(asTurn(trackedMessage(role, labelWi(before.turn, false), worldInfoPromptMessages)))
        out.push(...blocks.map((b) => trackedMessage(role, expandStanding(b), examplePromptMessages)))
        if (after.standing) out.push(trackedMessage(role, labelWi(after.standing, true), worldInfoPromptMessages))
        if (after.turn) out.push(asTurn(trackedMessage(role, labelWi(after.turn, false), worldInfoPromptMessages)))
        return out
      }
      case Marker.PersonaDescription:
        return input.personaDescription.trim()
          ? [trackedMessage(role, expandStanding(input.personaDescription), characterDefinitionMessages)]
          : []
      case Marker.AgentMemory:
        return memoryText ? [asTurn(trackedMessage(role, memoryText, memoryPromptMessages))] : []
      case Marker.WorldState:
        return deltaText ? [asTurn(trackedMessage(role, deltaText, worldStatePromptMessages))] : []
      default:
        log.push({ kind: 'unknown-marker', detail: id })
        return []
    }
  }

  // EM 依附的 marker 缺席时，其世界书条目无处落位——记日志（对齐 ST 语义：marker 即落位点）
  if (wi) {
    const hasEmMarker = input.preset.entries.some(
      (e) => e.marker && e.markerId === Marker.DialogueExamples && e.enabled && triggered(e),
    )
    if (!hasEmMarker) {
      for (const pos of [WIPosition.BeforeExampleMessages, WIPosition.AfterExampleMessages] as const) {
        for (const a of wiAt(pos)) {
          log.push({ kind: 'dropped-marker-content', detail: `dialogueExamples marker 缺席，丢弃 EM 条目 ${a.entry.key}` })
        }
      }
    }
  }

  // ── 4. relative 骨架（历史之前部分 + 历史之后部分） ──────────────────────
  const relative = input.preset.entries
    .filter((e) => e.enabled && e.position === 'relative' && triggered(e))
    .sort((a, b) => a.order - b.order || a.identifier.localeCompare(b.identifier))
  // 兜底注入按「预设里是否存在该 marker」判定，不限 relative——in-chat 的同名 marker 已有落位。
  const presentMarkerIds = new Set(
    input.preset.entries.filter((e) => e.enabled && e.marker && triggered(e)).map((e) => e.markerId),
  )
  const beforeHistory: ChatMessage[] = []
  const afterHistory: ChatMessage[] = []
  let seenHistory = false
  let insertedFallbackMarkers = false
  const insertFallbackMarkers = () => {
    if (insertedFallbackMarkers) return
    insertedFallbackMarkers = true
    if (memoryText && !presentMarkerIds.has(Marker.AgentMemory)) {
      beforeHistory.push(asTurn(trackedMessage('system', memoryText, memoryPromptMessages)))
      log.push({ kind: 'auto-marker', detail: '预设缺少 agentMemory marker，已在 chatHistory 前自动注入检索记忆' })
    }
    if (deltaText && !presentMarkerIds.has(Marker.WorldState)) {
      beforeHistory.push(asTurn(trackedMessage('system', deltaText, worldStatePromptMessages)))
      log.push({ kind: 'auto-marker', detail: '预设缺少 worldState marker，已在 chatHistory 前自动注入世界状态' })
    }
  }
  for (const entry of relative) {
    if (entry.marker && entry.markerId === Marker.ChatHistory) {
      insertFallbackMarkers()
      seenHistory = true
      continue
    }
    const bucket = seenHistory ? afterHistory : beforeHistory
    if (entry.marker) {
      const content = markerContent(entry.markerId ?? '', entry.role)
      if (content) bucket.push(...content)
      continue
    }
    if (!entry.content.trim()) continue
    if (skipScript(`预设「${entry.identifier}」`, entry.content)) continue
    const turnLocal = hasTurnLocalMacros(entry.content)
    const text = (turnLocal ? expandTurn(entry.content) : expandStanding(entry.content)).trim()
    if (!text) continue // setvar/注释/trim 预处理后为空，不进模型
    const message: ChatMessage = { role: entry.role, content: text }
    if (turnLocal) turnMessages.add(message)
    bucket.push(message)
  }
  // 没有 chatHistory marker 时，组装器仍会在骨架后追加历史；动态私有层紧贴该边界。
  if (!seenHistory) insertFallbackMarkers()
  // 卡片级 system_prompt / post_history_instructions。
  // {{original}} 引用预设 main / jailbreak 原文（对齐 ST preparePrompt(prompt, original)）：
  // 经 vars 注入，只在展开卡级覆盖时可见；原文里的宏随多轮展开正常展开。
  // 预设槽位 forbid_overrides=true 时拒绝卡级覆盖（对齐 ST preparePromptsForChatCompletion）。
  const slotEntry = (identifier: string): PresetEntry | undefined =>
    input.preset.entries.find((e) => e.identifier === identifier && !e.marker && triggered(e))
  const withOriginal = (original: string): MacroContext => ({
    ...standingCtx,
    vars: { ...standingCtx.vars, original },
  })
  const mainEntry = slotEntry('main')
  if (card?.systemPrompt.trim() && mainEntry?.forbidOverrides !== true) {
    beforeHistory.unshift(
      trackedMessage('system', expandStanding(card.systemPrompt, withOriginal(mainEntry?.content ?? '')), characterDefinitionMessages),
    )
  }
  const jailbreakEntry = slotEntry('jailbreak')
  if (card?.postHistoryInstructions.trim() && jailbreakEntry?.forbidOverrides !== true) {
    afterHistory.push(
      trackedMessage('system', expandStanding(card.postHistoryInstructions, withOriginal(jailbreakEntry?.content ?? '')), characterDefinitionMessages),
    )
  }

  // ── 5. 深度注入合并：预设 in-chat 条目 + 世界书 @D ───────────────────────
  const depthInjections: DepthInjection[] = []
  for (const entry of input.preset.entries) {
    if (!entry.enabled || entry.position !== 'in-chat' || !triggered(entry)) continue
    if (entry.marker) {
      const id = entry.markerId ?? ''
      // chatHistory / dialogueExamples 在 ST 里只按栈位锚定，in-chat 深度无意义——跳过并记日志。
      if (id === Marker.ChatHistory || id === Marker.DialogueExamples) {
        log.push({ kind: 'dropped-marker-content', detail: `in-chat 位置的 ${id} marker 无深度锚定语义（ST 按栈位锚定），已跳过` })
        continue
      }
      // 其余内容 marker：对齐 ST「系统提示合并时继承 marker 的 injection_*」，解析内容按 depth 注入。
      // 每条解析结果的 turn 归属随 markerContent 创建时的标记走（静态 marker 内容 = 静态注入）。
      const resolved = markerContent(id, entry.role)
      if (resolved === null || resolved.length === 0) continue
      for (const m of resolved) {
        depthInjections.push({ depth: entry.depth, order: entry.order, role: m.role, content: m.content, turn: turnMessages.has(m) })
      }
      continue
    }
    if (!entry.content.trim()) continue
    if (skipScript(`预设 in-chat「${entry.identifier}」`, entry.content)) continue
    const turnLocal = hasTurnLocalMacros(entry.content)
    const content = (turnLocal ? expandTurn(entry.content) : expandStanding(entry.content)).trim()
    if (!content) continue
    depthInjections.push({ depth: entry.depth, order: entry.order, role: entry.role, content, turn: turnLocal })
  }
  for (const a of wiAt(WIPosition.AtDepth)) {
    if (skipScript(`世界书 @D「${a.entry.key}」`, a.entry.content)) continue
    const stable = isStandingSafeEntry(a.entry)
    const content = (stable ? expandStanding(a.entry.content) : expandTurn(a.entry.content)).trim()
    if (!content) continue
    depthInjections.push({
      depth: a.entry.depth,
      order: a.entry.order,
      role: WI_ROLE_MAP[a.entry.role],
      content,
      turn: !stable, // 确定常驻 @D 进 standing，其它按轮注入
    })
  }
  const depthPrompt = input.card?.depthPrompt
  if (depthPrompt?.prompt.trim()) {
    if (!skipScript('角色 depth_prompt', depthPrompt.prompt)) {
      // 静态 depth_prompt（无本轮宏）进 standing 钉死，不再每轮全价重付。
      const turnLocal = hasTurnLocalMacros(depthPrompt.prompt)
      const content = (turnLocal ? expandTurn(depthPrompt.prompt) : expandStanding(depthPrompt.prompt)).trim()
      if (content) {
        depthInjections.push({
          depth: depthPrompt.depth,
          order: 0,
          role: depthPrompt.role,
          content,
          turn: turnLocal,
        })
      }
    }
  }
  // AN bottom：全序列最末；AN top：历史之前
  const anTop = wiText(WIPosition.AuthorNoteTop)
  if (anTop) beforeHistory.push(asTurn(trackedMessage('system', anTop, worldInfoPromptMessages)))
  const sessionNote = input.authorNote?.trim() ? expandTurn(input.authorNote).trim() : ''
  if (sessionNote) beforeHistory.push(asTurn(trackedMessage('system', `【作者注释】${sessionNote}`, worldInfoPromptMessages)))
  const journalNote = input.journalText?.trim() ? expandTurn(input.journalText).trim() : ''
  if (journalNote) beforeHistory.push(asTurn(trackedMessage('system', `【角色笔记】${journalNote}`, worldInfoPromptMessages)))
  const anBottom = wiText(WIPosition.AuthorNoteBottom)
  const anBottomMessage = anBottom
    ? asTurn(trackedMessage('system', anBottom, worldInfoPromptMessages))
    : null

  if (skippedScripts.size > 0) {
    const note = `（已跳过 ${skippedScripts.size} 条未展开的脚本条目；需要设定细节时用 tavern_lore_read 按 uid/关键词取条。）`
    afterHistory.push(asTurn({ role: 'system', content: note }))
  }

  // 世界书预算截断对模型可见：硬顶从「静默丢信息」变成「分页」——被裁条目以 uid 清单
  // 进快照尾部（turn 侧，体量小且只有发生截断时才出现），模型可按条 lore_read 补读。
  const truncated = wi?.truncated ?? []
  if (truncated.length > 0) {
    const shown = truncated.slice(0, WI_TRUNCATED_HINT_MAX)
    const list = shown.map((t) => (t.label === t.uid ? t.uid : `${t.uid}「${t.label}」`)).join('、')
    const rest = truncated.length - shown.length
    const note = `（本轮世界书有 ${truncated.length} 条命中但因预算未注入：${list}${rest > 0 ? ` 等 ${rest} 条` : ''}；需要正文用 tavern_lore_read 按 uid 取条。）`
    afterHistory.push(asTurn({ role: 'system', content: note }))
  }

  // ── 6. 历史内插入（深 depth 先插，同 depth order 升序） ─────────────────
  const byDepth = new Map<number, DepthInjection[]>()
  for (const inj of depthInjections) {
    if (inj.depth === 0) continue // depth 0 = 历史之后，单独处理
    ;(byDepth.get(inj.depth) ?? byDepth.set(inj.depth, []).get(inj.depth)!).push(inj)
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a)
  for (const depth of depths) {
    const at = Math.max(0, history.length - depth)
    const group = byDepth.get(depth)!.sort((a, b) => a.order - b.order)
    history.splice(at, 0, ...group.map((g) => ({ role: g.role, content: g.content })))
  }
  const depth0 = depthInjections.filter((d) => d.depth === 0).sort((a, b) => a.order - b.order)

  // ── 7. 全量序列与预算裁剪（历史最后裁） ──────────────────────────────────
  const tail: ChatMessage[] = [
    ...depth0.map((d) => {
      const message: ChatMessage = { role: d.role, content: d.content }
      // tail 是新建对象，turn 归属从注入记录显式转标记（身份追踪见 turnMessages）。
      if (d.turn) turnMessages.add(message)
      return message
    }),
    ...(anBottomMessage ? [anBottomMessage] : []),
    ...afterHistory,
  ]
  const liveOutsideHistory = [...beforeHistory, ...tail]
  const estimate = (m: ChatMessage) => input.estimateTokens(m.content)
  const totalBudget = Math.max(0, input.budget.maxTokens - input.budget.reserveForOutput)
  const tokensOf = (msgs: ChatMessage[]) => msgs.reduce((s, m) => s + estimate(m), 0)
  const tokensBefore = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail)
  const trimmedSections: string[] = []

  // 非历史裁剪优先级（先裁动态）：agentMemory → worldState → worldInfo → 角色定义/示例
  const trimNonHistory = (predicate: (m: ChatMessage) => boolean, label: string) => {
    let tokens = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail)
    if (tokens <= totalBudget) return
    for (const bucket of [beforeHistory, tail]) {
      for (let i = bucket.length - 1; i >= 0 && tokens > totalBudget; i--) {
        const m = bucket[i]!
        if (!predicate(m)) continue
        bucket.splice(i, 1)
        tokens -= estimate(m)
        trimmedSections.push(label)
      }
    }
  }
  trimNonHistory((m) => memoryPromptMessages.has(m), 'agentMemory')
  trimNonHistory((m) => worldStatePromptMessages.has(m), 'worldState')
  trimNonHistory((m) => worldInfoPromptMessages.has(m), 'worldInfo')
  trimNonHistory((m) => examplePromptMessages.has(m), 'dialogueExamples')
  trimNonHistory((m) => characterDefinitionMessages.has(m), 'characterDefinitions')
  // 历史裁剪：丢最旧的消息（保留最新用户输入）
  {
    let tokens = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail)
    while (tokens > totalBudget && history.length > 1) {
      const dropped = history.shift()!
      tokens -= estimate(dropped)
      trimmedSections.push('history')
    }
  }

  const messages = [...beforeHistory, ...history, ...tail]
  const tokensAfter = tokensOf(messages)
  for (const label of trimmedSections) log.push({ kind: 'trim', detail: label })

  // ── 8. dsh 通道：standing（稳定前缀）与 turnContext（本轮触发层）分开 ──
  const outsideHistory = liveOutsideHistory
  // 插进历史中间的注入（@D / depth_prompt / 预设 in-chat）预览能看到；live 不能改日志，
  // 静态的（无本轮宏）并入 standing 钉死——字节稳定、命中前缀缓存，不再每轮全价重付；
  // 本轮才变的并入 turn 尾。
  const splicedStanding = depthInjections.filter((d) => d.depth !== 0 && !d.turn).map((d) => d.content)
  const splicedTurn = depthInjections.filter((d) => d.depth !== 0 && d.turn).map((d) => d.content)
  const standing = joinPromptParts([
    ...outsideHistory.filter((m) => !turnMessages.has(m)).map((m) => m.content),
    ...splicedStanding,
  ])
  const turnContext = joinPromptParts([
    ...outsideHistory.filter((m) => turnMessages.has(m)).map((m) => m.content),
    ...splicedTurn,
  ])
  const system = joinPromptParts([standing, turnContext])

  return {
    messages,
    standing,
    turnContext,
    system,
    history,
    log,
    stats: { tokensBefore, tokensAfter, trimmedSections },
  }
}

/** 导出一个最小可用预设（ST 默认骨架 + 本插件 marker）。 */
export function defaultPreset(): PromptPreset {
  const entry = (partial: Partial<PresetEntry> & Pick<PresetEntry, 'identifier' | 'name'>): PresetEntry => ({
    role: 'system',
    enabled: true,
    position: 'relative',
    depth: 4,
    order: 100,
    content: '',
    marker: false,
    ...partial,
  })
  let order = 0
  const next = () => (order += 10)
  return {
    name: 'Tavern 默认预设',
    identifier: 'tavern-default',
    entries: [
      entry({
        identifier: 'main',
        name: 'Main Prompt',
        order: next(),
        content: 'Write {{char}}\'s next reply in a fictional roleplay between {{char}} and {{user}}.',
      }),
      entry({ identifier: Marker.WorldInfoBefore, name: 'World Info (before)', marker: true, markerId: Marker.WorldInfoBefore, order: next() }),
      entry({ identifier: Marker.PersonaDescription, name: 'Persona Description', marker: true, markerId: Marker.PersonaDescription, order: next() }),
      entry({ identifier: Marker.CharDescription, name: 'Char Description', marker: true, markerId: Marker.CharDescription, order: next() }),
      entry({ identifier: Marker.CharPersonality, name: 'Char Personality', marker: true, markerId: Marker.CharPersonality, order: next() }),
      entry({ identifier: Marker.Scenario, name: 'Scenario', marker: true, markerId: Marker.Scenario, order: next() }),
      entry({ identifier: Marker.AgentMemory, name: '检索记忆', marker: true, markerId: Marker.AgentMemory, order: next() }),
      entry({ identifier: Marker.WorldState, name: '世界状态变化层', marker: true, markerId: Marker.WorldState, order: next() }),
      entry({ identifier: 'nsfw', name: 'Auxiliary Prompt', order: next(), content: '' }),
      entry({ identifier: Marker.WorldInfoAfter, name: 'World Info (after)', marker: true, markerId: Marker.WorldInfoAfter, order: next() }),
      entry({ identifier: Marker.DialogueExamples, name: 'Dialogue Examples', marker: true, markerId: Marker.DialogueExamples, order: next() }),
      entry({ identifier: Marker.ChatHistory, name: 'Chat History', marker: true, markerId: Marker.ChatHistory, order: next() }),
      entry({ identifier: 'jailbreak', name: 'Post-History Instructions', order: next(), content: '' }),
    ],
  }
}
