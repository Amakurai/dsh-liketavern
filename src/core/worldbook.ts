/**
 * 世界书触发引擎（纯函数），语义对齐 SillyTavern World Info：
 * - 触发键：明文键 + `/regex/flags` 键；大小写敏感、整词匹配全局/条目级覆盖。
 *   键与扫描文本中的 `{{user}}`/`{{char}}` 先展开再匹配（对齐 ST substituteParams）。
 * - 次级键：AND ANY / AND ALL / NOT ANY / NOT ALL（selectiveLogic 0/3/2/1）。
 * - 触发策略：🔵 constant、🟢 关键词；🔗 向量匹配不做（由记忆 BM25 层承担，见 README）。
 * - 递归扫描：excludeRecursion（不可被递归激活）/ preventRecursion（激活后不触发他人）/
 *   delayUntilRecursion（递归层级门槛，0=首轮即可）；maxRecursionSteps 0=仅受预算限制、1=关闭。
 * - 定时效果：sticky / cooldown / delay，按评估轮（每次引擎调用 = 一轮）推进；
 *   swipe/重新生成/回退的回滚由事务层负责（plan 3.11），引擎本身无副作用。
 * - 预算：Context % 或固定 token；截断优先级：constant 优先 → order 从大到小 → 直接命中优先于递归命中；
 *   ignoreBudget 条目豁免。
 * - 多来源合并：Chat > Persona > Character/Global（strategy: 0 evenly / 1 character_first / 2 global_first），
 *   delta 变化层与 character 同级（紧随原书条目之后，由渲染侧标注「当前状态」）。
 */
import { expandIdentityMacros } from './macros.js'
import {
  DEFAULT_WI_SETTINGS,
  WIPosition,
  WISelectiveLogic,
  type ChatMessage,
  type MacroContext,
  type WIActivation,
  type WIEngineInput,
  type WIEngineResult,
  type WILogEntry,
  type WITimerState,
  type WorldInfoEntry,
  type WorldInfoGlobalSettings,
} from './types.js'

const REGEX_KEY_RE = /^\/(.*)\/([a-z]*)$/s

function ident(text: string, ctx?: Pick<MacroContext, 'char' | 'user'>): string {
  return ctx ? expandIdentityMacros(text, ctx) : text
}

/** 单条触发键编译：返回 (text) => boolean。明文键支持整词/大小写选项；/.../ 为 JS 正则键。 */
function compileKey(
  key: string,
  options: { caseSensitive: boolean; matchWholeWords: boolean },
): ((text: string) => boolean) | null {
  const trimmed = key.trim()
  if (!trimmed) return null
  const literal = REGEX_KEY_RE.exec(trimmed)
  if (literal) {
    try {
      const re = new RegExp(literal[1]!, literal[2] ?? '')
      return (text) => re.test(text)
    } catch {
      return null // 非法正则键视为永不命中
    }
  }
  let needle = trimmed
  if (!options.caseSensitive) needle = needle.toLowerCase()
  if (options.matchWholeWords) {
    try {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`\\b${escaped}\\b`, options.caseSensitive ? '' : 'i')
      return (text) => re.test(text)
    } catch {
      return null
    }
  }
  return (text) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle)
}

/** 扫描单元：把消息拍平成可匹配的文本（含名前缀变体）。 */
function scanTexts(
  messages: readonly ChatMessage[],
  includeNames: boolean,
  macroCtx?: Pick<MacroContext, 'char' | 'user'>,
): string[] {
  const out: string[] = []
  for (const msg of messages) {
    const content = ident(msg.content, macroCtx)
    out.push(content)
    if (includeNames && msg.name) {
      out.push(`${msg.name}: ${content}`)
      // 兼容 SillyTavern 的 \x01Name: 前缀匹配
      out.push(`\x01${msg.name}: ${content}`)
    }
  }
  return out
}

interface Candidate {
  entry: WorldInfoEntry
  matchedKeys: string[]
  via: WIActivation['via']
  recursionLevel: number
}

function matchEntry(
  entry: WorldInfoEntry,
  texts: readonly string[],
  settings: WorldInfoGlobalSettings,
  macroCtx?: Pick<MacroContext, 'char' | 'user'>,
): string[] | null {
  const opts = {
    caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
    matchWholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
  }
  const primary = entry.keys
    .map((k) => ({ raw: k, test: compileKey(ident(k, macroCtx), opts) }))
    .filter((k) => k.test !== null)
  const matched: string[] = []
  for (const k of primary) {
    if (texts.some((t) => k.test!(t))) matched.push(k.raw)
  }
  if (matched.length === 0) return null
  if (!entry.selective || entry.secondaryKeys.length === 0) return matched
  const secondary = entry.secondaryKeys
    .map((k) => compileKey(ident(k, macroCtx), opts))
    .filter((t): t is NonNullable<typeof t> => t !== null)
  const hits = secondary.filter((test) => texts.some((t) => test(t))).length
  const ok =
    entry.selectiveLogic === WISelectiveLogic.AndAny
      ? hits > 0
      : entry.selectiveLogic === WISelectiveLogic.AndAll
        ? hits === secondary.length
        : entry.selectiveLogic === WISelectiveLogic.NotAny
          ? hits === 0
          : hits < secondary.length // NotAll
  return ok ? matched : null
}

/** 多来源合并排序权重：tier 小者先插入（越远离上下文末端）。 */
function sourceTier(entry: WorldInfoEntry, strategy: 0 | 1 | 2): number {
  switch (entry.source) {
    case 'chat':
      return 0
    case 'persona':
      return 1
    case 'character':
      return strategy === 0 ? 2 : strategy === 2 ? 3 : 2
    case 'global':
      return strategy === 0 ? 2 : strategy === 2 ? 2 : 3
    case 'delta':
      return strategy === 0 ? 2 : strategy === 2 ? 3 : 2 // delta 与 character 同级
  }
}

/**
 * 求值一轮世界书触发。返回激活条目（按位置分桶）、触发日志与新的定时状态。
 * 纯函数：不修改入参；timerState 的持久化由调用方经事务层完成。
 */
export function evaluateWorldInfo(input: WIEngineInput): WIEngineResult {
  const settings = { ...DEFAULT_WI_SETTINGS, ...input.settings }
  const random = input.random ?? Math.random
  const log: WILogEntry[] = []
  const timer: WITimerState = {
    stickyLeft: { ...input.timerState.stickyLeft },
    cooldownLeft: { ...input.timerState.cooldownLeft },
  }

  // ── 定时效果按轮推进：本轮判定使用上轮剩余值，轮末才扣减（见递归扫描之后）。
  // sticky=N 语义 = 激活后再保持 N 轮（types.ts：「激活后保持 N 条消息」）；
  // 若轮初先扣，sticky=2 只会多维持 1 轮，与文档语义不符。
  const stickyKeysAtStart = new Set(Object.keys(timer.stickyLeft))
  const cooldownKeysAtStart = new Set(Object.keys(timer.cooldownLeft))

  const entries = input.entries.filter((e) => {
    if (!e.enabled) {
      log.push({ kind: 'disabled', entryKey: e.key, detail: e.comment || e.key })
      return false
    }
    return true
  })

  // 扫描文本：scanDepth 0 = 只扫递归与常驻（对齐 ST world_info_depth 0）
  const scanMessages = settings.scanDepth > 0 ? input.messages.slice(-settings.scanDepth) : []
  const baseTexts = scanTexts(scanMessages, settings.includeNames, input.macroCtx)

  const activated: Candidate[] = []
  const activatedKeys = new Set<string>()
  let recursionQueue: Candidate[] = []

  const tryActivate = (entry: WorldInfoEntry, matchedKeys: string[], via: WIActivation['via'], level: number): boolean => {
    if (activatedKeys.has(entry.key)) return false
    // 概率判定（sticky 延续期跳过）
    if (via !== 'sticky' && entry.useProbability && entry.probability < 100) {
      if (random() * 100 >= entry.probability) {
        log.push({ kind: 'probability-skip', entryKey: entry.key, detail: `probability=${entry.probability}` })
        return false
      }
    }
    activated.push({ entry, matchedKeys, via, recursionLevel: level })
    activatedKeys.add(entry.key)
    log.push({
      kind: 'activated',
      entryKey: entry.key,
      detail: `via=${via} level=${level} keys=[${matchedKeys.join(', ')}]`,
    })
    // 定时效果：仅新激活（非 sticky 延续）写入状态；效果期间重复命中不刷新
    if (via !== 'sticky') {
      if (entry.sticky && entry.sticky > 0) timer.stickyLeft[entry.key] = entry.sticky
      // cooldown 与 sticky 串联：sticky 期间 cooldown 一并倒数
      if (entry.cooldown && entry.cooldown > 0) timer.cooldownLeft[entry.key] = entry.cooldown + (entry.sticky ?? 0)
    }
    return true
  }

  const evaluate = (texts: readonly string[], level: number): Candidate[] => {
    const fresh: Candidate[] = []
    for (const entry of entries) {
      if (activatedKeys.has(entry.key)) continue
      // 递归门槛
      if (level > 0 && entry.excludeRecursion) continue
      if (entry.delayUntilRecursion > level) continue
      // sticky 延续：无需命中、跳过概率（须先于 cooldown 判定：cooldown 与 sticky
      // 串联写入时 sticky 期间 cooldown 一并倒数，先判 cooldown 会拦死 sticky 延续）
      if ((timer.stickyLeft[entry.key] ?? 0) > 0) {
        if (tryActivate(entry, [], 'sticky', level)) fresh.push(activated[activated.length - 1]!)
        continue
      }
      // 冷却
      const cooldownLeft = timer.cooldownLeft[entry.key] ?? 0
      if (cooldownLeft > 0) {
        log.push({ kind: 'cooldown-skip', entryKey: entry.key, detail: `剩余 ${cooldownLeft} 轮` })
        continue
      }
      // delay：聊天记录不足 N 条不可激活
      if (entry.delay && entry.delay > 0 && input.messages.length < entry.delay) {
        log.push({ kind: 'delay-skip', entryKey: entry.key, detail: `需要 ${entry.delay} 条消息，当前 ${input.messages.length}` })
        continue
      }
      if (entry.constant) {
        if (tryActivate(entry, [], 'constant', level)) fresh.push(activated[activated.length - 1]!)
        continue
      }
      if (entry.keys.length === 0) continue
      const matched = matchEntry(entry, texts, settings, input.macroCtx)
      if (matched === null) continue
      if (tryActivate(entry, matched, level === 0 ? 'keyword' : 'recursion', level)) {
        fresh.push(activated[activated.length - 1]!)
      }
    }
    return fresh
  }

  // ── 第 0 层：直接扫描 ────────────────────────────────────────────────────
  let level = 0
  recursionQueue = evaluate(baseTexts, 0)

  // ── 递归扫描：新激活条目的内容成为下一轮扫描输入 ─────────────────────────
  const maxSteps = settings.maxRecursionSteps // 0=不限（受条目数与预算收敛）；1=关闭
  while (
    settings.recursiveScan &&
    maxSteps !== 1 &&
    recursionQueue.length > 0 &&
    (maxSteps === 0 || level < maxSteps)
  ) {
    level += 1
    const stopped = recursionQueue.filter((c) => c.entry.preventRecursion)
    for (const c of stopped) {
      log.push({ kind: 'recursion-stop', entryKey: c.entry.key, detail: 'preventRecursion：内容不进入递归扫描' })
    }
    const recursionTexts = recursionQueue
      .filter((c) => !c.entry.preventRecursion)
      .map((c) => ident(c.entry.content, input.macroCtx))
      .filter((t) => t.trim().length > 0)
    if (recursionTexts.length === 0) break
    recursionQueue = evaluate(recursionTexts, level)
  }

  // ── 轮末扣减定时计数：仅扣轮初已存在的键；本轮新激活写入的值从下一轮开始倒数 ──
  for (const key of stickyKeysAtStart) {
    const left = (timer.stickyLeft[key] ?? 0) - 1
    if (left <= 0) delete timer.stickyLeft[key]
    else timer.stickyLeft[key] = left
  }
  for (const key of cooldownKeysAtStart) {
    const left = (timer.cooldownLeft[key] ?? 0) - 1
    if (left <= 0) delete timer.cooldownLeft[key]
    else timer.cooldownLeft[key] = left
  }

  // ── 预算截断：constant 优先 → order 从大到小 → 直接命中优先于递归 ─────────
  const rawLimit =
    settings.tokenBudget > 0
      ? settings.tokenBudget
      : Math.floor((input.contextWindowTokens * settings.contextPercent) / 100)
  // reservedTokens 是世界书之外已经占用的上下文；固定预算与百分比预算都必须扣减，
  // 否则聊天越长，实际请求越容易超出二者声明的上限。
  const limit = Math.max(0, rawLimit - Math.max(0, input.reservedTokens))
  const sorted = [...activated].sort((a, b) => {
    const ac = a.entry.constant ? 0 : 1
    const bc = b.entry.constant ? 0 : 1
    if (ac !== bc) return ac - bc
    if (a.entry.order !== b.entry.order) return b.entry.order - a.entry.order
    const ad = a.recursionLevel === 0 ? 0 : 1
    const bd = b.recursionLevel === 0 ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.entry.key.localeCompare(b.entry.key)
  })
  const kept: Candidate[] = []
  let used = 0
  let overflowed = false
  for (const c of sorted) {
    const cost = input.estimateTokens(c.entry.content)
    if (!c.entry.ignoreBudget && used + cost > limit) {
      overflowed = true
      log.push({ kind: 'budget-trim', entryKey: c.entry.key, detail: `需要 ${cost} tokens，剩余 ${limit - used}` })
      continue
    }
    used += cost
    kept.push(c)
  }
  if (overflowed && settings.overflowWarning) {
    log.push({ kind: 'budget-overflow', entryKey: '', detail: `世界书预算 ${limit} tokens 已耗尽，部分条目被截断` })
  }

  // ── 分桶落位：同位置按 order 升序（渲染时依此顺序，大 order 更靠近上下文末端） ──
  const byPosition: Partial<Record<WIPosition, WIActivation[]>> = {}
  const outlets: Record<string, WIActivation[]> = {}
  const positioned = [...kept].sort((a, b) => {
    const ta = sourceTier(a.entry, settings.characterStrategy)
    const tb = sourceTier(b.entry, settings.characterStrategy)
    if (ta !== tb) return ta - tb
    if (a.entry.order !== b.entry.order) return a.entry.order - b.entry.order
    return a.entry.key.localeCompare(b.entry.key)
  })
  const injected: WIActivation[] = []
  for (const c of positioned) {
    const activation: WIActivation = {
      entry: c.entry,
      matchedKeys: c.matchedKeys,
      via: c.via,
      recursionLevel: c.recursionLevel,
    }
    if (c.entry.position === WIPosition.Outlet) {
      const name = c.entry.outletName.trim()
      if (!name) continue // 无名 outlet 条目不注入（也不进 activated，与「丢弃」语义一致）
      ;(outlets[name] ??= []).push(activation)
    } else {
      ;(byPosition[c.entry.position] ??= []).push(activation)
    }
    injected.push(activation)
  }

  return {
    activated: injected,
    byPosition,
    outlets,
    log,
    budget: { limit, used, overflowed },
    timerState: timer,
  }
}
