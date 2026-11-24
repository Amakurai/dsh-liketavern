/**
 * 纯文本/Markdown `<details>` 折叠块识别与解析：
 * 无脚本、无样式、无内嵌 HTML 元素（仅允许嵌套纯 `<details>`、`<br>` 与 `<hr>`）的折叠块
 * 由客户端原生 `<details>` + `MarkdownText` 渲染，避免拆进白色/突兀的沙箱 `<iframe>`。
 * 只要结构或标签存在任何越界或疑似 HTML/脚本片段，立即返回 `null` 回退原有 `<iframe>` 隔离沙箱。
 */
import { stripDisplayMeta } from './displaySanitize.js'
import { markdownCodeScanner } from './markdownCode.js'
import {
  dedentCommonIndent,
  DETAILS_OPEN_RE,
  findMatchingDetailsClose,
  hasResidualTag,
  MAX_PLAIN_DETAILS_BLOCKS,
  MAX_PLAIN_DETAILS_CHARS,
  MAX_PLAIN_DETAILS_DEPTH,
  scanPlainDetailsBody,
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

function parseDetailsBody(
  body: string,
  state: { count: number },
  depth: number,
): PlainDetailsChild[] | null {
  const children: PlainDetailsChild[] = []
  const ok = scanPlainDetailsBody(
    body,
    raw => {
      const cleaned = stripDisplayMeta(raw)
      if (!cleaned) return true
      if (hasResidualTag(cleaned)) return false
      children.push({ kind: 'markdown', text: cleaned })
      return true
    },
    (nestedStart, code) => {
      const nested = parseDetailsBlock(body, nestedStart, code, state, depth + 1)
      if (!nested) return null
      children.push({ kind: 'details', block: nested.block })
      return nested.nextIndex
    },
  )
  return ok ? children : null
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
