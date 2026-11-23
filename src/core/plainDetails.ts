/**
 * 纯文本/Markdown `<details>` 折叠块识别与解析：
 * 无脚本、无样式、无内嵌 HTML 元素（仅允许嵌套纯 `<details>`、`<br>` 与 `<hr>`）的折叠块
 * 由客户端原生 `<details>` + `MarkdownText` 渲染，避免拆进白色/突兀的沙箱 `<iframe>`。
 * 只要结构或标签存在任何越界或疑似 HTML/脚本片段，立即返回 `null` 回退原有 `<iframe>` 隔离沙箱。
 */
import { stripDisplayMeta } from './displaySanitize.js'
import { findGfmTableLines, markdownCodeScanner } from './markdownCode.js'
import {
  AUTOLINK_CANDIDATE_RE,
  BODY_TAG_RE,
  BR_CANDIDATE_RE,
  BR_PLAIN_RE,
  CUSTOM_ELEMENT_NAME_RE,
  dedentCommonIndent,
  DETAILS_OPEN_RE,
  detailsSafeCodeEnd,
  findMatchingDetailsClose,
  HR_CANDIDATE_RE,
  HR_PLAIN_RE,
  isAutolinkToken,
  isDisplayMetaTagName,
  isKnownHtmlElementName,
  MAX_PLAIN_DETAILS_BLOCKS,
  MAX_PLAIN_DETAILS_CHARS,
  MAX_PLAIN_DETAILS_DEPTH,
  RESIDUAL_TAG_RE,
  scanPlainSummary,
  skipIgnorableHtml,
  SUMMARY_CANDIDATE_RE,
  SUMMARY_OPEN_RE,
  unwrapBlockquotedDetails,
} from './plainDetailsSyntax.js'

export type PlainDetailsChild =
  | { kind: 'markdown'; text: string }
  | { kind: 'details'; block: PlainDetailsBlock }

export interface PlainDetailsBlock {
  open: boolean
  summary: string | null
  children: PlainDetailsChild[]
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
      let endPos = BR_PLAIN_RE.lastIndex
      let brCount = 1
      while (endPos < body.length) {
        let ws = endPos
        while (ws < body.length && (body[ws] === ' ' || body[ws] === '\t')) ws++
        if (!BR_CANDIDATE_RE.test(body.slice(ws, Math.min(body.length, ws + 8)))) break
        BR_PLAIN_RE.lastIndex = ws
        const nextBr = BR_PLAIN_RE.exec(body)
        if (!nextBr) break
        endPos = BR_PLAIN_RE.lastIndex
        brCount++
      }
      const trailingBreak = /^[ \t]*(\r?\n)/.exec(body.slice(endPos))
      if (isInTableLine(at)) {
        chunks.push(' ')
      } else if (brCount >= 2) {
        const lineStart = body.lastIndexOf('\n', at - 1) + 1
        const quotePrefix = /^((?: {0,3}>[ \t]?)+)/.exec(body.slice(lineStart, at))?.[1] ?? ''
        if (trailingBreak) {
          endPos += trailingBreak[0].length
          const nextStartsQuote = Boolean(quotePrefix) && body.slice(endPos).startsWith(quotePrefix.trimEnd())
          chunks.push(quotePrefix ? `\n${quotePrefix.trimEnd()}\n${nextStartsQuote ? '' : quotePrefix}` : '\n\n')
        } else {
          chunks.push(quotePrefix ? `\n${quotePrefix.trimEnd()}\n${quotePrefix}` : '\n\n')
        }
      } else if (trailingBreak) {
        // 紧跟原始换行时复用已有换行符，避免 `<br/>\n` 与 `> A<br/>\n> B` 叠成双换行拆断段落或引用块。
        endPos += trailingBreak[0].length - trailingBreak[1]!.length
      } else {
        chunks.push('\n')
      }
      chunkStart = endPos
      tokens.lastIndex = endPos
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
