/**
 * 正则引擎（纯函数），语义对齐 SillyTavern 正则扩展：
 * - find 允许 `/pattern/flags` 形式；裸源码 = 区分大小写、只替换首个匹配。
 * - replace 支持 $1..$9 / $<name> 捕获组、`{{match}}`（等价 $&）与 {{char}}/{{user}} 宏。
 * - find 中宏展开由规则 substituteRegex 控制：0=不展开 1=原样代入 2=转义代入。
 *
 * 规则作用于三种文本（scope）与三个时机（timing）的组合点：
 * - 用户输入 input：发送前（send）
 * - 发送给模型的文本 prompt：组装前（assemble）/ 发送前（send）
 * - AI 输出 output：渲染前（render）
 *
 * 引擎只返回新字符串/新数组，绝不原地修改——「作用于 prompt 的规则不得改写
 * 会话中存储的原始消息」由调用方据此天然满足。
 */
import { expandMacros, type MacroContext } from './macros.js'
import { isSyntheticUserText } from './dshPrompt.js'
import type { CardRegexScript, ChatMessage, ChatRole, RegexRule, RegexScope, RegexTiming } from './types.js'

export type { MacroContext }

export interface RegexFilter {
  scope: RegexScope
  timing: RegexTiming
}

export interface RegexApplyResult {
  text: string
  /** 实际命中的规则 id（按应用顺序）。 */
  applied: string[]
  errors: Array<{ ruleId: string; message: string }>
}

const REGEX_LITERAL_RE = /^\/(.*)\/([a-z]*)$/s

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compile(rule: RegexRule, macroCtx: MacroContext): RegExp {
  let source = rule.find
  let flags = ''
  const literal = REGEX_LITERAL_RE.exec(source)
  if (literal) {
    source = literal[1]!
    flags = literal[2] ?? ''
  }
  if (rule.substituteRegex !== 0) {
    const ctx: MacroContext =
      rule.substituteRegex === 2
        ? { ...macroCtx, char: escapeRegExp(macroCtx.char), user: escapeRegExp(macroCtx.user) }
        : macroCtx
    source = expandMacros(source, ctx)
  }
  return new RegExp(source, flags)
}

/** 顺序应用规则；单条规则编译/执行失败不中断后续规则，记入 errors。 */
export function applyRegexRules(
  text: string,
  rules: readonly RegexRule[],
  filter: RegexFilter,
  macroCtx: MacroContext,
): RegexApplyResult {
  const applied: string[] = []
  const errors: RegexApplyResult['errors'] = []
  let out = text
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!rule.scopes.includes(filter.scope) || !rule.timing.includes(filter.timing)) continue
    try {
      const re = compile(rule, macroCtx)
      // replace 先宏展开（对齐 ST：substituteParams 后再 replace），捕获组由原生 replace 处理。
      // 注意：String.replace 不认识 $0（会输出字面量），整体匹配须用 $&；
      // 且 replaceAll 的替换串里 $& 也有特殊含义，故用函数形式写入字面 '$&'。
      const replacement = expandMacros(rule.replace, macroCtx).replaceAll('{{match}}', () => '$&')
      const next = out.replace(re, replacement)
      if (next !== out) applied.push(rule.id)
      out = next
    } catch (error) {
      errors.push({ ruleId: rule.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { text: out, applied, errors }
}

/**
 * 对消息数组按深度应用规则。depth 从 0（最新真实消息）计，跳过 dsh runtime-context 快照；
 * 规则的 minDepth/maxDepth（null = 不限）过滤作用区间。返回新数组。
 */
export function applyRegexToMessages(
  messages: readonly ChatMessage[],
  rules: readonly RegexRule[],
  filter: RegexFilter,
  macroCtx: MacroContext,
): { messages: ChatMessage[]; applied: string[]; errors: RegexApplyResult['errors'] } {
  const applied: string[] = []
  const errors: RegexApplyResult['errors'] = []
  const n = messages.length
  const depths: Array<number | null> = Array.from({ length: n }, () => null)
  let depthFromEnd = 0
  for (let i = n - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'user' && isSyntheticUserText(msg.content)) continue
    depths[i] = depthFromEnd
    depthFromEnd++
  }
  const out = messages.map((msg, i) => {
    const depth = depths[i]
    if (depth == null) return msg
    if (filter.scope === 'input' && msg.role !== 'user') return msg
    if (filter.scope === 'output' && msg.role !== 'assistant') return msg
    const scoped = rules.filter(
      (r) =>
        r.enabled &&
        r.scopes.includes(filter.scope) &&
        r.timing.includes(filter.timing) &&
        (r.minDepth === null || depth >= r.minDepth) &&
        (r.maxDepth === null || depth <= r.maxDepth) &&
        (r.roles == null || r.roles.length === 0 || r.roles.includes(msg.role)),
    )
    if (scoped.length === 0) return msg
    const res = applyRegexRules(msg.content, scoped, filter, macroCtx)
    applied.push(...res.applied)
    errors.push(...res.errors)
    return res.text === msg.content ? msg : { ...msg, content: res.text }
  })
  return { messages: out, applied, errors }
}

/**
 * 归一化 ST regex_scripts。
 *
 * placement：1 USER_INPUT → input/send + 仅 user；2 AI_OUTPUT → output/render + 仅 assistant；
 * 5 WORLD_INFO → prompt/assemble。其余 placement 忽略。
 * markdownOnly → 仅展示；promptOnly → 仅入模；两者同时勾选 → 展示 + 入模（社区预设常用）。
 *
 * 启用策略：
 * - card：展示向默认开，改 prompt/input 默认关（避免导入即改写发给模型的文本）
 * - preset：跟脚本 `disabled` 走（预设正则是作者意图的一部分）
 */
export function compileRegexScripts(
  scripts: readonly CardRegexScript[],
  options: { source: 'card' | 'preset'; sourceRef: string },
): RegexRule[] {
  const { source, sourceRef } = options
  const rules: RegexRule[] = []
  scripts.forEach((script, index) => {
    const find = script.findRegex ?? ''
    if (!find) return
    const scopes = new Set<RegexScope>()
    const timing = new Set<RegexTiming>()
    const roles = new Set<ChatRole>()
    const placement = script.placement ?? [2]
    for (const p of placement) {
      if (p === 1) {
        scopes.add('input')
        timing.add('send')
        roles.add('user')
      } else if (p === 2) {
        scopes.add('output')
        timing.add('render')
        roles.add('assistant')
      } else if (p === 5) {
        scopes.add('prompt')
        timing.add('assemble')
      }
    }
    const md = Boolean(script.markdownOnly)
    const po = Boolean(script.promptOnly)
    if (md && po) {
      scopes.clear()
      timing.clear()
      scopes.add('output')
      scopes.add('prompt')
      timing.add('render')
      timing.add('assemble')
      timing.add('send')
    } else if (md) {
      scopes.clear()
      timing.clear()
      scopes.add('output')
      timing.add('render')
    } else if (po) {
      scopes.clear()
      timing.clear()
      scopes.add('prompt')
      timing.add('assemble')
      timing.add('send')
    }
    if (scopes.size === 0) return
    const substitute = script.substituteRegex
    const scopeList = [...scopes]
    const timingList = [...timing]
    const displayOnly = scopeList.every((s) => s === 'output') && timingList.every((t) => t === 'render')
    const enabled = script.disabled === true ? false : source === 'preset' ? true : displayOnly
    const roleList = [...roles]
    rules.push({
      id: script.id ?? `${source}:${sourceRef}:regex:${index}`,
      name: script.scriptName ?? (source === 'preset' ? `预设正则 ${index + 1}` : `卡内正则 ${index + 1}`),
      find,
      replace: script.replaceString ?? '',
      enabled,
      scopes: scopeList,
      timing: timingList,
      minDepth: script.minDepth ?? null,
      maxDepth: script.maxDepth ?? null,
      substituteRegex: substitute === 0 || substitute === 2 ? substitute : 1,
      source,
      ...(roleList.length > 0 ? { roles: roleList } : {}),
    })
  })
  return rules
}

/** 角色卡内嵌正则：展示向默认开，prompt/input 默认关。 */
export function compileCardRegexScripts(scripts: readonly CardRegexScript[], cardId: string): RegexRule[] {
  return compileRegexScripts(scripts, { source: 'card', sourceRef: cardId })
}

/** 预设内嵌正则：跟脚本 disabled 走。 */
export function compilePresetRegexScripts(scripts: readonly CardRegexScript[], presetId: string): RegexRule[] {
  return compileRegexScripts(scripts, { source: 'preset', sourceRef: presetId })
}

const HTML_DOC_RE = /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]/i
const HTML_FENCE_RE = /```(?:text|html|xml)?\s*\n([\s\S]*?)```/i
const HTML_END_RE = /<\/html\s*>/i

function isHtmlDocument(text: string): boolean {
  return HTML_DOC_RE.test(text)
}

/**
 * 正则替换后的展示文本常是「整页 HTML 封面」或「小部件 HTML + 后面的正文」。
 * 只把 HTML 文档抽进 iframe，围栏外 / </html> 之后的文字留给 Markdown，否则切条目会只剩前端。
 */
export function splitRenderedHtml(text: string): { html: string | null; rest: string } {
  if (!text) return { html: null, rest: '' }
  const fence = HTML_FENCE_RE.exec(text)
  if (fence?.[1] && isHtmlDocument(fence[1])) {
    const rest = `${text.slice(0, fence.index)}${text.slice(fence.index + fence[0].length)}`.trim()
    return { html: fence[1].trim(), rest }
  }
  if (!isHtmlDocument(text)) return { html: null, rest: text.trim() }
  const start = text.search(HTML_DOC_RE)
  const end = start >= 0 ? HTML_END_RE.exec(text.slice(start)) : null
  if (start >= 0 && end) {
    const htmlEnd = start + end.index + end[0].length
    const html = text.slice(start, htmlEnd).trim()
    const rest = `${text.slice(0, start)}${text.slice(htmlEnd)}`.trim()
    return { html, rest }
  }
  return { html: text.trim(), rest: '' }
}

/**
 * 连续抽出多段 HTML 文档（开场白可被多条正则各换成一页）。
 * 正文只留不含完整 HTML 文档的剩余，避免第二段源码进 Markdown。
 */
export function collectRenderedHtml(text: string): { htmls: string[]; rest: string } {
  const htmls: string[] = []
  let current = text
  for (let i = 0; i < 8; i++) {
    const split = splitRenderedHtml(current)
    if (!split.html) return { htmls, rest: split.rest }
    htmls.push(split.html)
    if (!split.rest || split.rest === current) return { htmls, rest: split.rest }
    current = split.rest
  }
  return { htmls, rest: current }
}

/** 从正则替换后的展示文本里抽出完整 HTML（含 ```text/html 围栏）。 */
export function extractRenderedHtml(text: string): string | null {
  return splitRenderedHtml(text).html
}
