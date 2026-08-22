/**
 * 宏展开器（纯函数，除 MacroContext.store 为一次组装内的可变变量表）。
 *
 * 支持清单：
 * - `{{char}}` / `{{charname}}`：角色名
 * - `{{user}}` / `{{username}}`：用户人设名
 * - `{{description}}` / `{{personality}}` / `{{scenario}}`：角色卡字段
 * - `{{persona}}`：当前用户人设描述
 * - `{{charFirstMessage}}` / `{{firstMessage}}`：角色开场白（ST 拼写为 charFirstMessage）
 * - `{{outlet::Name}}`：世界书 Outlet；未匹配为空串。替换结果不再扫描（禁止嵌套 outlet）
 * - `{{time}}` / `{{date}}` / `{{datetime}}` / `{{weekday}}`：当前时间（可经 vars 覆盖）
 * - `{{trim}}` / `{{noop}}`：删除
 * - `{{//…}}`：注释，删除（社区预设用来写作者说明）
 * - `{{setvar::name::value}}` / `{{getvar::name}}`：一次组装内的变量表
 *   （setlocalvar/setglobalvar 视为 setvar；get* 同 getvar。不落盘。）
 * - `{{lastusermessage}}` / `{{lastMessage}}`：最近一条用户消息
 * - `{{lastCharMessage}}`：最近一条 assistant 消息（本轮宏，禁止进 standing）
 * - `{{random::A::B}}` / `{{pick::A,B}}` / `{{random:1,10}}`：掷骰（本轮宏，禁止进 standing）
 *
 * 这是组装前预处理：setvar 条目展开后变空，不进模型；getvar 处变成真正的写作规则。
 * 不是把 ST 宏引擎原样扔给模型。
 *
 * 未支持的宏保留原样并回调 onUnknown。
 *
 * `postProcess` 逐个加工「宏解析出来的值」（对齐 ST substituteParamsExtended 的 postProcessFn）：
 * 正则 find 的转义代入、正则 replace 的 `$` 保护都靠它，宏之外的原文不受影响。
 */
import type { MacroContext } from './types.js'

export type { MacroContext }

/** 只匹配不含花括号的最内层宏，便于 `{{setvar::x::{{char}}}}` 由内向外展开。 */
const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g
const MAX_PASSES = 8
/** outlet 替换结果里的 `{{` 冻结，避免二次扫描（禁止嵌套 outlet）。 */
const FROZEN_OPEN = '\uE000'

function pad2s(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function defaultVars(now: Date): Record<string, string> {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return {
    time: `${pad2s(now.getHours())}:${pad2s(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad2s(now.getMonth() + 1)}-${pad2s(now.getDate())}`,
    datetime: `${now.getFullYear()}-${pad2s(now.getMonth() + 1)}-${pad2s(now.getDate())} ${pad2s(now.getHours())}:${pad2s(now.getMinutes())}`,
    weekday: weekdays[now.getDay()]!,
  }
}

function storeOf(ctx: MacroContext): Map<string, string> {
  if (!ctx.store) ctx.store = new Map()
  return ctx.store
}

function splitOnce(rest: string): [string, string] {
  const i = rest.indexOf('::')
  if (i < 0) return [rest, '']
  return [rest.slice(0, i), rest.slice(i + 2)]
}

/** 同一种子每次调用生成独立流；同一 turn 多步组装应各拿一份新流。 */
export function createTurnRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashToSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rollChoice(options: string[], random: () => number, numericRange: boolean): string {
  if (options.length === 0) return ''
  if (numericRange && options.length === 2 && options.every((o) => /^-?\d+$/.test(o))) {
    const a = Number(options[0])
    const b = Number(options[1])
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    return String(lo + Math.floor(random() * (hi - lo + 1)))
  }
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))]!
}

function parseChoiceMacro(inner: string): { kind: 'random' | 'pick'; options: string[] } | null {
  const match = /^(random|pick)\s*(::|:)\s*(.*)$/i.exec(inner.trim())
  if (!match) return null
  const kind = match[1]!.toLowerCase() === 'pick' ? 'pick' : 'random'
  const rest = match[3] ?? ''
  const parts = rest.includes('::') ? rest.split('::') : rest.split(',')
  return { kind, options: parts.map((s) => s.trim()).filter(Boolean) }
}

function isGetVar(inner: string): boolean {
  return /^(getvar|getlocalvar|getglobalvar)\s*::/i.test(inner.trim())
}

function applyCommand(inner: string, ctx: MacroContext, clock: Record<string, string>): string | undefined {
  const raw = inner.trim()
  const lower = raw.toLowerCase()

  if (lower === 'char' || lower === 'charname') return ctx.char
  if (lower === 'user' || lower === 'username') return ctx.user
  if (lower === 'description') return ctx.description ?? ''
  if (lower === 'personality') return ctx.personality ?? ''
  if (lower === 'scenario') return ctx.scenario ?? ''
  if (lower === 'persona') return ctx.persona ?? ''
  if (lower === 'charfirstmessage' || lower === 'firstmessage') return ctx.firstMessage ?? ''
  if (lower === 'trim' || lower === 'noop' || lower === 'newline') return lower === 'newline' ? '\n' : ''
  if (lower === 'lastusermessage' || lower === 'lastmessage' || lower === 'last_user_message') {
    return ctx.lastUserMessage ?? ''
  }
  if (lower === 'lastcharmessage' || lower === 'last_char_message') {
    return ctx.lastCharMessage ?? ''
  }
  if (lower.startsWith('//')) return ''

  const choices = parseChoiceMacro(raw)
  if (choices) return rollChoice(choices.options, ctx.random ?? Math.random, choices.kind === 'random')

  if (lower.startsWith('outlet::')) {
    const outletName = raw.slice('outlet::'.length).trim()
    const content = ctx.outlets?.[outletName] ?? ''
    return content.replaceAll('{{', FROZEN_OPEN)
  }

  if (Object.hasOwn(clock, lower)) return clock[lower]!

  const eq = lower.indexOf('::')
  if (eq <= 0) return undefined
  const cmd = lower.slice(0, eq)
  const rest = raw.slice(eq + 2)

  if (cmd === 'setvar' || cmd === 'setlocalvar' || cmd === 'setglobalvar') {
    const [name, value] = splitOnce(rest)
    const key = name.trim()
    if (key) storeOf(ctx).set(key, value)
    return ''
  }
  if (cmd === 'getvar' || cmd === 'getlocalvar' || cmd === 'getglobalvar') {
    const key = rest.trim()
    return storeOf(ctx).get(key) ?? ''
  }
  if (cmd === 'addvar') {
    const [name, deltaRaw] = splitOnce(rest)
    const key = name.trim()
    const prev = Number(storeOf(ctx).get(key) ?? '0')
    const delta = Number(deltaRaw)
    const next = (Number.isFinite(prev) ? prev : 0) + (Number.isFinite(delta) ? delta : 0)
    storeOf(ctx).set(key, String(next))
    return ''
  }
  return undefined
}

/**
 * 展开 text 中的宏。outlet 替换结果不二次扫描（SillyTavern：禁止嵌套 outlet）。
 * setvar/getvar 经 MacroContext.store 在一次组装内跨条目共享。
 *
 * postProcess 只作用于每个宏解析出来的值（不碰模板里的原文），调用方用它做
 * 正则转义或 `$` 保护。now 保持第三位，老调用方（只传 text/ctx 或再带 now）不受影响。
 */
export function expandMacros(
  text: string,
  ctx: MacroContext,
  now: Date = new Date(),
  postProcess?: (value: string) => string,
): string {
  if (!text.includes('{{')) return text
  const clock = { ...defaultVars(now), ...ctx.vars }
  let current = text

  const replaceInnermost = (skipGet: boolean, unknowns: string[] | null): void => {
    current = current.replace(MACRO_RE, (raw, inner: string) => {
      if (skipGet && isGetVar(inner)) return raw
      const applied = applyCommand(inner, ctx, clock)
      if (applied !== undefined) return postProcess ? postProcess(applied) : applied
      unknowns?.push(inner.trim())
      return raw
    })
  }

  for (let pass = 0; pass < MAX_PASSES && current.includes('{{'); pass++) {
    const before = current
    // 先展开 setvar/char 等，避免同串里 {{getvar}} 在写入前被读成空。
    replaceInnermost(true, null)
    if (current !== before) continue

    const unknowns: string[] = []
    replaceInnermost(false, unknowns)
    if (current === before || pass === MAX_PASSES - 1) {
      for (const name of unknowns) ctx.onUnknown?.(name)
      break
    }
  }
  return current.replaceAll(FROZEN_OPEN, '{{')
}

const IDENTITY_MACRO_RE = /\{\{\s*(char|charname|user|username)\s*\}\}/gi

/**
 * 只展开身份宏。用于开场白展示、世界书扫描、入模历史——这些地方不该跑 setvar/时钟。
 * `{{user}}` 变成当前人设名，才能和世界书键互相命中。
 */
export function expandIdentityMacros(text: string, ctx: Pick<MacroContext, 'char' | 'user'>): string {
  if (!text.includes('{{')) return text
  return text.replace(IDENTITY_MACRO_RE, (_raw, name: string) => {
    const k = name.toLowerCase()
    return k === 'user' || k === 'username' ? ctx.user : ctx.char
  })
}

/** 收集文本中出现的宏名（调试用）。 */
export function listMacros(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MACRO_RE)) out.push(m[1]!.trim())
  return out
}

/** 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。 */
export function hasTurnLocalMacros(text: string): boolean {
  return /\{\{\s*(outlet::|lastusermessage|lastmessage|last_user_message|lastcharmessage|last_char_message|time|date|datetime|weekday|random\s*:|pick\s*:)/i.test(text)
}

/** SillyTavern EJS / STscript。本插件不执行，原文注入只会污染上下文。 */
export function hasUnevaluatedScript(text: string): boolean {
  return /<%[_=-]?/.test(text) || /\{%\s*(if|for|set)\b/i.test(text)
}
