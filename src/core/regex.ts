/**
 * 正则引擎（纯函数），语义对齐 SillyTavern 正则扩展：
 * - find 允许 `/pattern/flags` 形式；裸源码 = 区分大小写、只替换首个匹配。
 * - replace 支持 $1..$9 / $<name> 捕获组、`{{match}}`（等价 $&）与 {{char}}/{{user}} 宏。
 * - find 中宏展开由规则 substituteRegex 控制：0=不展开 1=原样代入 2=转义代入
 *   （转义在展开之后逐个宏值做，否则 {{description}}/{{getvar}} 会把裸元字符注进 pattern）。
 * - replace 里宏展开出来的值会把 `$` 翻倍：宏值中的 `$&`/`$1` 是字面文本，
 *   不该被 String.replace 再解释一次（`{{match}}` 是唯一例外，见下）。
 * - trimStrings / trimStringsRegex：对齐 ST——替换代入捕获组（含 {{match}}/$0）前，
 *   从组值里删掉这些字面串/正则片段（先宏展开）。ST 现行引擎只实现 trimStrings；
 *   trimStringsRegex 由本插件按同位置语义补全（缺省全局匹配）。
 *   带 trim 的规则改走函数式手工代入（ST 同款，支持 $0），其余规则仍用原生 replace。
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

/** 替换串里的字面 `$` 翻倍，避免 String.replace 把宏值里的 `$&`/`$1`/`$$` 当成引用。 */
function escapeReplacementDollars(text: string): string {
  return text.replaceAll('$', '$$$$')
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
    // 2 = 转义代入：转义必须在宏展开之后、按每个宏的解析值逐个做。只预先转义 char/user
    // 会漏掉 {{description}}/{{persona}}/{{getvar::…}}/{{outlet::…}}——它们带的裸元字符
    // 要么让 RegExp 直接抛错（规则静默变死），要么把 `.*` 之类注进 pattern 匹配一切。
    source = expandMacros(source, macroCtx, undefined, rule.substituteRegex === 2 ? escapeRegExp : undefined)
  }
  return new RegExp(source, flags)
}

function hasTrims(rule: RegexRule): boolean {
  return (rule.trimStrings?.length ?? 0) > 0 || (rule.trimStringsRegex?.length ?? 0) > 0
}

/** 编译 trimStringsRegex 条目：允许 /pattern/flags，缺省补 g（trim 通常要全删）。 */
function compileTrimRegex(source: string): RegExp {
  const literal = REGEX_LITERAL_RE.exec(source)
  if (literal) {
    const flags = literal[2] ?? ''
    return new RegExp(literal[1]!, flags.includes('g') ? flags : `${flags}g`)
  }
  return new RegExp(source, 'g')
}

/** ST filterString：从捕获组值里删掉 trimStrings（字面，先宏展开）与 trimStringsRegex 命中片段。 */
function filterCapturedGroup(value: string, rule: RegexRule, trimRes: readonly RegExp[], macroCtx: MacroContext): string {
  let out = value
  for (const trim of rule.trimStrings ?? []) {
    if (!trim) continue
    const expanded = expandMacros(trim, macroCtx)
    if (expanded) out = out.replaceAll(expanded, '')
  }
  for (const re of trimRes) {
    re.lastIndex = 0
    out = out.replace(re, '')
  }
  return out
}

/** 带 trim 的规则走 ST 同款手工代入：$0/$1..$N/$<name>，代入前先过滤组值。 */
function replaceWithGroupTrim(text: string, re: RegExp, template: string, rule: RegexRule, trimRes: readonly RegExp[], macroCtx: MacroContext): string {
  const tpl = template.replaceAll('{{match}}', '$0')
  return text.replace(re, (...args: unknown[]) => {
    const maybeGroups = args[args.length - 1]
    const groups =
      typeof maybeGroups === 'object' && maybeGroups !== null ? (maybeGroups as Record<string, string>) : undefined
    // 回调实参是 [match, ...捕获组, offset, subject]（有命名组时末尾再多一个 groups 对象）。
    // 越界的 $N 会读到 offset（数字）或整段原文，必须挡掉：原生 replace 对越界 $N 原样输出字面量。
    const groupCount = args.length - (groups ? 4 : 3)
    return tpl.replace(/\$(\d+)|\$<([^>]+)>/g, (_m: string, num: string | undefined, name: string | undefined) => {
      let value: unknown
      if (num !== undefined) {
        if (Number(num) > groupCount) return _m
        value = args[Number(num)]
      } else if (name && groups) value = groups[name]
      if (value === undefined) return '' // 未命中的组（含可选组）代入空串，对齐 ST；'' 与 '0' 是真值，必须留下
      if (typeof value !== 'string') return _m
      return filterCapturedGroup(value, rule, trimRes, macroCtx)
    })
  })
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
      let next: string
      if (hasTrims(rule)) {
        const trimRes: RegExp[] = []
        for (const source of rule.trimStringsRegex ?? []) {
          if (!source) continue
          trimRes.push(compileTrimRegex(source))
        }
        // 手工代入路径全程是回调返回值（字面量），宏值里的 `$` 不会被再解释，故不翻倍。
        const replacement = expandMacros(rule.replace, macroCtx)
        next = replaceWithGroupTrim(out, re, replacement, rule, trimRes, macroCtx)
      } else {
        // replace 先宏展开（对齐 ST：substituteParams 后再 replace），捕获组由原生 replace 处理。
        // 宏展开出来的值逐个把 `$` 翻倍：人设名 "Cash$$Money"、getvar 里的 "$1" 都是字面文本。
        // 注意：String.replace 不认识 $0（会输出字面量），整体匹配须用 $&；
        // 且 replaceAll 的替换串里 $& 也有特殊含义，故用函数形式写入字面 '$&'。
        // {{match}} 不是已知宏，展开时原样留下，翻倍不到它头上，这里再换成 $&。
        const replacement = expandMacros(rule.replace, macroCtx, undefined, escapeReplacementDollars)
        next = out.replace(re, replacement.replaceAll('{{match}}', () => '$&'))
      }
      if (next !== out) applied.push(rule.id)
      out = next
    } catch (error) {
      errors.push({ ruleId: rule.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { text: out, applied, errors }
}

/**
 * 预编译规则（消息循环外准备一次，全部消息复用）：applyRegexToMessages 对每条消息
 * 重复应用同一批规则，逐消息重建 RegExp 是纯浪费，编译（含 find 宏展开、trim 正则构造）下沉到批级。
 * 但替换串的宏展开必须留在按消息进行：{{random}}/{{pick}} 每次代入都要重新掷骰（ST 语义），
 * 且本轮随机流（macroCtx.random）的消费次数要与逐消息展开一致，否则同次组装里后续的
 * {{random}} 取值全部平移。find 里的宏只展开一次——模式里放随机宏会让规则逐消息变意，
 * 属病态用法，不为它放弃编译复用。
 * 编译失败的规则记入 error，应用时跳过并计入 errors（每批只报一次，不再逐消息重复）。
 */
interface PreparedRule {
  rule: RegexRule
  error?: string
  re?: RegExp
  /** 仅带 trim 的规则存在：预编译的 trimStringsRegex。 */
  trimRes?: RegExp[]
}

function prepareRegexRule(rule: RegexRule, macroCtx: MacroContext): PreparedRule {
  try {
    const re = compile(rule, macroCtx)
    if (hasTrims(rule)) {
      const trimRes: RegExp[] = []
      for (const source of rule.trimStringsRegex ?? []) {
        if (!source) continue
        trimRes.push(compileTrimRegex(source))
      }
      return { rule, re, trimRes }
    }
    return { rule, re }
  } catch (error) {
    return { rule, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 应用一条预编译规则（编译失败的规则原样返回）；替换串宏展开随消息进行，与 applyRegexRules 同语义。 */
function applyPreparedRule(text: string, p: PreparedRule, macroCtx: MacroContext): string {
  if (p.error !== undefined || !p.re) return text
  if (p.trimRes) {
    // 手工代入路径全程是回调返回值（字面量），宏值里的 `$` 不会被再解释，故不翻倍。
    const replacement = expandMacros(p.rule.replace, macroCtx)
    return replaceWithGroupTrim(text, p.re, replacement, p.rule, p.trimRes, macroCtx)
  }
  const replacement = expandMacros(p.rule.replace, macroCtx, undefined, escapeReplacementDollars)
  return text.replace(p.re, replacement.replaceAll('{{match}}', () => '$&'))
}

/**
 * 对消息数组按深度应用规则。depth 从 0（最新真实消息）计，跳过 dsh runtime-context 快照；
 * 规则的 minDepth/maxDepth（null = 不限）过滤作用区间。返回新数组。
 * RegExp 编译只做一次（prepareRegexRule），全部消息复用；替换串宏展开仍逐消息
 * （{{random}}/{{pick}} 每次代入重新掷骰）；depth/role 过滤按消息进行。
 */
export function applyRegexToMessages(
  messages: readonly ChatMessage[],
  rules: readonly RegexRule[],
  filter: RegexFilter,
  macroCtx: MacroContext,
): { messages: ChatMessage[]; applied: string[]; errors: RegexApplyResult['errors'] } {
  const applied: string[] = []
  const errors: RegexApplyResult['errors'] = []
  const prepared = rules
    .filter((r) => r.enabled && r.scopes.includes(filter.scope) && r.timing.includes(filter.timing))
    .map((r) => prepareRegexRule(r, macroCtx))
  for (const p of prepared) {
    if (p.error !== undefined) errors.push({ ruleId: p.rule.id, message: p.error })
  }
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
    const scoped = prepared.filter(
      (p) =>
        p.error === undefined &&
        (p.rule.minDepth === null || depth >= p.rule.minDepth) &&
        (p.rule.maxDepth === null || depth <= p.rule.maxDepth) &&
        (p.rule.roles == null || p.rule.roles.length === 0 || p.rule.roles.includes(msg.role)),
    )
    if (scoped.length === 0) return msg
    let content = msg.content
    for (const p of scoped) {
      let next: string
      try {
        next = applyPreparedRule(content, p, macroCtx)
      } catch (error) {
        // 单条规则执行失败不中断后续规则，记入 errors（与 applyRegexRules 同语义）。
        errors.push({ ruleId: p.rule.id, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (next !== content) {
        applied.push(p.rule.id)
        content = next
      }
    }
    return content === msg.content ? msg : { ...msg, content }
  })
  return { messages: out, applied, errors }
}

/**
 * 归一化 ST regex_scripts。
 *
 * placement：1 USER_INPUT → input/send + 仅 user；2 AI_OUTPUT → output/render + 仅 assistant；
 * 5 WORLD_INFO → prompt/assemble。其余 placement 忽略。
 * markdownOnly → 仅展示；promptOnly → 仅入模；两者同时勾选 → 展示 + 入模（社区预设常用）。
 * md/po 改写 scopes 后 roles 会跟着复核，绝不留下 scopes 与 roles 互斥的死规则。
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
    // md/po 整体重写了 scopes，roles 必须跟着复核：placement:[1] + markdownOnly 会留下
    // output × user 这种自相矛盾的组合，applyRegexToMessages 的 roles 过滤让它永不命中（死规则）。
    // prompt 作用域 user/assistant 都收，所以只在旧 roles 与新 scopes 完全冲突时才按 scopes 重建，
    // 保住「promptOnly + placement 1 只裹 user 楼层」这类预设意图。
    const scopeRoles = new Set<ChatRole>()
    if (scopes.has('output') || scopes.has('prompt')) scopeRoles.add('assistant')
    if (scopes.has('input') || scopes.has('prompt')) scopeRoles.add('user')
    if (roles.size > 0 && ![...roles].some((role) => scopeRoles.has(role))) {
      roles.clear()
      if (scopes.has('output')) roles.add('assistant')
      if (scopes.has('input')) roles.add('user')
    }
    if (scopes.size === 0) return
    const substitute = script.substituteRegex
    const displayOnly = [...scopes].every((s) => s === 'output') && [...timing].every((t) => t === 'render')
    let enabled = script.disabled === true ? false : source === 'preset' ? true : displayOnly
    // 卡内正则：只要带展示向就启用展示部分。社区卡常同时勾 markdownOnly+promptOnly，
    // 或 placement 含输入；旧逻辑把整条关掉，封面 HTML 正则永远不跑。入模/输入仍默认关。
    if (source === 'card' && script.disabled !== true && scopes.has('output') && timing.has('render')) {
      if (!displayOnly) {
        scopes.clear()
        timing.clear()
        roles.clear()
        scopes.add('output')
        timing.add('render')
        roles.add('assistant')
      }
      enabled = true
    }
    const scopeList = [...scopes]
    const timingList = [...timing]
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
      ...(script.trimStrings?.some((s) => s.length > 0)
        ? { trimStrings: script.trimStrings.filter((s) => s.length > 0) }
        : {}),
      ...(script.trimStringsRegex?.some((s) => s.length > 0)
        ? { trimStringsRegex: script.trimStringsRegex.filter((s) => s.length > 0) }
        : {}),
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
/** 封面小部件常是 <style>/<script> 片段，没有 doctype。 */
const HTML_UI_RE = /<(?:style|script)\b/i
const HTML_PAYLOAD_START_RE = /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]|<style[\s>]|<script[\s>]/i

function isHtmlDocument(text: string): boolean {
  return HTML_DOC_RE.test(text)
}

/** 整页文档，或带闭合 style/script 的交互卡片段（正则常不包 doctype）。 */
function isHtmlPayload(text: string): boolean {
  if (isHtmlDocument(text)) return true
  return HTML_UI_RE.test(text) && /<\/(?:style|script)\s*>/i.test(text)
}

/** 片段没有 </html> 时，最后一个块级闭标签之后若不再是标签，当作正文拆走。 */
function splitTrailingProse(block: string): { html: string; rest: string } {
  const closeRe = /<\/(?:script|style|div|section|article|main)\s*>/gi
  let cut = -1
  let match: RegExpExecArray | null
  while ((match = closeRe.exec(block))) {
    cut = match.index + match[0].length
  }
  if (cut < 0) return { html: block.trim(), rest: '' }
  const after = block.slice(cut).trim()
  if (!after || after.startsWith('<')) return { html: block.trim(), rest: '' }
  return { html: block.slice(0, cut).trim(), rest: after }
}

/**
 * 正则替换后的展示文本常是「整页 HTML 封面」或「小部件 HTML + 后面的正文」。
 * HTML 文档和小部件片段抽进 iframe；围栏外 / </html> 之前的协议标签与之后的文字留给 Markdown。
 */
export function splitRenderedHtml(text: string): { html: string | null; rest: string } {
  if (!text) return { html: null, rest: '' }
  const fence = HTML_FENCE_RE.exec(text)
  if (fence?.[1] && isHtmlPayload(fence[1])) {
    const rest = `${text.slice(0, fence.index)}${text.slice(fence.index + fence[0].length)}`.trim()
    return { html: fence[1].trim(), rest }
  }
  if (!isHtmlPayload(text)) return { html: null, rest: text.trim() }
  const start = text.search(HTML_PAYLOAD_START_RE)
  const end = start >= 0 ? HTML_END_RE.exec(text.slice(start)) : null
  if (start >= 0 && end) {
    const htmlEnd = start + end.index + end[0].length
    const html = text.slice(start, htmlEnd).trim()
    const rest = `${text.slice(0, start)}${text.slice(htmlEnd)}`.trim()
    return { html, rest }
  }
  const payload = start >= 0 ? text.slice(start) : text
  const prefix = start > 0 ? text.slice(0, start).trim() : ''
  const split = splitTrailingProse(payload)
  return { html: split.html, rest: [prefix, split.rest].filter(Boolean).join('\n') }
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
