/**
 * 宿主 `MarkdownText` 展示归一化：
 * `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` 会把所有原始 HTML 节点按字面文本
 * 输出，且行首 HTML 标签会触发 CommonMark Type 6/7 HTML 块、吞掉后续代码围栏与标题。
 *
 * 本模块仅在客户端渲染 `kind: 'markdown'` 文本前调用，不修改会话存储与入模上下文：
 * - 严格保护围栏代码块（含流式未闭合围栏）、行内代码与四空格缩进代码块；
 * - 将酒馆角色卡/展示正则常见的安全格式化标签（`<br>`、`<hr>`、`http(s)` `<img>`、
 *   无属性 `<center>`/`<p>`/`<h1>`-`<h6>`/`<blockquote>`、纯样式 `<font>`/`<span>`、
 *   满足 CommonMark 边界的 `<b>`/`<strong>`/`<i>`/`<em>`/`<s>`/`<del>`/`<strike>`）
 *   转为宿主 `MarkdownText` 可直接渲染的纯净 Markdown。
 */
import { findGfmTableLines, markdownCodeScanner } from './markdownCode.js'

const FONT_SAFE_ATTRS = new Set(['color', 'size', 'face', 'style', 'class', 'title', 'dir', 'lang'])
const SPAN_SAFE_ATTRS = new Set(['style', 'class', 'title', 'dir', 'lang'])
const BLOCK_SAFE_ATTRS = new Set(['style', 'class', 'align', 'dir', 'lang'])
const QUOTE_SAFE_ATTRS = new Set(['style', 'class', 'dir', 'lang', 'cite'])
const HR_SAFE_ATTRS = new Set(['style', 'class', 'width', 'size', 'color', 'align', 'noshade'])
const BR_SAFE_ATTRS = new Set(['style', 'class', 'clear'])

const BASIC_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f'
const isUnicodeWhitespace = (ch: string): boolean => !ch || /\s/.test(ch)
const isUnicodePunctuation = (ch: string): boolean => Boolean(ch) && /[\p{P}\p{S}]/u.test(ch)
const isCjkChar = (ch: string): boolean => Boolean(ch) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)

function decodeBasicEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (raw, dec?: string, hex?: string, named?: string) => {
    if (named !== undefined) {
      const key = named.toLowerCase()
      return Object.hasOwn(BASIC_ENTITIES, key) ? BASIC_ENTITIES[key]! : raw
    }
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16)
    if (!Number.isSafeInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return raw
    if ((cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) return raw
    return String.fromCodePoint(cp)
  })
}

interface ParsedTag {
  start: number
  end: number
  closing: boolean
  name: string
  rawAttrs: string
  selfClosing: boolean
}

/** 扫描单个 HTML 标签，正确跳过属性引号内的 `>` 与 `<`。 */
function parseHtmlTagAt(text: string, start: number, limit = text.length): ParsedTag | null {
  if (start >= limit || text[start] !== '<') return null
  let pos = start + 1
  if (pos >= limit) return null
  let closing = false
  if (text[pos] === '/') {
    closing = true
    pos++
  }
  const nameStart = pos
  if (pos >= limit || !/[A-Za-z]/.test(text[pos]!)) return null
  while (pos < limit && /[A-Za-z0-9:-]/.test(text[pos]!)) pos++
  const name = text.slice(nameStart, pos).toLowerCase()
  if (pos >= limit) return null
  if (text[pos] !== '>' && text[pos] !== '/' && !isSpace(text[pos])) return null

  const attrsStart = pos
  type State = 'before-name' | 'name' | 'after-name' | 'before-value' | 'unquoted' | 'quoted' | 'after-value'
  let state: State = 'before-name'
  let quote: '"' | "'" | null = null
  for (let i = pos; i < limit; i++) {
    const ch = text[i]!
    if (state === 'quoted') {
      if (ch === quote) { quote = null; state = 'after-value' }
      continue
    }
    if (ch === '<') return null
    if (ch === '>') {
      let selfClosing = false
      let attrsEnd = i
      if (!closing && i > attrsStart && text[i - 1] === '/'
        && (state === 'before-name' || state === 'name' || state === 'after-name' || state === 'after-value')) {
        // 确认尾部 `/` 不属于未引号属性值。
        selfClosing = true
        attrsEnd = i - 1
      }
      if (closing && text.slice(attrsStart, i).trim() !== '') return null
      return {
        start,
        end: i + 1,
        closing,
        name,
        rawAttrs: text.slice(attrsStart, attrsEnd),
        selfClosing,
      }
    }
    if (state === 'before-name') {
      if (isSpace(ch) || ch === '/') continue
      state = 'name'
    } else if (state === 'name') {
      if (isSpace(ch)) state = 'after-name'
      else if (ch === '=') state = 'before-value'
      else if (ch === '/') state = 'before-name'
    } else if (state === 'after-name') {
      if (isSpace(ch)) continue
      if (ch === '=') state = 'before-value'
      else if (ch === '/') state = 'before-name'
      else state = 'name'
    } else if (state === 'before-value') {
      if (isSpace(ch)) continue
      if (ch === '"' || ch === "'") { quote = ch; state = 'quoted' }
      else state = 'unquoted'
    } else if (state === 'unquoted') {
      if (isSpace(ch)) state = 'before-name'
    } else if (state === 'after-value') {
      if (isSpace(ch) || ch === '/') state = 'before-name'
      else state = 'name'
    }
  }
  return null
}

/** 解析标签属性；出现任何 `on*` 事件属性或畸形引号时返回 `null`。 */
function parseSafeTagAttrs(rawAttrs: string): Map<string, string> | null {
  const attrs = new Map<string, string>()
  let i = 0
  const len = rawAttrs.length
  while (i < len) {
    while (i < len && (isSpace(rawAttrs[i]) || rawAttrs[i] === '/')) i++
    if (i >= len) break
    const nameStart = i
    while (i < len && !isSpace(rawAttrs[i]) && rawAttrs[i] !== '=' && rawAttrs[i] !== '/') i++
    const name = rawAttrs.slice(nameStart, i).toLowerCase()
    if (!name || !/^[a-z_:][a-z0-9_.:-]*$/i.test(name)) return null
    if (name.startsWith('on')) return null
    while (i < len && isSpace(rawAttrs[i])) i++
    let value = ''
    if (i < len && rawAttrs[i] === '=') {
      i++
      while (i < len && isSpace(rawAttrs[i])) i++
      if (i >= len) return null
      const q = rawAttrs[i]!
      if (q === '"' || q === "'") {
        i++
        const valStart = i
        const close = rawAttrs.indexOf(q, i)
        if (close < 0) return null
        value = rawAttrs.slice(valStart, close)
        i = close + 1
      } else {
        const valStart = i
        while (i < len && !isSpace(rawAttrs[i])) i++
        value = rawAttrs.slice(valStart, i)
      }
    }
    attrs.set(name, value)
  }
  return attrs
}

function hasOnlyAttrs(attrs: ReadonlyMap<string, string>, allowed: ReadonlySet<string>): boolean {
  for (const key of attrs.keys()) {
    if (!allowed.has(key)) return false
  }
  return true
}

function indentColumns(prefix: string): number {
  let cols = 0
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i]!
    if (ch === ' ') cols += 1
    else if (ch === '\t') cols += 4 - (cols % 4)
    else break
  }
  return cols
}

interface LineLayout {
  quotePrefix: string
  contentStart: number
  indentCols: number
}

function lineLayout(line: string): LineLayout {
  const qm = /^((?: {0,3}>[ \t]?)*)/.exec(line)!
  const quotePrefix = qm[1]!
  const rest = line.slice(quotePrefix.length)
  let wsEnd = 0
  while (wsEnd < rest.length && (rest[wsEnd] === ' ' || rest[wsEnd] === '\t')) wsEnd++
  return {
    quotePrefix,
    contentStart: quotePrefix.length + wsEnd,
    indentCols: indentColumns(rest.slice(0, wsEnd)),
  }
}

/** 计算每一行是否处于 CommonMark 缩进代码块内（不误判列表续行与段落续行）。 */
function findIndentedCodeLines(lines: readonly string[]): Set<number> {
  const result = new Set<number>()
  let canStartIndented = true
  let prevQuoteDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const layout = lineLayout(line)
    const quoteDepth = layout.quotePrefix.match(/>/g)?.length ?? 0
    if (quoteDepth !== prevQuoteDepth) {
      canStartIndented = true
      prevQuoteDepth = quoteDepth
    }
    const content = line.slice(layout.contentStart)
    if (!content) {
      canStartIndented = true
      continue
    }
    if (layout.indentCols >= 4 && canStartIndented) {
      result.add(i)
      canStartIndented = true
      continue
    }
    // 标题或分割线后可开启缩进代码块，段落与列表项后不可中断。
    canStartIndented = /^(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$)/.test(content)
  }
  return result
}

interface MaskedCode {
  masked: string
  prefix: string
  suffix: string
  saved: string[]
  restore: (value: string) => string
}

/** 用唯一占位符保护 Markdown 围栏代码（含流式未闭合围栏）与行内代码。 */
function maskMarkdownCode(text: string): MaskedCode {
  const hasCode = text.includes('`') || text.includes('~~~')
  if (!hasCode) {
    return { masked: text, prefix: '', suffix: '', saved: [], restore: value => value }
  }
  const scanner = markdownCodeScanner(text)
  const ranges: Array<{ start: number; end: number }> = []
  const tokens = /`+|~{3,}/g
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const at = token.index
    const fence = scanner.fence(at)
    if (fence) {
      let end = fence.end
      while (end > at && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--
      ranges.push({ start: at, end })
      tokens.lastIndex = Math.max(fence.end, at + 1)
      continue
    }
    const inlineEnd = scanner.inlineEnd(at)
    if (inlineEnd !== null) {
      ranges.push({ start: at, end: inlineEnd })
      tokens.lastIndex = inlineEnd
    }
  }
  if (ranges.length === 0) {
    return { masked: text, prefix: '', suffix: '', saved: [], restore: value => value }
  }
  let prefix = '\uE000tavernHm'
  while (text.includes(prefix)) prefix += 'X'
  const suffix = '\uE001'
  const saved: string[] = []
  let masked = ''
  let cursor = 0
  for (const [index, range] of ranges.entries()) {
    masked += text.slice(cursor, range.start) + `${prefix}${index}${suffix}`
    saved.push(text.slice(range.start, range.end))
    cursor = range.end
  }
  masked += text.slice(cursor)
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${suffix}`, 'g')
  return {
    masked,
    prefix,
    suffix,
    saved,
    restore: value => value.replace(pattern, (_raw, index: string) => saved[Number(index)] ?? ''),
  }
}

/** 将行内占位符边界字符还原为真实源码字符，确保 CommonMark 左右贴合判断准确。 */
function boundaryChar(text: string, index: number, side: 'start' | 'end', mask: MaskedCode): string {
  if (index < 0 || index >= text.length) return ''
  const ch = text[index]!
  if (!mask.prefix) return ch
  if (side === 'start' && ch === mask.prefix[0] && text.startsWith(mask.prefix, index)) {
    const close = text.indexOf(mask.suffix, index + mask.prefix.length)
    if (close > 0) {
      const original = mask.saved[Number(text.slice(index + mask.prefix.length, close))]
      if (original) return original[0] ?? ''
    }
  }
  if (side === 'end' && ch === mask.suffix) {
    const open = text.lastIndexOf(mask.prefix, index)
    if (open >= 0) {
      const idxStr = text.slice(open + mask.prefix.length, index)
      if (/^\d+$/.test(idxStr)) {
        const original = mask.saved[Number(idxStr)]
        if (original) return original[original.length - 1] ?? ''
      }
    }
  }
  return ch
}

function splitLinesWithBreaks(text: string): { lines: string[]; breaks: string[] } {
  const lines: string[] = []
  const breaks: string[] = []
  const re = /\r?\n/g
  let start = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push(text.slice(start, m.index))
    breaks.push(m[0])
    start = re.lastIndex
  }
  lines.push(text.slice(start))
  return { lines, breaks }
}

function joinLinesWithBreaks(lines: readonly string[], breaks: readonly string[]): string {
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]!
    if (i < breaks.length) out += breaks[i]!
  }
  return out
}

function isPlaceholderLine(content: string, mask: MaskedCode): boolean {
  if (!mask.prefix) return false
  return content.startsWith(mask.prefix) && content.endsWith(mask.suffix)
}

/** Pass 1：将安全 `http(s)` `<img>` 转为标准 Markdown 图片语法 `![alt](src)`。 */
function convertSafeImages(text: string, mask: MaskedCode): string {
  if (!/<img(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const tableLines = findGfmTableLines(text)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    const line = lines[i]!
    if (!/<img(?=[\s/>])/i.test(line)) continue
    const inTable = tableLines.has(i)
    let out = ''
    let cursor = 0
    let pos = 0
    let lineChanged = false
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag || tag.closing || tag.name !== 'img') {
        pos = open + 1
        continue
      }
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      const rawSrc = attrs?.get('src')
      if (!attrs || rawSrc === undefined) {
        pos = tag.end
        continue
      }
      const src = decodeBasicEntities(rawSrc).trim()
      if (!/^https?:\/\/\S+$/i.test(src) || /[\u0000-\u001f\u007f]/.test(src)) {
        pos = tag.end
        continue
      }
      const safeUrl = src.replace(/[()<>]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
        .replace(/\|/g, inTable ? '%7C' : '|')
      const rawAlt = decodeBasicEntities(attrs.get('alt') ?? '').replace(/\r?\n/g, ' ').trim()
      const safeAlt = rawAlt.replace(/([\\[\]])/g, '\\$1').replace(/\|/g, inTable ? '\\|' : '|')
      out += line.slice(cursor, tag.start) + `![${safeAlt}](${safeUrl})`
      cursor = tag.end
      pos = tag.end
      lineChanged = true
    }
    if (lineChanged) {
      out += line.slice(cursor)
      lines[i] = out
      changed = true
    }
  }
  void mask
  return changed ? joinLinesWithBreaks(lines, breaks) : text
}

/** Pass 2：剥离纯样式 `<font ...>`/`</font>` 与 `<span ...>`/`</span>` 外壳。 */
function unwrapSafeFontAndSpan(text: string): string {
  if (!/<\/?(?:font|span)(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  // 记录每个字符偏移所在行号，确保缩进代码块不被触碰。
  const lineStarts: number[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset)
    offset += lines[i]!.length + (i < breaks.length ? breaks[i]!.length : 0)
  }
  const lineOfOffset = (pos: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const removeRanges: Array<{ start: number; end: number }> = []
  const stacks: Record<'font' | 'span', Array<{ start: number; end: number; safe: boolean }>> = {
    font: [],
    span: [],
  }
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) break
    const tag = parseHtmlTagAt(text, open)
    if (!tag) { pos = open + 1; continue }
    if (tag.name !== 'font' && tag.name !== 'span') { pos = tag.end; continue }
    const lineIdx = lineOfOffset(tag.start)
    if (indented.has(lineIdx)) { pos = tag.end; continue }
    const stack = stacks[tag.name]
    if (!tag.closing) {
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      const allowed = tag.name === 'font' ? FONT_SAFE_ATTRS : SPAN_SAFE_ATTRS
      const safe = attrs !== null && hasOnlyAttrs(attrs, allowed)
      if (tag.selfClosing) {
        if (safe) removeRanges.push({ start: tag.start, end: tag.end })
      } else {
        stack.push({ start: tag.start, end: tag.end, safe })
      }
    } else if (stack.length > 0) {
      const opened = stack.pop()!
      if (opened.safe) {
        removeRanges.push({ start: opened.start, end: opened.end })
        removeRanges.push({ start: tag.start, end: tag.end })
      }
    } else {
      // 孤立闭标签若独占整行会触发 CommonMark Type 7 HTML 块并吞掉后续围栏，安全剥离。
      const line = lines[lineIdx]!
      const layout = lineLayout(line)
      const localStart = tag.start - lineStarts[lineIdx]!
      const localEnd = tag.end - lineStarts[lineIdx]!
      if (line.slice(layout.contentStart, localStart).trim() === '' && line.slice(localEnd).trim() === '') {
        removeRanges.push({ start: tag.start, end: tag.end })
      }
    }
    pos = tag.end
  }
  // 跨 HTML 卡片拆分后留下的独占行安全开标签同样剥离，避免吞掉后续围栏。
  for (const name of ['font', 'span'] as const) {
    for (const opened of stacks[name]) {
      if (!opened.safe) continue
      const lineIdx = lineOfOffset(opened.start)
      const line = lines[lineIdx]!
      const layout = lineLayout(line)
      const localStart = opened.start - lineStarts[lineIdx]!
      const localEnd = opened.end - lineStarts[lineIdx]!
      if (line.slice(layout.contentStart, localStart).trim() === '' && line.slice(localEnd).trim() === '') {
        removeRanges.push({ start: opened.start, end: opened.end })
      }
    }
  }
  if (removeRanges.length === 0) return text
  removeRanges.sort((a, b) => a.start - b.start)

  // 按行应用删除：整行原本只含被删标签时连同该行一并删去，避免凭空插入多余空行。
  const perLine = new Map<number, Array<{ start: number; end: number }>>()
  for (const range of removeRanges) {
    const startLine = lineOfOffset(range.start)
    const endLine = lineOfOffset(Math.max(range.start, range.end - 1))
    if (startLine !== endLine) {
      // 罕见跨行属性标签直接按字符范围剔除。
      let out = ''
      let cursor = 0
      for (const item of removeRanges) {
        if (item.start > cursor) out += text.slice(cursor, item.start)
        cursor = Math.max(cursor, item.end)
      }
      out += text.slice(cursor)
      return out
    }
    const base = lineStarts[startLine]!
    const list = perLine.get(startLine) ?? []
    list.push({ start: range.start - base, end: range.end - base })
    perLine.set(startLine, list)
  }

  const nextLines: string[] = []
  const nextBreaks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cuts = perLine.get(i)
    if (!cuts) {
      nextLines.push(line)
      if (i < breaks.length) nextBreaks.push(breaks[i]!)
      continue
    }
    const layout = lineLayout(line)
    let stripped = ''
    let cursor = 0
    for (const cut of cuts) {
      if (cut.start > cursor) stripped += line.slice(cursor, cut.start)
      cursor = Math.max(cursor, cut.end)
    }
    stripped += line.slice(cursor)
    if (stripped.slice(layout.quotePrefix.length).trim() === '') {
      // 整行仅由被剥离的样式标签构成：丢弃该行本身。
      continue
    }
    nextLines.push(stripped)
    if (i < breaks.length) nextBreaks.push(breaks[i]!)
  }
  // 去掉末行多余的尾换行（如果原末行被丢弃）。
  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
}

/** Pass 3：处理块级包装标签（`<center>`、`<p>`、`<h1>`-`<h6>`、`<blockquote>`、`<hr>`）。 */
function normalizeBlockHtml(text: string): string {
  if (!/<\/?(?:center|p|h[1-6]|blockquote|hr)(?=[\s/>])/i.test(text)) return text
  let current = text

  // 3a: 配对 <blockquote>...</blockquote>（由内向外，最多 4 层）
  for (let pass = 0; pass < 4; pass++) {
    if (!/<blockquote(?=[\s/>])/i.test(current)) break
    const { lines, breaks } = splitLinesWithBreaks(current)
    const indented = findIndentedCodeLines(lines)
    const lineStarts: number[] = []
    let off = 0
    for (let i = 0; i < lines.length; i++) {
      lineStarts.push(off)
      off += lines[i]!.length + (i < breaks.length ? breaks[i]!.length : 0)
    }
    const lineOf = (pos: number): number => {
      let lo = 0, hi = lineStarts.length - 1
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= pos) lo = mid; else hi = mid - 1 }
      return lo
    }
    let replaced = false
    let pos = 0
    const stack: Array<{ tag: ParsedTag; safe: boolean }> = []
    let target: { open: ParsedTag; close: ParsedTag } | null = null
    while (pos < current.length) {
      const open = current.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(current, open)
      if (!tag) { pos = open + 1; continue }
      if (tag.name !== 'blockquote') { pos = tag.end; continue }
      if (indented.has(lineOf(tag.start))) { pos = tag.end; continue }
      if (!tag.closing && !tag.selfClosing) {
        const attrs = parseSafeTagAttrs(tag.rawAttrs)
        stack.push({ tag, safe: attrs !== null && hasOnlyAttrs(attrs, QUOTE_SAFE_ATTRS) })
      } else if (tag.closing && stack.length > 0) {
        const opened = stack.pop()!
        if (opened.safe) {
          target = { open: opened.tag, close: tag }
          break
        }
      }
      pos = tag.end
    }
    if (!target) break
    const openLineIdx = lineOf(target.open.start)
    const outerPrefix = lineLayout(lines[openLineIdx]!).quotePrefix
    const inner = current.slice(target.open.end, target.close.start).replace(/^\s*\r?\n/, '').replace(/\r?\n[ \t]*$/, '').trim()
    const quotedInner = inner
      ? inner.split(/\r?\n/).map(l => {
          const clean = outerPrefix && l.startsWith(outerPrefix) ? l.slice(outerPrefix.length) : l
          return clean.trim() ? `${outerPrefix}> ${clean.trimStart()}` : `${outerPrefix}>`
        }).join('\n')
      : ''
    const before = current.slice(0, target.open.start)
    const after = current.slice(target.close.end)
    const beforeOnLine = before.slice(lineStarts[openLineIdx]!).slice(outerPrefix.length)
    const needLead = beforeOnLine.trim() !== '' ? '\n\n' : ''
    let trail = ''
    if (after) {
      if (!/^[ \t]*\r?\n/.test(after)) {
        trail = `\n\n${outerPrefix}`
      } else if (!/^[ \t]*\r?\n[ \t]*(?:\r?\n|$)/.test(after)) {
        // CommonMark 的引用块懒延续会把紧跟的非空行吸入 blockquote，需补一个空行分隔。
        trail = `\n${outerPrefix.trimEnd()}`
      }
    }
    current = (needLead ? before.trimEnd() + needLead : before.slice(0, lineStarts[openLineIdx]!))
      + quotedInner + trail + after
    replaced = true
    if (!replaced) break
  }

  // 3b: 配对 <h1>..<h6> 标题
  if (/<h[1-6](?=[\s/>])/i.test(current)) {
    const { lines, breaks } = splitLinesWithBreaks(current)
    const indented = findIndentedCodeLines(lines)
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      if (indented.has(i)) continue
      const line = lines[i]!
      if (!/<h[1-6](?=[\s/>])/i.test(line)) continue
      const layout = lineLayout(line)
      const trimmed = line.slice(layout.contentStart).trimEnd()
      const openTag = parseHtmlTagAt(trimmed, 0)
      if (!openTag || openTag.closing || openTag.selfClosing || !/^h[1-6]$/.test(openTag.name)) continue
      const attrs = parseSafeTagAttrs(openTag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) continue
      const closeRe = new RegExp(`</${openTag.name}\\s*>$`, 'i')
      const closeMatch = closeRe.exec(trimmed.slice(openTag.end))
      if (!closeMatch) continue
      const inner = trimmed.slice(openTag.end, openTag.end + closeMatch.index).trim()
      if (!inner || /<\/?(?:div|table|section|article|details|script|style|iframe|h[1-6])\b/i.test(inner)) continue
      const level = Number(openTag.name[1])
      lines[i] = `${layout.quotePrefix}${'#'.repeat(level)} ${inner}`
      changed = true
    }
    if (changed) current = joinLinesWithBreaks(lines, breaks)
  }

  // 3c: <center> 与 <p>（成对同行与独占行）及 <hr>
  if (/<\/?(?:center|p|hr)(?=[\s/>])/i.test(current)) {
    const { lines, breaks } = splitLinesWithBreaks(current)
    const indented = findIndentedCodeLines(lines)
    const nextLines: string[] = []
    const nextBreaks: string[] = []
    let changed = false

    const pushLine = (line: string, br: string | undefined) => {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const br = i < breaks.length ? breaks[i] : undefined
      if (indented.has(i) || !/<\/?(?:center|p|hr)(?=[\s/>])/i.test(line)) {
        pushLine(line, br)
        continue
      }
      const layout = lineLayout(line)
      const content = line.slice(layout.contentStart).trimEnd()

      // 独占行的 <hr> / <hr/> → ---，并确保前后有空行（防止前一行被 CommonMark 误判为 Setext H2！）
      const singleTag = parseHtmlTagAt(content, 0)
      if (singleTag && singleTag.end === content.length) {
        if (singleTag.name === 'hr' && !singleTag.closing) {
          const attrs = parseSafeTagAttrs(singleTag.rawAttrs)
          if (attrs && hasOnlyAttrs(attrs, HR_SAFE_ATTRS)) {
            changed = true
            const prevLine = nextLines[nextLines.length - 1]
            if (prevLine !== undefined && prevLine.slice(lineLayout(prevLine).quotePrefix.length).trim() !== '') {
              pushLine(layout.quotePrefix.trimEnd(), '\n')
            }
            pushLine(`${layout.quotePrefix}---`, br ?? undefined)
            const nextOrig = lines[i + 1]
            if (nextOrig !== undefined && nextOrig.slice(lineLayout(nextOrig).quotePrefix.length).trim() !== '') {
              pushLine(layout.quotePrefix.trimEnd(), '\n')
            }
            continue
          }
        }
        if (singleTag.name === 'center') {
          const attrs = singleTag.closing ? new Map<string, string>() : parseSafeTagAttrs(singleTag.rawAttrs)
          if (attrs && attrs.size === 0) {
            changed = true
            // 丢弃独占行的无属性 <center> / </center>
            continue
          }
        }
        if (singleTag.name === 'p') {
          const attrs = singleTag.closing ? new Map<string, string>() : parseSafeTagAttrs(singleTag.rawAttrs)
          if (attrs && hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) {
            changed = true
            if (!singleTag.closing) {
              const prevLine = nextLines[nextLines.length - 1]
              if (prevLine !== undefined && prevLine.slice(lineLayout(prevLine).quotePrefix.length).trim() !== '') {
                pushLine(layout.quotePrefix.trimEnd(), '\n')
              }
            } else {
              const nextOrig = lines[i + 1]
              if (nextOrig !== undefined && nextOrig.slice(lineLayout(nextOrig).quotePrefix.length).trim() !== '') {
                pushLine(layout.quotePrefix.trimEnd(), '\n')
              }
            }
            continue
          }
        }
      }

      // 行内出现 <center>...</center>、<p>...</p> 或行内 <hr>
      let working = content
      let lineChanged = false
      // 拆解无属性单行 <center>内容</center>
      const centerOpen = parseHtmlTagAt(working, 0)
      if (centerOpen && !centerOpen.closing && !centerOpen.selfClosing && centerOpen.name === 'center' && centerOpen.rawAttrs.trim() === '') {
        const closeCenter = /<\/center\s*>$/i.exec(working.slice(centerOpen.end))
        if (closeCenter) {
          working = working.slice(centerOpen.end, centerOpen.end + closeCenter.index).trim()
          lineChanged = true
        }
      }
      // 行内 <p>...</p> 与 <hr>
      if (/<\/?(?:p|hr)(?=[\s/>])/i.test(working)) {
        let out = ''
        let cursor = 0
        let pos = 0
        let pDepth = 0
        while (pos < working.length) {
          const open = working.indexOf('<', pos)
          if (open < 0) break
          const tag = parseHtmlTagAt(working, open)
          if (!tag) { pos = open + 1; continue }
          if (tag.name === 'hr' && !tag.closing) {
            const attrs = parseSafeTagAttrs(tag.rawAttrs)
            if (attrs && hasOnlyAttrs(attrs, HR_SAFE_ATTRS)) {
              out += working.slice(cursor, tag.start).trimEnd()
              if (out.trim()) out += `\n${layout.quotePrefix.trimEnd()}\n`
              out += `${layout.quotePrefix}---`
              const rest = working.slice(tag.end).trimStart()
              if (rest) out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
              cursor = tag.end + (working.slice(tag.end).length - rest.length)
              pos = cursor
              lineChanged = true
              continue
            }
          }
          if (tag.name === 'p') {
            const attrs = tag.closing ? new Map<string, string>() : parseSafeTagAttrs(tag.rawAttrs)
            if (attrs && hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) {
              if (!tag.closing && !tag.selfClosing) {
                const before = working.slice(cursor, tag.start)
                if (out.length + before.trim().length > 0 && !out.endsWith('\n\n') && before.trim()) {
                  out += before.trimEnd() + `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
                } else {
                  out += before
                }
                pDepth++
                cursor = tag.end
                pos = tag.end
                lineChanged = true
                continue
              }
              if (tag.closing) {
                out += working.slice(cursor, tag.start).trimEnd()
                const rest = working.slice(tag.end).trimStart()
                if (rest) {
                  out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
                }
                if (pDepth > 0) pDepth--
                cursor = tag.end + (working.slice(tag.end).length - rest.length)
                pos = cursor
                lineChanged = true
                continue
              }
            }
          }
          pos = tag.end
        }
        if (lineChanged) {
          out += working.slice(cursor)
          working = out
        }
      }
      if (lineChanged) {
        changed = true
        const prefix = line.slice(0, layout.contentStart)
        const emitted = working.startsWith(layout.quotePrefix) ? working : prefix + working
        pushLine(emitted, br)
        // 行尾闭合 </p> 后紧跟另一段落时确保空行分隔。
        if (/<\/p\s*>$/i.test(content)) {
          const nextOrig = lines[i + 1]
          if (nextOrig !== undefined && nextOrig.slice(lineLayout(nextOrig).quotePrefix.length).trim() !== '') {
            pushLine(layout.quotePrefix.trimEnd(), '\n')
          }
        }
      } else {
        pushLine(line, br)
      }
    }
    if (changed) {
      while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
      current = joinLinesWithBreaks(nextLines, nextBreaks)
    }
  }

  return current
}

const INLINE_FORMAT_MAP: Record<string, { marker: '**' | '*' | '~~'; cjkFriendly: boolean }> = {
  b: { marker: '**', cjkFriendly: true },
  strong: { marker: '**', cjkFriendly: true },
  i: { marker: '*', cjkFriendly: false },
  em: { marker: '*', cjkFriendly: false },
  s: { marker: '~~', cjkFriendly: false },
  del: { marker: '~~', cjkFriendly: false },
  strike: { marker: '~~', cjkFriendly: false },
}

function canFlank(
  before: string,
  first: string,
  last: string,
  after: string,
  marker: '**' | '*' | '~~',
  cjkFriendly: boolean,
): boolean {
  if (!first || !last || isUnicodeWhitespace(first) || isUnicodeWhitespace(last)) return false
  const markerChar = marker[0]!
  if (before === markerChar || after === markerChar) return false
  const leftOk = !isUnicodePunctuation(first)
    || isUnicodeWhitespace(before)
    || isUnicodePunctuation(before)
    || (cjkFriendly && isCjkChar(before))
  const rightOk = !isUnicodePunctuation(last)
    || isUnicodeWhitespace(after)
    || isUnicodePunctuation(after)
    || (cjkFriendly && isCjkChar(after))
  return leftOk && rightOk
}

/** Pass 4：把满足 CommonMark 贴合条件的无属性行内格式化标签转为 Markdown 强调/删除线。 */
function convertSafeInlineFormatting(text: string, mask: MaskedCode): string {
  if (!/<(?:b|strong|i|em|s|del|strike)\s*>/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    let line = lines[i]!
    if (!/<(?:b|strong|i|em|s|del|strike)\s*>/i.test(line)) continue
    let lineChanged = false

    for (let pass = 0; pass < 3; pass++) {
      let out = ''
      let cursor = 0
      let pos = 0
      let passChanged = false
      while (pos < line.length) {
        const open = line.indexOf('<', pos)
        if (open < 0) break
        const tag = parseHtmlTagAt(line, open)
        if (!tag || tag.closing || tag.selfClosing || tag.rawAttrs.trim() !== '') {
          pos = tag ? tag.end : open + 1
          continue
        }
        const spec = INLINE_FORMAT_MAP[tag.name]
        if (!spec) { pos = tag.end; continue }
        const closeRe = new RegExp(`</${tag.name}\\s*>`, 'gi')
        closeRe.lastIndex = tag.end
        const closeMatch = closeRe.exec(line)
        if (!closeMatch) { pos = tag.end; continue }
        const inner = line.slice(tag.end, closeMatch.index)
        // 含嵌套标签或未消费尖括号时留给更内层或跳过，避免破坏结构。
        if (inner.includes('<') || inner.includes('>')) { pos = tag.end; continue }
        const leadSpaces = /^[ \t]*/.exec(inner)![0]!
        const trailSpaces = /[ \t]*$/.exec(inner)![0]!
        const core = inner.slice(leadSpaces.length, inner.length - trailSpaces.length)
        if (!core) { pos = closeRe.lastIndex; continue }
        // 避免和内容已有定界符冲突；仅允许 ** 包裹外层单 * 斜体形成 ***...***。
        const hasConflict = spec.marker === '**'
          ? (core.includes('**') || (core.includes('*') && !/^\*[^*]+\*$/.test(core)))
          : spec.marker === '*'
            ? core.includes('*')
            : core.includes('~')
        if (hasConflict) { pos = closeRe.lastIndex; continue }

        const beforeIdx = leadSpaces.length > 0 ? -1 : tag.start - 1
        const afterIdx = trailSpaces.length > 0 ? -1 : closeRe.lastIndex
        const beforeChar = leadSpaces.length > 0 ? ' ' : boundaryChar(line, beforeIdx, 'end', mask)
        const afterChar = trailSpaces.length > 0 ? ' ' : boundaryChar(line, afterIdx, 'start', mask)
        const firstChar = boundaryChar(core, 0, 'start', mask)
        const lastChar = boundaryChar(core, core.length - 1, 'end', mask)
        if (!canFlank(beforeChar, firstChar, lastChar, afterChar, spec.marker, spec.cjkFriendly)) {
          pos = closeRe.lastIndex
          continue
        }
        out += line.slice(cursor, tag.start) + leadSpaces + spec.marker + core + spec.marker + trailSpaces
        cursor = closeRe.lastIndex
        pos = closeRe.lastIndex
        passChanged = true
      }
      if (!passChanged) break
      out += line.slice(cursor)
      line = out
      lineChanged = true
    }

    if (lineChanged) {
      lines[i] = line
      changed = true
    }
  }

  return changed ? joinLinesWithBreaks(lines, breaks) : text
}

/** Pass 5：按上下文把 `<br>` 转为 GFM 表格空格、独立空行或 CommonMark 硬换行。 */
function convertSafeLineBreaks(text: string, mask: MaskedCode): string {
  if (!/<br(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const tableLines = findGfmTableLines(text)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    const line = lines[i]!
    if (!/<br(?=[\s/>])/i.test(line)) continue
    const layout = lineLayout(line)
    const content = line.slice(layout.contentStart)
    if (isPlaceholderLine(content.trim(), mask)) continue

    // 收集本行所有安全 <br> 位置
    const brTags: ParsedTag[] = []
    let pos = layout.contentStart
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag) { pos = open + 1; continue }
      if (tag.name === 'br' && !tag.closing) {
        const attrs = parseSafeTagAttrs(tag.rawAttrs)
        if (attrs && hasOnlyAttrs(attrs, BR_SAFE_ATTRS)) {
          brTags.push(tag)
        }
      }
      pos = tag.end
    }
    if (brTags.length === 0) continue

    // 表格行绝不能拆成多行，否则整张 GFM 表格失效；用空格替代。
    if (tableLines.has(i)) {
      let out = ''
      let cursor = 0
      let idx = 0
      while (idx < brTags.length) {
        const start = brTags[idx]!.start
        let end = brTags[idx]!.end
        while (idx + 1 < brTags.length && line.slice(end, brTags[idx + 1]!.start).trim() === '') {
          idx++
          end = brTags[idx]!.end
        }
        const before = line.slice(cursor, start)
        const afterChar = line[end]
        const needSpace = before.length > 0 && !/[\s|]$/.test(before) && afterChar !== undefined && !/^[\s|]/.test(afterChar)
        out += before + (needSpace ? ' ' : '')
        cursor = end
        idx++
      }
      out += line.slice(cursor)
      lines[i] = out
      changed = true
      continue
    }

    // 整行仅由 <br> 与空白构成：转为同引用层级的空行，避免触发 Type 7 HTML 块吞掉后续围栏。
    let nonBr = ''
    let cursor = layout.contentStart
    for (const tag of brTags) {
      nonBr += line.slice(cursor, tag.start)
      cursor = tag.end
    }
    nonBr += line.slice(cursor)
    if (nonBr.trim() === '') {
      lines[i] = layout.quotePrefix.trimEnd()
      changed = true
      continue
    }

    // 行内 <br>：区分连续段落断行、行尾硬换行与行中硬换行。
    const nextLine = lines[i + 1]
    const nextContent = nextLine !== undefined ? nextLine.slice(lineLayout(nextLine).contentStart) : ''
    const nextIsContinuation = nextLine !== undefined
      && nextContent.trim() !== ''
      && !isPlaceholderLine(nextContent.trim(), mask)
      && !/^(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|[-+*][ \t]+|\d{1,9}[.)][ \t]+)/.test(nextContent)

    let out = ''
    let c = 0
    let idx = 0
    while (idx < brTags.length) {
      const start = brTags[idx]!.start
      let end = brTags[idx]!.end
      let runCount = 1
      while (idx + 1 < brTags.length && line.slice(end, brTags[idx + 1]!.start).trim() === '') {
        idx++
        end = brTags[idx]!.end
        runCount++
      }
      const before = line.slice(c, start).replace(/[ \t]+$/, '')
      const afterSlice = line.slice(end)
      const afterTrimmed = afterSlice.replace(/^[ \t]+/, '')
      const atLineEnd = afterTrimmed === ''
      out += before
      if (atLineEnd) {
        if (runCount >= 2 && nextLine !== undefined && nextContent.trim() !== '') {
          out += `\n${layout.quotePrefix.trimEnd()}`
        } else if (runCount === 1 && nextIsContinuation) {
          out += '  '
        }
        c = line.length
      } else if (runCount >= 2) {
        out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
        c = end + (afterSlice.length - afterTrimmed.length)
      } else {
        out += `  \n${layout.quotePrefix}`
        c = end + (afterSlice.length - afterTrimmed.length)
      }
      idx++
    }
    if (c < line.length) out += line.slice(c)
    lines[i] = out
    changed = true
  }

  return changed ? joinLinesWithBreaks(lines, breaks) : text
}

/**
 * 将送入宿主 `MarkdownText` 的普通 Markdown 文本做只读展示归一化，
 * 避免酒馆角色卡内常见安全 HTML 标签原样裸露或触发 CommonMark HTML 块吞掉代码围栏。
 */
export function normalizeHostMarkdown(text: string): string {
  if (!text || !text.includes('<')) return text
  const mask = maskMarkdownCode(text)
  let out = mask.masked
  out = convertSafeImages(out, mask)
  out = unwrapSafeFontAndSpan(out)
  out = normalizeBlockHtml(out)
  out = convertSafeInlineFormatting(out, mask)
  out = convertSafeLineBreaks(out, mask)
  if (out === mask.masked) return text
  return mask.restore(out.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1'))
}
