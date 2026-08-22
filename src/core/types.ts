/**
 * dsh-tavern 核心共享类型。
 * 本文件是所有纯函数模块与存储/集成层之间的契约，字段命名尽量对齐 SillyTavern。
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant'

/** 组装与检索共用的最小消息形状。content 为纯文本（多模态块由调用方拍平）。 */
export interface ChatMessage {
  role: ChatRole
  content: string
  /** 消息名前缀（角色名 / 人设名），世界书 includeNames 扫描时使用。 */
  name?: string
}

// ---------------------------------------------------------------------------
// 宏展开
// ---------------------------------------------------------------------------

export interface MacroContext {
  char: string
  user: string
  /** outlet 名 → 已渲染内容；缺失的 outlet 替换为空串。 */
  outlets?: Readonly<Record<string, string>>
  /** 额外变量（如 time/date 已由调用方给定时）。 */
  vars?: Readonly<Record<string, string>>
  /**
   * {{random}} / {{pick}} 的随机源。缺省 Math.random。
   * 同一 turn 多步组装应传入同一种子生成的新流，避免每步重抽。
   */
  random?: () => number
  /**
   * 会话级变量表（{{setvar}}/{{getvar}}）。一次 assemble 内共享、可变。
   * 未提供时 expandMacros 自建临时表（单次调用内 set+get 仍生效）。
   */
  store?: Map<string, string>
  /** {{lastusermessage}} / {{lastMessage}}；缺省空串。 */
  lastUserMessage?: string
  /** {{lastCharMessage}}：最近一条 assistant 消息；本轮宏，standing 上下文恒为空。 */
  lastCharMessage?: string
  /** {{description}}：角色描述；缺省空串。 */
  description?: string
  /** {{personality}}：角色性格；缺省空串。 */
  personality?: string
  /** {{scenario}}：角色场景；缺省空串。 */
  scenario?: string
  /** {{persona}}：当前用户人设描述；缺省空串。 */
  persona?: string
  /** {{charFirstMessage}} / {{firstMessage}}：角色开场白；缺省空串。 */
  firstMessage?: string
  /** 收到未支持宏时回调（用于记日志）；未提供则静默保留原文。 */
  onUnknown?: (name: string) => void
}

// ---------------------------------------------------------------------------
// 正则引擎
// ---------------------------------------------------------------------------

/** 作用域：用户输入 / AI 输出（渲染）/ 发送给模型的文本。 */
export type RegexScope = 'input' | 'output' | 'prompt'
/** 时机：组装前 / 发送前 / 渲染前。 */
export type RegexTiming = 'assemble' | 'send' | 'render'

export interface RegexRule {
  id: string
  name: string
  /** JS 正则源码。允许 `/pattern/flags` 形式带 flags；裸源码 = 区分大小写、只替换首个（对齐 SillyTavern 默认）。 */
  find: string
  /** 替换串，支持 $1..$9 / $<name> 捕获组、`{{match}}`（= $&，整体匹配）与 {{char}}/{{user}} 宏。 */
  replace: string
  enabled: boolean
  scopes: RegexScope[]
  timing: RegexTiming[]
  /** 仅作用于历史中该深度区间的消息（null = 不限）。depth 从 0（最新一条）计。 */
  minDepth: number | null
  maxDepth: number | null
  /** find 中宏展开方式：0=不展开 1=原样代入 2=转义代入（对齐 SillyTavern substituteRegex）。 */
  substituteRegex: 0 | 1 | 2
  /** 来源：用户自建 / 角色卡内嵌 / 预设内嵌。 */
  source: 'user' | 'card' | 'preset'
  /**
   * 只作用于这些消息角色；缺省或空 = 不限。
   * 由 ST placement 推导：1 USER_INPUT → user，2 AI_OUTPUT → assistant。
   */
  roles?: ChatRole[]
  /**
   * ST trimStrings：替换代入捕获组（含 $0/{{match}}）前，从组值里删掉的字面字符串（先宏展开）。
   * 对齐 ST 现行引擎：trim 作用于捕获组值，不是替换后的整体结果。
   */
  trimStrings?: string[]
  /**
   * ST 预设/卡里出现但 ST 引擎未实现的 trimStringsRegex：按 trimStrings 同位置补全——
   * 从捕获组值里删掉这些正则（缺省全局）命中的片段。
   */
  trimStringsRegex?: string[]
}

/** SillyTavern 角色卡内嵌 regex_scripts 的原始形状（导入时归一化为 RegexRule）。 */
export interface CardRegexScript {
  id?: string
  scriptName?: string
  findRegex?: string
  replaceString?: string
  trimStrings?: string[]
  trimStringsRegex?: string[]
  placement?: number[]
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  runOnEdit?: boolean
  substituteRegex?: number
  minDepth?: number | null
  maxDepth?: number | null
}

// ---------------------------------------------------------------------------
// 世界书（World Info）
// ---------------------------------------------------------------------------

/** 次级键选择逻辑。数值与 SillyTavern selectiveLogic 对齐。 */
export const WISelectiveLogic = {
  AndAny: 0,
  NotAll: 1,
  NotAny: 2,
  AndAll: 3,
} as const
export type WISelectiveLogic = (typeof WISelectiveLogic)[keyof typeof WISelectiveLogic]

/** 插入位置。数值与 SillyTavern world_info_position 对齐。 */
export const WIPosition = {
  BeforeCharDefs: 0,
  AfterCharDefs: 1,
  AuthorNoteTop: 2,
  AuthorNoteBottom: 3,
  AtDepth: 4,
  BeforeExampleMessages: 5,
  AfterExampleMessages: 6,
  Outlet: 7,
} as const
export type WIPosition = (typeof WIPosition)[keyof typeof WIPosition]

/** @D 注入的 role。数值与 SillyTavern 对齐：0 system / 1 user / 2 assistant。 */
export const WIRole = { System: 0, User: 1, Assistant: 2 } as const
export type WIRole = (typeof WIRole)[keyof typeof WIRole]

/** 条目来源。多来源合并优先级：Chat > Persona > Character/Global。 */
export type WISource = 'chat' | 'persona' | 'character' | 'global' | 'delta'

/** 归一化后的世界书条目（引擎输入；存储层负责从各来源格式归一化）。 */
export interface WorldInfoEntry {
  /** 全局唯一键：`${source}:${sourceRef}:${uid}`，定时状态与日志以其为键。 */
  key: string
  uid: string
  source: WISource
  /** 所属来源文件/卡片的标识（ delta 层的 ref、日志展示用）。 */
  sourceRef: string
  keys: string[]
  secondaryKeys: string[]
  selective: boolean
  selectiveLogic: WISelectiveLogic
  comment: string
  content: string
  constant: boolean
  enabled: boolean
  order: number
  position: WIPosition
  depth: number
  /** @D role；非 @D 条目忽略。 */
  role: WIRole
  outletName: string
  probability: number
  useProbability: boolean
  /** null = 跟随全局设置。 */
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  scanDepth: number | null
  /** Non-recursable：不可被递归激活（仅直接命中可激活）。 */
  excludeRecursion: boolean
  /** Prevent further recursion：本条目激活后，其内容不再触发他人（不进入后续递归扫描输入）。 */
  preventRecursion: boolean
  /** Delay until recursion：递归层级达到该值才可激活（0 = 首轮即可，对齐 SillyTavern）。 */
  delayUntilRecursion: number
  sticky: number | null
  cooldown: number | null
  delay: number | null
  /** 预算耗尽时不被丢弃（对齐 SillyTavern ignoreBudget）。 */
  ignoreBudget: boolean
  /** 同组只活一条（空串 = 不分组）。sticky 延续占用组时，同组新命中被丢掉。 */
  group: string
  /** 组内加权随机的权重；默认 100。 */
  groupWeight: number
  /** 组内优先：本条命中时压过同组无 override 的条目。 */
  groupOverride: boolean
  automationId: string
  /** delta 层专有：变化类型与指向原书条目的 uid。 */
  deltaType?: 'update' | 'add' | 'invalidate'
  deltaRef?: string | null
}

export interface WorldInfoGlobalSettings {
  /** 扫描深度：从最近 N 条消息内匹配触发键；0 = 只扫递归注入与常驻（对齐 SillyTavern）。 */
  scanDepth: number
  /** Context 预算百分比（相对模型上下文窗口，折算基数 clamp 到 128K 量级，见 turnBudget.ts）。 */
  contextPercent: number
  /**
   * 固定 token 预算；> 0 时为本轮世界书层的绝对上限（优先于 contextPercent，不随历史
   * 长度/窗口缩水）。默认非 0：命中内容走 runtime context 快照，对新请求永远是未缓存
   * 前缀，必须有不随 1M 级窗口膨胀的硬顶；被裁条目由 tavern_lore_read 按条补读。
   * 只计搭快照通道的条目：落 standing 的常驻（constant 且无本轮宏）豁免计费。
   */
  tokenBudget: number
  recursiveScan: boolean
  /** 最大扫描轮数：0 = 不限（仅受预算限制）；1 = 关闭递归；n = 总扫描轮数（含首轮）。 */
  maxRecursionSteps: number
  caseSensitive: boolean
  /** 整词匹配。SillyTavern 出厂默认 true，但对中文匹配不友好——本插件默认 false 并在 UI 提示。 */
  matchWholeWords: boolean
  /** 扫描时把消息名前缀计入文本（兼容 `\x01Name:` 按消息匹配）。 */
  includeNames: boolean
  /** 预算溢出时在日志中告警。 */
  overflowWarning: boolean
  /** 多来源合并策略：0=Sorted Evenly 1=Character Lore First 2=Global Lore First（出厂默认 1，对齐源码）。 */
  characterStrategy: 0 | 1 | 2
  /** 同组按命中键数挑选（否则按 groupWeight 加权随机）。 */
  useGroupScoring: boolean
}

export const DEFAULT_WI_SETTINGS: WorldInfoGlobalSettings = {
  scanDepth: 2,
  contextPercent: 25,
  tokenBudget: 3000,
  recursiveScan: true,
  maxRecursionSteps: 0,
  caseSensitive: false,
  matchWholeWords: false,
  includeNames: true,
  overflowWarning: true,
  characterStrategy: 1,
  useGroupScoring: false,
}

/** 定时效果状态（随会话持久化；swipe/回退时经事务层回滚）。 */
export interface WITimerState {
  /** 条目 key → sticky 剩余消息数（激活后保持 N 条消息，期间跳过概率判定）。 */
  stickyLeft: Record<string, number>
  /** 条目 key → cooldown 剩余消息数（期间不可再激活）。 */
  cooldownLeft: Record<string, number>
}

export const EMPTY_TIMER_STATE: WITimerState = { stickyLeft: {}, cooldownLeft: {} }

export type WIActivationVia = 'constant' | 'keyword' | 'recursion' | 'sticky'

export interface WIActivation {
  entry: WorldInfoEntry
  matchedKeys: string[]
  via: WIActivationVia
  recursionLevel: number
}

export interface WILogEntry {
  kind:
    | 'activated' // 激活
    | 'probability-skip' // 概率过滤
    | 'budget-trim' // 预算截断
    | 'cooldown-skip' // 冷却中
    | 'delay-skip' // 延迟未到
    | 'disabled' // 条目禁用（仅 debug 列出）
    | 'recursion-stop' // 递归被阻断
    | 'budget-overflow' // 溢出警告
    | 'group-skip' // inclusion group 同组未入选
  entryKey: string
  detail: string
}

export interface WIEngineInput {
  entries: WorldInfoEntry[]
  /** 用于扫描的消息，新的在后。 */
  messages: ChatMessage[]
  settings: WorldInfoGlobalSettings
  timerState: WITimerState
  /** 模型上下文窗口 token 数（contextPercent 换算用）。 */
  contextWindowTokens: number
  /** 本轮除世界书外已占用的 token 估算（预算扣减基数）。 */
  reservedTokens: number
  /** token 估算函数（注入以便单测替换）。 */
  estimateTokens: (text: string) => number
  /** 随机源（probability 判定；注入以便单测确定化）。 */
  random?: () => number
  /** 展开键与扫描文本中的 {{user}}/{{char}}。缺省按字面匹配。 */
  macroCtx?: Pick<MacroContext, 'char' | 'user'>
}

/** 本轮命中但因 turn 层预算未注入的条目指针：渲染侧在快照尾部附清单，模型可按 uid 补读。 */
export interface WITruncatedEntry {
  uid: string
  key: string
  /** 注释或首个触发键，供模型判断相关性。 */
  label: string
}

export interface WIEngineResult {
  activated: WIActivation[]
  /** position → 激活条目（已按 order 升序；渲染侧按「越大越靠近上下文末端」落位）。 */
  byPosition: Partial<Record<WIPosition, WIActivation[]>>
  /** outlet 名 → 激活条目。 */
  outlets: Record<string, WIActivation[]>
  log: WILogEntry[]
  /**
   * turn 层预算：只计搭 runtime-context 快照通道的条目；落 standing 的常驻条目
   * （constant 且无本轮宏）豁免计费——它们走钉死的 system 段，命中前缀缓存。
   */
  budget: { limit: number; used: number; overflowed: boolean }
  /** 命中但因预算未注入的条目（不进 activated；快照尾部附清单，见 assemble.ts）。 */
  truncated: WITruncatedEntry[]
  /** 本轮评估后的新定时状态（调用方必须经事务层持久化）。 */
  timerState: WITimerState
}

// ---------------------------------------------------------------------------
// 预设（Prompt Manager）
// ---------------------------------------------------------------------------

export const Marker = {
  ChatHistory: 'chatHistory',
  WorldInfoBefore: 'worldInfoBefore',
  WorldInfoAfter: 'worldInfoAfter',
  CharDescription: 'charDescription',
  CharPersonality: 'charPersonality',
  Scenario: 'scenario',
  DialogueExamples: 'dialogueExamples',
  PersonaDescription: 'personaDescription',
  /** 本插件新增：检索记忆注入点。 */
  AgentMemory: 'agentMemory',
  /** 本插件新增：世界状态变化层注入点。 */
  WorldState: 'worldState',
} as const
export type Marker = (typeof Marker)[keyof typeof Marker]

export interface PresetEntry {
  identifier: string
  name: string
  enabled: boolean
  role: ChatRole
  /** relative = 按 order 置于历史之前；in-chat = 插入历史指定深度。 */
  position: 'relative' | 'in-chat'
  /** in-chat 深度：0 = 最后一条之后。 */
  depth: number
  order: number
  content: string
  marker: boolean
  /** marker=true 时的占位标识；内建 Marker 之外的值渲染为空串并记日志。 */
  markerId?: string
  /**
   * ST forbid_overrides：main/jailbreak 槽位为 true 时拒绝卡级
   * system_prompt / post_history_instructions 覆盖（不注入卡级覆盖）。
   */
  forbidOverrides?: boolean
  /** ST extension 标记：仅随导入/导出往返保留，无运行时语义。 */
  extension?: boolean
  /**
   * ST injection_trigger：触发场景白名单（normal / continue / impersonate / swipe / regenerate / quiet）。
   * 空或缺省 = 全部场景；当前只产生 normal 场景，其余值一律不匹配（条目被排除）。
   */
  injectionTrigger?: string[]
}

export interface PromptPreset {
  name: string
  identifier: string
  entries: PresetEntry[]
  /** 预设内嵌 regex_scripts（ST `extensions.regex_scripts` 原样）。缺省 = 无。 */
  regexScripts?: CardRegexScript[]
}

// ---------------------------------------------------------------------------
// 角色卡（归一化 Character Card V2）
// ---------------------------------------------------------------------------

export interface LorebookFile {
  name?: string
  entries: unknown[] // 原始条目，归一化由 lorebook 模块负责
  raw?: unknown
}

export interface CharacterCard {
  spec: 'chara_card_v2' | 'chara_card_v1' | 'chara_card_v3' | 'unknown'
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  alternateGreetings: string[]
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
  creatorNotes: string
  creator: string
  characterVersion: string
  tags: string[]
  characterBook: LorebookFile | null
  regexScripts: CardRegexScript[]
  extensions: Record<string, unknown>
  /**
   * 角色卡 extensions.depth_prompt：按 depth 插入历史（预览按 ST 插位；
   * live 不能改会话日志，并入 turnContext）。
   */
  depthPrompt: DepthPrompt | null
  /** 解析自 PNG 时为提取出的原始 PNG 字节（头像来源），JSON 导入时为 null。 */
  pngBytes: Uint8Array | null
  raw: unknown
}

/** V2 卡 extensions.depth_prompt。 */
export interface DepthPrompt {
  prompt: string
  depth: number
  role: ChatRole
}

// ---------------------------------------------------------------------------
// 记忆与世界状态
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string
  /** 相对 memory/ 目录的文件名（含 .md）。 */
  file: string
  created: string
  updated: string
  sourceRange: string
  tags: string[]
  keys: string[]
  body: string
  archived: boolean
}

export interface WorldDelta {
  /** 单调递增 id（jsonl 行号语义）。 */
  id: string
  ts: string
  type: 'update' | 'add' | 'invalidate'
  /** 原书条目 uid 或 null。 */
  ref: string | null
  content: string
  keys: string[]
  order: number
  sourceRange: string
  expires: string | null
  /** 已被「单条撤销」标记（不物理删除，保持 WAL 可回滚语义外的人工撤销）。 */
  revoked?: boolean
}

// ---------------------------------------------------------------------------
// 事务层（WAL）
// ---------------------------------------------------------------------------

/** 一条 WAL 记录：对 path 的一次写入前快照。before 为 null 表示文件此前不存在。 */
export interface WalRecord {
  floor: string
  seq: number
  path: string
  /** 写入前内容；null = 文件原本不存在（回滚 = 删除）。 */
  before: string | null
}

// ---------------------------------------------------------------------------
// 采样参数
// ---------------------------------------------------------------------------

export interface SamplingSettings {
  /** 0–2，默认 1（DeepSeek）。 */
  temperature: number
  /** 0–1，默认 1。平台不透传时记入限制项。 */
  topP: number
  maxTokens: number | null
  stop: string[]
  presencePenalty: number
  frequencyPenalty: number
  /**
   * thinking 档位；绑定会话经 agent/request 映射为模型公布的 reasoningEffort。
   * disabled → off；low/high → 模型公布该档时显式指定，未公布回退自动；
   * enabled → 自动（保留会话已选档，否则模型默认）。
   */
  thinking: 'enabled' | 'disabled' | 'low' | 'high'
}

export const DEFAULT_SAMPLING: SamplingSettings = {
  temperature: 1,
  topP: 1,
  maxTokens: null,
  stop: [],
  presencePenalty: 0,
  frequencyPenalty: 0,
  thinking: 'enabled',
}
