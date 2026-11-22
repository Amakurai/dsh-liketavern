/**
 * 纯文本/Markdown `<details>` 折叠块识别与解析：
 * 无脚本、无样式、无内嵌 HTML 元素（仅允许嵌套纯 `<details>` 与 `<br>`）的折叠块
 * 由客户端原生 `<details>` + `MarkdownText` 渲染，避免拆进白色/突兀的沙箱 `<iframe>`。
 * 只要结构或标签存在任何越界或疑似 HTML/脚本片段，立即返回 `null` 回退原有 `<iframe>` 隔离沙箱。
 */
import { isDisplayMetaTagName, isKnownHtmlElementName, stripDisplayMeta } from './displaySanitize.js'
import { findGfmTableLines, markdownCodeScanner } from './markdownCode.js'

export type PlainDetailsChild =
  | { kind: 'markdown'; text: string }
  | { kind: 'details'; block: PlainDetailsBlock }

export interface PlainDetailsBlock {
  open: boolean
  summary: string | null
  children: PlainDetailsChild[]
}

const MAX_PLAIN_DETAILS_CHARS = 256 * 1024
const MAX_PLAIN_DETAILS_DEPTH = 8
const MAX_PLAIN_DETAILS_BLOCKS = 64

const DETAILS_OPEN_RE = /<details(?:\s+(open(?:\s*=\s*(?:""|''|"open"|'open'|open))?))?\s*>/iy
const DETAILS_CLOSE_RE = /^<\/details\s*>/i
const DETAILS_TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
const SUMMARY_CANDIDATE_RE = /^<summary(?=[\t\n\f\r />])/i
const SUMMARY_OPEN_RE = /<summary\s*>/iy
const SUMMARY_CLOSE_RE = /<\/summary\s*>/iy
const SUMMARY_SCAN_RE = /<|`+|\r?\n[ \t]*\r?\n/g
const BR_CANDIDATE_RE = /^<br(?=[\t\n\f\r />])/i
const BR_PLAIN_RE = /<br\s*\/?>/iy
const HR_CANDIDATE_RE = /^<hr(?=[\t\n\f\r />])/i
const HR_PLAIN_RE = /<hr\s*\/?>/iy
const AUTOLINK_CANDIDATE_RE = /<[^\s<>]+>/y
const BODY_TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)(?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/y
const CUSTOM_ELEMENT_NAME_RE = /^[a-z][\w.]*-[\w.-]*$/
const RESIDUAL_TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)((?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?)>/y
const DETAILS_BOUNDARY_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi
const EMAIL_AUTOLINK_RE = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/
const URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>]+>$/
const AUTOLINK_SCHEMES = new Set([
  'http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'urn', 'irc', 'ircs',
  'ws', 'wss', 'ssh', 'git', 'file', 'magnet', 'news', 'xmpp', 'sip',
  'sips', 'sms', 'geo', 'data', 'blob', 'javascript', 'vbscript',
])

const SUMMARY_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  rarr: '\u2192',
  larr: '\u2190',
  uarr: '\u2191',
  darr: '\u2193',
  hearts: '\u2665',
  spades: '\u2660',
  clubs: '\u2663',
  diams: '\u2666',
  starf: '\u2605',
}

function decodeSummaryEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (raw, dec?: string, hex?: string, named?: string) => {
    if (named !== undefined) {
      const key = named.toLowerCase()
      return Object.hasOwn(SUMMARY_NAMED_ENTITIES, key) ? SUMMARY_NAMED_ENTITIES[key]! : raw
    }
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16)
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return raw
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return raw
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return raw
    }
    return String.fromCodePoint(codePoint)
  })
}

function skipIgnorableHtml(text: string, start: number): number | null {
  let cursor = start
  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4)
      if (end < 0) return null
      cursor = end + 3
      continue
    }
    break
  }
  return cursor
}

function indentColumns(line: string): number {
  let columns = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === ' ') columns += 1
    else if (ch === '\t') columns += 4 - (columns % 4)
    else break
  }
  return columns
}

function stripIndentColumns(line: string, target: number): string {
  if (!/\S/.test(line)) return ''
  let columns = 0
  let index = 0
  while (index < line.length && columns < target) {
    const ch = line[index]!
    if (ch === ' ') {
      columns += 1
      index += 1
    } else if (ch === '\t') {
      const next = columns + (4 - (columns % 4))
      if (next > target) return ' '.repeat(next - target) + line.slice(index + 1)
      columns = next
      index += 1
    } else {
      break
    }
  }
  return line.slice(index)
}

/** 剥离 HTML 缩进习惯产生的公共前导空白，避免被 CommonMark 误识别为四空格缩进代码块。 */
function dedentCommonIndent(text: string): string {
  if (!text) return text
  const lines: Array<{ text: string; breakText: string }> = []
  const lineBreak = /\r?\n/g
  let start = 0
  let minIndent = Number.POSITIVE_INFINITY
  for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
    const line = text.slice(start, match.index)
    lines.push({ text: line, breakText: match[0] })
    if (/\S/.test(line)) minIndent = Math.min(minIndent, indentColumns(line))
    start = lineBreak.lastIndex
  }
  const tail = text.slice(start)
  lines.push({ text: tail, breakText: '' })
  if (/\S/.test(tail)) minIndent = Math.min(minIndent, indentColumns(tail))
  if (!Number.isFinite(minIndent) || minIndent <= 0) return text
  return lines.map(line => stripIndentColumns(line.text, minIndent) + line.breakText).join('')
}

function isAutolinkToken(token: string): boolean {
  if (EMAIL_AUTOLINK_RE.test(token)) return true
  if (!/\s/.test(token)) {
    const uri = URI_AUTOLINK_RE.exec(token)
    if (uri && (token.includes('://') || AUTOLINK_SCHEMES.has(uri[1]!.toLowerCase()))) return true
  }
  return false
}

function hasResidualTag(text: string): boolean {
  if (!text.includes('<')) return false
  const code = markdownCodeScanner(text)
  const tokens = /<|`+|~{3,}/g
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const at = token.index
    if (token[0] !== '<') {
      const end = code.fence(at)?.end ?? code.inlineEnd(at)
      if (end !== null) tokens.lastIndex = end
      continue
    }
    RESIDUAL_TAG_RE.lastIndex = at
    const tag = RESIDUAL_TAG_RE.exec(text)
    if (!tag || isAutolinkToken(tag[0])) continue
    const closing = tag[1] === '/'
    const name = tag[2]!
    const attrs = tag[3] ?? ''
    // 放行行内泛型/占位记号（如 `Array<string>`），仍严格拦截标准 HTML/SVG/MathML、
    // 机读标签、自定义元素（含连字符）、带属性/空白标签与闭合标签。
    if (closing || isKnownHtmlElementName(name) || isDisplayMetaTagName(name)
      || CUSTOM_ELEMENT_NAME_RE.test(name) || attrs.trim().length > 0) {
      return true
    }
  }
  return false
}

/** 扫描 `<summary>` 内容：放行闭合注释、有效自动链接与摘要内配对行内代码，严禁真实 HTML 标签。 */
function scanPlainSummary(
  text: string,
  summaryStart: number,
): { summary: string; bodyStart: number; hasCodeSyntax: boolean } | null {
  const re = new RegExp(SUMMARY_SCAN_RE.source, SUMMARY_SCAN_RE.flags)
  re.lastIndex = summaryStart
  const chunks: string[] = []
  let chunkStart = summaryStart
  let blankSplit: { rawBeforeBlank: string; bodyStart: number } | null = null

  const findBalancedInlineCodeEnd = (afterOpen: number, width: number): number | null => {
    let pos = afterOpen
    while (pos < text.length) {
      const ch = text[pos]!
      if (ch === '\r' || ch === '\n') {
        const nlEnd = ch === '\r' && text[pos + 1] === '\n' ? pos + 2 : pos + 1
        let ws = nlEnd
        while (ws < text.length && (text[ws] === ' ' || text[ws] === '\t')) ws++
        if (text[ws] === '\r' || text[ws] === '\n') return null
        pos = nlEnd
        continue
      }
      if (ch === '<' && /^<\/summary\s*>/i.test(text.slice(pos, Math.min(text.length, pos + 16)))) {
        return null
      }
      if (ch === '`') {
        let runEnd = pos + 1
        while (runEnd < text.length && text[runEnd] === '`') runEnd++
        if (runEnd - pos === width) return runEnd
        pos = runEnd
        continue
      }
      pos++
    }
    return null
  }

  for (let match = re.exec(text); match; match = re.exec(text)) {
    const raw = match[0]
    const at = match.index
    if (raw[0] === '\r' || raw[0] === '\n') {
      if (!blankSplit) {
        const rawBeforeBlank = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at)
        blankSplit = { rawBeforeBlank, bodyStart: re.lastIndex }
      }
      continue
    }
    if (raw[0] === '`') {
      let slashes = 0
      for (let i = at - 1; i >= summaryStart && text[i] === '\\'; i--) slashes++
      const width = raw.length - (slashes % 2)
      if (width > 0) {
        const codeEnd = findBalancedInlineCodeEnd(re.lastIndex, width)
        if (codeEnd !== null) re.lastIndex = codeEnd
      }
      continue
    }
    // raw === '<'
    SUMMARY_CLOSE_RE.lastIndex = at
    if (SUMMARY_CLOSE_RE.exec(text)) {
      const rawSummary = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at)
      return {
        summary: decodeSummaryEntities(rawSummary).trim(),
        bodyStart: SUMMARY_CLOSE_RE.lastIndex,
        hasCodeSyntax: rawSummary.includes('`') || rawSummary.includes('~~~'),
      }
    }
    if (text.startsWith('<!--', at)) {
      const close = text.indexOf('-->', at + 4)
      if (close < 0) return null
      if (at > chunkStart) chunks.push(text.slice(chunkStart, at))
      chunkStart = close + 3
      re.lastIndex = close + 3
      continue
    }
    AUTOLINK_CANDIDATE_RE.lastIndex = at
    const autolink = AUTOLINK_CANDIDATE_RE.exec(text)
    if (autolink && isAutolinkToken(autolink[0])) {
      re.lastIndex = AUTOLINK_CANDIDATE_RE.lastIndex
      continue
    }
    const nextChar = text[at + 1]
    if (!nextChar || !/[!?/A-Za-z]/.test(nextChar)) continue
    // 命中非允许标签边界：若之前已遇到空行则退化为 #31 未闭合摘要，后续正文仍接受完整安全校验。
    if (blankSplit) {
      return {
        summary: decodeSummaryEntities(blankSplit.rawBeforeBlank).trim(),
        bodyStart: blankSplit.bodyStart,
        hasCodeSyntax: blankSplit.rawBeforeBlank.includes('`') || blankSplit.rawBeforeBlank.includes('~~~'),
      }
    }
    return null
  }
  return null
}

/**
 * 剥离包裹整块 `<details>` 的外层引用块前缀（如 `> <details>\n> <summary>...</summary>\n> 正文\n> </details>`）。
 * 只有当 `</details>` 所在行自身带有引用前缀、且内部每个非空行都共享至少同层前缀时才剥离，
 * 绝不误伤正文内部的引用行（如 `#28` 的 `<details>...>契约者: 希尔薇\n</details>`）。
 */
function unwrapBlockquotedDetails(html: string): string {
  if (!html.includes('>')) return html
  const lines: Array<{ text: string; breakText: string }> = []
  const re = /\r?\n/g
  let start = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    lines.push({ text: html.slice(start, m.index), breakText: m[0] })
    start = re.lastIndex
  }
  lines.push({ text: html.slice(start), breakText: '' })
  if (lines.length < 2) return html

  let lastNonEmpty = lines.length - 1
  while (lastNonEmpty >= 0 && !lines[lastNonEmpty]!.text.trim()) lastNonEmpty--
  if (lastNonEmpty < 1) return html

  const countQuoteDepth = (line: string): number => {
    const m = /^((?: {0,3}>[ \t]?)+)/.exec(line)
    return m ? (m[1]!.match(/>/g)?.length ?? 0) : 0
  }
  const stripQuoteDepth = (line: string, depth: number): string => {
    let rest = line
    for (let d = 0; d < depth; d++) {
      const m = /^ {0,3}>[ \t]?/.exec(rest)
      if (!m) break
      rest = rest.slice(m[0].length)
    }
    return rest
  }

  const lastLine = lines[lastNonEmpty]!.text
  const depth = countQuoteDepth(lastLine)
  if (depth === 0) return html
  if (!DETAILS_CLOSE_RE.test(stripQuoteDepth(lastLine, depth).trim())) return html

  for (let i = 1; i <= lastNonEmpty; i++) {
    const text = lines[i]!.text
    if (!text.trim()) continue
    if (countQuoteDepth(text) < depth) return html
  }
  const firstDepth = countQuoteDepth(lines[0]!.text)
  if (firstDepth > 0 && firstDepth < depth) return html

  return lines.map((line, index) => {
    if (index === 0) {
      return (firstDepth >= depth ? stripQuoteDepth(line.text, depth) : line.text) + line.breakText
    }
    return (line.text.trim() ? stripQuoteDepth(line.text, depth) : '') + line.breakText
  }).join('')
}

/**
 * 代码区间仅在不跨越未配对 `<details>`/`</details>` HTML 边界且围栏已闭合时才允许跳过，
 * 防止反引号或未闭合围栏跨过 `</details>` 将相邻 `<script>` 或第二个折叠块吞入同一代码块。
 */
function detailsSafeCodeEnd(
  text: string,
  at: number,
  code: ReturnType<typeof markdownCodeScanner>,
): number | null {
  const fence = code.fence(at)
  let end: number
  if (fence) {
    if (!fence.closed) return null
    end = fence.end
  } else {
    const inlineEnd = code.inlineEnd(at)
    if (inlineEnd === null) return null
    end = inlineEnd
  }
  const slice = text.slice(at, end)
  if (!slice.includes('<')) return end
  const boundary = new RegExp(DETAILS_BOUNDARY_RE.source, DETAILS_BOUNDARY_RE.flags)
  let localDepth = 0
  for (let match = boundary.exec(slice); match; match = boundary.exec(slice)) {
    const raw = match[0]
    if (raw.startsWith('<!--')) {
      if (!raw.endsWith('-->')) return null
      continue
    }
    if (raw.startsWith('</')) {
      if (!DETAILS_CLOSE_RE.test(raw)) return null
      if (--localDepth < 0) return null
      continue
    }
    if (raw.endsWith('/>')) return null
    localDepth++
  }
  return localDepth === 0 ? end : null
}

function findMatchingDetailsClose(
  text: string,
  start: number,
  code: ReturnType<typeof markdownCodeScanner>,
): { closeStart: number; closeEnd: number } | null {
  const tokens = new RegExp(DETAILS_TOKEN_RE.source, DETAILS_TOKEN_RE.flags)
  tokens.lastIndex = start
  let depth = 1
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const raw = token[0]
    const at = token.index
    if (raw.startsWith('<!--')) {
      if (!raw.endsWith('-->')) return null
      continue
    }
    if (raw[0] === '`' || raw[0] === '~') {
      const end = detailsSafeCodeEnd(text, at, code)
      if (end !== null) tokens.lastIndex = end
      continue
    }
    if (raw.startsWith('</')) {
      if (!DETAILS_CLOSE_RE.test(raw)) return null
      if (--depth === 0) return { closeStart: at, closeEnd: tokens.lastIndex }
      continue
    }
    if (raw.endsWith('/>')) return null
    depth++
  }
  return null
}

function parseDetailsBody(
  body: string,
  state: { count: number },
  depth: number,
): PlainDetailsChild[] | null {
  const children: PlainDetailsChild[] = []
  const chunks: string[] = []
  let chunkStart = 0
  const flushMarkdown = (endPos: number): boolean => {
    if (endPos > chunkStart) chunks.push(body.slice(chunkStart, endPos))
    chunkStart = endPos
    if (chunks.length === 0) return true
    const raw = chunks.join('')
    chunks.length = 0
    const cleaned = stripDisplayMeta(raw)
    if (!cleaned) return true
    if (hasResidualTag(cleaned)) return false
    children.push({ kind: 'markdown', text: cleaned })
    return true
  }

  const code = markdownCodeScanner(body)
  const tableLines = findGfmTableLines(body, code)
  const lineStarts: number[] = []
  if (tableLines.size > 0) {
    lineStarts.push(0)
    for (let idx = body.indexOf('\n'); idx >= 0; idx = body.indexOf('\n', idx + 1)) {
      lineStarts.push(idx + 1)
    }
  }
  let lineCursor = 0
  const isInTableLine = (pos: number): boolean => {
    if (tableLines.size === 0) return false
    while (lineCursor + 1 < lineStarts.length && lineStarts[lineCursor + 1]! <= pos) lineCursor++
    return tableLines.has(lineCursor)
  }

  const tokens = /<|`+|~{3,}/g
  for (let token = tokens.exec(body); token; token = tokens.exec(body)) {
    const at = token.index
    if (token[0] !== '<') {
      const end = detailsSafeCodeEnd(body, at, code)
      if (end !== null) tokens.lastIndex = end
      continue
    }
    if (body.startsWith('<!--', at)) {
      const close = body.indexOf('-->', at + 4)
      if (close < 0) return null
      if (at > chunkStart) chunks.push(body.slice(chunkStart, at))
      chunkStart = close + 3
      tokens.lastIndex = close + 3
      continue
    }
    if (body.startsWith('<!', at) || body.startsWith('<?', at)) return null

    if (/^<details(?=[\t\n\f\r />])/i.test(body.slice(at, Math.min(body.length, at + 16)))) {
      if (!flushMarkdown(at)) return null
      const nested = parseDetailsBlock(body, at, code, state, depth + 1)
      if (!nested) return null
      children.push({ kind: 'details', block: nested.block })
      chunkStart = nested.nextIndex
      tokens.lastIndex = nested.nextIndex
      continue
    }

    if (BR_CANDIDATE_RE.test(body.slice(at, Math.min(body.length, at + 8)))) {
      BR_PLAIN_RE.lastIndex = at
      const br = BR_PLAIN_RE.exec(body)
      if (!br) return null
      if (at > chunkStart) chunks.push(body.slice(chunkStart, at))
      chunks.push(isInTableLine(at) ? ' ' : '\n')
      chunkStart = BR_PLAIN_RE.lastIndex
      tokens.lastIndex = BR_PLAIN_RE.lastIndex
      continue
    }

    if (HR_CANDIDATE_RE.test(body.slice(at, Math.min(body.length, at + 8)))) {
      HR_PLAIN_RE.lastIndex = at
      const hr = HR_PLAIN_RE.exec(body)
      if (!hr) return null
      if (at > chunkStart) chunks.push(body.slice(chunkStart, at))
      chunks.push('\n\n---\n\n')
      chunkStart = HR_PLAIN_RE.lastIndex
      tokens.lastIndex = HR_PLAIN_RE.lastIndex
      continue
    }

    AUTOLINK_CANDIDATE_RE.lastIndex = at
    const autolink = AUTOLINK_CANDIDATE_RE.exec(body)
    if (autolink && isAutolinkToken(autolink[0])) {
      tokens.lastIndex = AUTOLINK_CANDIDATE_RE.lastIndex
      continue
    }

    BODY_TAG_RE.lastIndex = at
    const tag = BODY_TAG_RE.exec(body)
    if (tag) {
      const closing = tag[1] === '/'
      const name = tag[2]!
      if (isKnownHtmlElementName(name)) return null
      if (!isDisplayMetaTagName(name)) {
        if (CUSTOM_ELEMENT_NAME_RE.test(name)) return null
        const attrs = tag[0].slice(1 + tag[1]!.length + name.length, tag[0].length - 1)
        if (!closing && attrs.includes('=')) return null
      }
    }
  }

  if (!flushMarkdown(body.length)) return null
  return children
}

function parseDetailsBlock(
  text: string,
  start: number,
  code: ReturnType<typeof markdownCodeScanner>,
  state: { count: number },
  depth: number,
): { block: PlainDetailsBlock; nextIndex: number } | null {
  if (depth > MAX_PLAIN_DETAILS_DEPTH) return null
  if (++state.count > MAX_PLAIN_DETAILS_BLOCKS) return null

  DETAILS_OPEN_RE.lastIndex = start
  const openMatch = DETAILS_OPEN_RE.exec(text)
  if (!openMatch) return null
  const open = Boolean(openMatch[1])
  const openEnd = DETAILS_OPEN_RE.lastIndex

  let bodyStart = skipIgnorableHtml(text, openEnd)
  if (bodyStart === null) return null

  let summary: string | null = null
  let summaryHasCodeSyntax = false
  if (SUMMARY_CANDIDATE_RE.test(text.slice(bodyStart, Math.min(text.length, bodyStart + 16)))) {
    SUMMARY_OPEN_RE.lastIndex = bodyStart
    const summaryOpen = SUMMARY_OPEN_RE.exec(text)
    if (!summaryOpen) return null
    const parsedSummary = scanPlainSummary(text, SUMMARY_OPEN_RE.lastIndex)
    if (!parsedSummary) return null
    summary = parsedSummary.summary
    bodyStart = parsedSummary.bodyStart
    summaryHasCodeSyntax = parsedSummary.hasCodeSyntax
  }

  let matched: { closeStart: number; closeEnd: number } | null
  if (summaryHasCodeSyntax) {
    const rest = text.slice(bodyStart)
    const restMatched = findMatchingDetailsClose(rest, 0, markdownCodeScanner(rest))
    matched = restMatched
      ? { closeStart: bodyStart + restMatched.closeStart, closeEnd: bodyStart + restMatched.closeEnd }
      : null
  } else {
    matched = findMatchingDetailsClose(text, bodyStart, code)
  }
  if (!matched) return null

  const body = dedentCommonIndent(text.slice(bodyStart, matched.closeStart))
  const children = parseDetailsBody(body, state, depth)
  if (!children) return null

  return {
    block: { open, summary, children },
    nextIndex: matched.closeEnd,
  }
}

/**
 * 解析由一个或多个纯文本/Markdown `<details>` 组成的 HTML 片段。
 * 只要出现任意属性（除 `open`）、样式、脚本或非允许的 HTML 元素即返回 `null`。
 */
export function parsePlainDetailsBlocks(html: string): PlainDetailsBlock[] | null {
  if (!html || html.length > MAX_PLAIN_DETAILS_CHARS || !html.includes('<')) return null
  const source = unwrapBlockquotedDetails(html)
  const code = markdownCodeScanner(source)
  const state = { count: 0 }
  const blocks: PlainDetailsBlock[] = []
  let cursor = skipIgnorableHtml(source, 0)
  if (cursor === null) return null

  while (cursor < source.length) {
    const parsed = parseDetailsBlock(source, cursor, code, state, 1)
    if (!parsed) return null
    blocks.push(parsed.block)
    const next = skipIgnorableHtml(source, parsed.nextIndex)
    if (next === null) return null
    cursor = next
  }

  return blocks.length > 0 ? blocks : null
}

/** 快速判定 HTML 片段是否可完全交由原生折叠组件安全渲染。 */
export function isPlainDetailsHtml(html: string): boolean {
  return parsePlainDetailsBlocks(html) !== null
}

/** 将已解析的纯折叠块展开为可读纯文本，供只含折叠块的气泡复制正文。 */
export function formatPlainDetailsText(blocks: readonly PlainDetailsBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    const lines: string[] = []
    const summary = block.summary?.trim()
    if (summary) lines.push(summary)
    for (const child of block.children) {
      const piece = child.kind === 'markdown' ? child.text.trim() : formatPlainDetailsText([child.block])
      if (piece) lines.push(piece)
    }
    if (lines.length > 0) parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}
