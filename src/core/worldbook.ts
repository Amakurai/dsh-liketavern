/**
 * 世界书触发引擎（纯函数），语义对齐 SillyTavern World Info：
 * - 触发键：明文键 + `/regex/flags` 键；大小写敏感、整词匹配全局/条目级覆盖。
 *   键与扫描文本中的 `{{user}}`/`{{char}}` 先展开再匹配（对齐 ST substituteParams）。
 * - 次级键：AND ANY / AND ALL / NOT ANY / NOT ALL（selectiveLogic 0/3/2/1）。
 * - 触发策略：🔵 constant、🟢 关键词；🔗 向量匹配不做（由记忆 BM25 层承担，见 README）。
 * - 条目级 scanDepth：null 跟随全局；0 = 该条关键词不扫消息（常驻/递归/sticky 仍可活）。
 * - inclusion group：同组只留一条。sticky 延续占用组；否则 groupOverride 优先，
 *   再按 useGroupScoring（命中键数）或 groupWeight 加权随机。
 * - 递归扫描：excludeRecursion（不可被递归激活）/ preventRecursion（激活后不触发他人）/
 *   delayUntilRecursion（递归层级门槛，0=首轮即可）；maxRecursionSteps 0=不限（仅受预算限制）、
 *   1=关闭、n=总扫描轮数（含首轮）。
 * - 定时效果：sticky / cooldown / delay，按评估轮（每次引擎调用 = 一轮）推进；
 *   swipe/重新生成/回退的回滚由事务层负责（plan 3.11），引擎本身无副作用。
 * - 预算：Context % 或固定 token；截断优先级：constant 优先 → order 从大到小 → 直接命中优先于递归命中；
 *   ignoreBudget 条目豁免。
 * - 多来源合并：Chat > Persona > Character/Global（strategy: 0 evenly / 1 character_first / 2 global_first），
 *   delta 变化层与 character 同级（紧随原书条目之后，由渲染侧标注「当前状态」）。
 * - 已知偏差：inclusion group 在全部递归跑完之后才裁决，故落选条目的正文已经参与过递归扫描——
 *   它自己不会被注入，却仍决定了别人是否被激活。对齐 ST 需在首次激活时就定组内胜者并缓存，
 *   那会改变 random() 的消费顺序（进而改动既有加权随机结果），本轮不动。
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
      // `g`/`y` 正则的 test() 会保留 lastIndex。世界书会对同一条键
      // 连续扫描多个消息/名称变体，若不复位，命中结果会在奇偶次调用间
      // 交替漏掉。每次判断都从头开始，保持条目匹配的纯函数语义。
      return (text) => {
        re.lastIndex = 0
        return re.test(text)
      }
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

function textsAtDepth(
  cache: Map<number, string[]>,
  messages: readonly ChatMessage[],
  depth: number,
  includeNames: boolean,
  macroCtx?: Pick<MacroContext, 'char' | 'user'>,
): string[] {
  if (depth <= 0) return []
  const cached = cache.get(depth)
  if (cached) return cached
  const texts = scanTexts(messages.slice(-depth), includeNames, macroCtx)
  cache.set(depth, texts)
  return texts
}

/** 同组只留一条：sticky 延续占用组；否则 override → 计分 / 加权随机。 */
function applyInclusionGroups(
  activated: Candidate[],
  settings: WorldInfoGlobalSettings,
  random: () => number,
  log: WILogEntry[],
): Candidate[] {
  const ungrouped: Candidate[] = []
  const byGroup = new Map<string, Candidate[]>()
  for (const candidate of activated) {
    const name = candidate.entry.group.trim()
    if (!name) {
      ungrouped.push(candidate)
      continue
    }
    const members = byGroup.get(name) ?? []
    members.push(candidate)
    byGroup.set(name, members)
  }
  const kept: Candidate[] = [...ungrouped]
  for (const [group, members] of byGroup) {
    if (members.length === 1) {
      kept.push(members[0]!)
      continue
    }
    const sticky = members.filter((m) => m.via === 'sticky')
    if (sticky.length > 0) {
      kept.push(...sticky)
      for (const member of members) {
        if (member.via !== 'sticky') {
          log.push({ kind: 'group-skip', entryKey: member.entry.key, detail: `组「${group}」由 sticky 延续占用` })
        }
      }
      continue
    }
    const overrides = members.filter((m) => m.entry.groupOverride)
    const pool = overrides.length > 0 ? overrides : members
    const winner = settings.useGroupScoring ? pickGroupByScore(pool) : pickGroupWeighted(pool, random)
    kept.push(winner)
    for (const member of members) {
      if (member.entry.key === winner.entry.key) continue
      log.push({ kind: 'group-skip', entryKey: member.entry.key, detail: `组「${group}」已选 ${winner.entry.key}` })
    }
  }
  return kept
}

function pickGroupByScore(pool: Candidate[]): Candidate {
  return pool.reduce((best, candidate) => {
    const bestScore = best.matchedKeys.length
    const score = candidate.matchedKeys.length
    if (score !== bestScore) return score > bestScore ? candidate : best
    if (candidate.entry.groupWeight !== best.entry.groupWeight) {
      return candidate.entry.groupWeight > best.entry.groupWeight ? candidate : best
    }
    return candidate.entry.key.localeCompare(best.entry.key) < 0 ? candidate : best
  })
}

function pickGroupWeighted(pool: Candidate[], random: () => number): Candidate {
  const weights = pool.map((c) => Math.max(0, c.entry.groupWeight))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) return pool[0]!
  let cursor = random() * total
  for (let i = 0; i < pool.length; i++) {
    cursor -= weights[i]!
    if (cursor < 0) return pool[i]!
  }
  return pool[pool.length - 1]!
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

  // 扫描文本：全局/条目 scanDepth 0 = 该条关键词不扫消息（常驻与递归仍可活）
  const depthTexts = new Map<number, string[]>()

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
      const scanTextsForEntry =
        level === 0
          ? textsAtDepth(depthTexts, input.messages, entry.scanDepth ?? settings.scanDepth, settings.includeNames, input.macroCtx)
          : texts
      const matched = matchEntry(entry, scanTextsForEntry, settings, input.macroCtx)
      if (matched === null) continue
      if (tryActivate(entry, matched, level === 0 ? 'keyword' : 'recursion', level)) {
        fresh.push(activated[activated.length - 1]!)
      }
    }
    return fresh
  }

  // ── 第 0 层：直接扫描（每条用自己的 scanDepth） ─────────────────────────
  let level = 0
  recursionQueue = evaluate([], 0)

  // ── 递归扫描：新激活条目的内容成为下一轮扫描输入 ─────────────────────────
  const maxSteps = settings.maxRecursionSteps // 0=不限（受条目数与预算收敛）；1=关闭；n=总扫描轮数（含首轮）
  while (
    settings.recursiveScan &&
    recursionQueue.length > 0 &&
    (maxSteps === 0 || level < maxSteps - 1)
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

  const grouped = applyInclusionGroups(activated, settings, random, log)

  // ── 预算截断：constant 优先 → order 从大到小 → 直接命中优先于递归 ─────────
  const rawLimit =
    settings.tokenBudget > 0
      ? settings.tokenBudget
      : Math.floor((input.contextWindowTokens * settings.contextPercent) / 100)
  // reservedTokens 是世界书之外已经占用的上下文；固定预算与百分比预算都必须扣减，
  // 否则聊天越长，实际请求越容易超出二者声明的上限。
  const limit = Math.max(0, rawLimit - Math.max(0, input.reservedTokens))
  const sorted = [...grouped].sort((a, b) => {
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

  // ── 落选（含预算截断/无出口）条目本轮才写入的 sticky/cooldown 必须清掉：条目没被注入
  // 却留下定时状态，下一轮会经 via='sticky' 免概率回来并独占 inclusion group，饿死同组兄弟。
  const injectedKeys = new Set(injected.map((a) => a.entry.key))
  for (const candidate of activated) {
    if (injectedKeys.has(candidate.entry.key)) continue
    if (!stickyKeysAtStart.has(candidate.entry.key)) delete timer.stickyLeft[candidate.entry.key]
    if (!cooldownKeysAtStart.has(candidate.entry.key)) delete timer.cooldownLeft[candidate.entry.key]
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
