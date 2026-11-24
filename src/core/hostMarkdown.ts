/**
 * 宿主 `MarkdownText` 展示归一化：
 * `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` 会把所有原始 HTML 节点按字面文本
 * 输出，且行首 HTML 标签会触发 CommonMark Type 6/7 HTML 块、吞掉后续代码围栏与标题。
 *
 * 本模块仅在客户端渲染 `kind: 'markdown'` 文本前调用，不修改会话存储与入模上下文：
 * - 严格保护围栏代码块（含流式未闭合围栏）、行内代码与四空格缩进代码块；
 * - 将酒馆角色卡/展示正则常见的安全格式化标签（`<br>`、`<hr>`、`http(s)` `<img>`/`<a>`、
 *   `<pre>`/`<code>`/`<kbd>`、`<ruby>` 注音、无属性 `<center>`、安全 `<p>`/`<h1>`-`<h6>`/`<blockquote>`、
 *   纯样式 `<font>`/`<span>`/`<small>`/`<mark>`/`<u>`、
 *   满足 CommonMark 边界的纯样式 `<b>`/`<strong>`/`<i>`/`<em>`/`<s>`/`<del>`/`<strike>`）
 *   转为宿主 `MarkdownText` 可直接渲染的纯净 Markdown，并清理会吞掉代码围栏的孤立闭合块标签。
 */
import { findGfmTableLines, markdownCodeScanner } from './markdownCode.js'

const FONT_SAFE_ATTRS = new Set(['color', 'size', 'face', 'style', 'class', 'title', 'dir', 'lang'])
const SPAN_SAFE_ATTRS = new Set(['style', 'class', 'title', 'dir', 'lang'])
const ANCHOR_SAFE_ATTRS = new Set(['href', 'title', 'target', 'rel', 'class', 'style', 'dir', 'lang'])
const BLOCK_SAFE_ATTRS = new Set(['style', 'class', 'align', 'dir', 'lang'])
const QUOTE_SAFE_ATTRS = new Set(['style', 'class', 'dir', 'lang', 'cite'])
const HR_SAFE_ATTRS = new Set(['style', 'class', 'width', 'size', 'color', 'align', 'noshade'])
const BR_SAFE_ATTRS = new Set(['style', 'class', 'clear'])
const PRESENTATIONAL_WRAPPER_NAMES = new Set(['font', 'span', 'small', 'mark', 'u'])

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
  protect: (original: string) => string
  restore: (value: string) => string
}

/** 用唯一占位符保护 Markdown 围栏代码（含流式未闭合围栏）与行内代码，并支持后续 pass 动态登记新生成的代码块。 */
function maskMarkdownCode(text: string): MaskedCode {
  const ranges: Array<{ start: number; end: number }> = []
  if (text.includes('`') || text.includes('~~~')) {
    const scanner = markdownCodeScanner(text)
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
  }
  const saved: string[] = []
  const mask: MaskedCode = {
    masked: text,
    prefix: '',
    suffix: '',
    saved,
    protect(original: string): string {
      if (!mask.prefix) {
        let candidate = '\uE000tavernHm'
        while (text.includes(candidate)) candidate += 'X'
        mask.prefix = candidate
        mask.suffix = '\uE001'
      }
      const index = saved.length
      saved.push(original)
      return `${mask.prefix}${index}${mask.suffix}`
    },
    restore(value: string): string {
      if (!mask.prefix || saved.length === 0 || !value.includes(mask.prefix)) return value
      const pattern = new RegExp(`${mask.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${mask.suffix}`, 'g')
      return value.replace(pattern, (_raw, index: string) => saved[Number(index)] ?? '')
    },
  }
  if (ranges.length === 0) return mask
  let masked = ''
  let cursor = 0
  for (const range of ranges) {
    masked += text.slice(cursor, range.start) + mask.protect(text.slice(range.start, range.end))
    cursor = range.end
  }
  masked += text.slice(cursor)
  mask.masked = masked
  return mask
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

function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s/<>]+/i.test(url) && !/[\r\n\t\u0000-\u001f\u007f<>]/.test(url)
}

function encodeMarkdownUrl(url: string, inTable: boolean): string {
  return url
    .replace(/[ ()<>]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    .replace(/\|/g, inTable ? '%7C' : '|')
}

/** Pass 0：将安全 `<pre>` / `<pre><code>` 转为围栏代码块并立即受 mask 保护，避免后续 pass 改写内部文本。 */
function convertSafePreBlocks(text: string, mask: MaskedCode): string {
  if (!/<pre(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
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

  let out = ''
  let cursor = 0
  let pos = 0
  let changed = false
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) break
    const tag = parseHtmlTagAt(text, open)
    if (!tag || tag.closing || tag.selfClosing || tag.name !== 'pre') {
      pos = tag ? tag.end : open + 1
      continue
    }
    const openLineIdx = lineOf(tag.start)
    if (indented.has(openLineIdx)) { pos = tag.end; continue }
    const preAttrs = parseSafeTagAttrs(tag.rawAttrs)
    if (!preAttrs || !hasOnlyAttrs(preAttrs, BLOCK_SAFE_ATTRS)) { pos = tag.end; continue }
    const closeRe = /<\/pre\s*>/gi
    closeRe.lastIndex = tag.end
    const closeMatch = closeRe.exec(text)
    if (!closeMatch) { pos = tag.end; continue }

    let rawBody = text.slice(tag.end, closeMatch.index)
    let lang = ''
    const trimmedBody = rawBody.trim()
    const maybeCode = parseHtmlTagAt(trimmedBody, 0)
    if (maybeCode && !maybeCode.closing && !maybeCode.selfClosing && maybeCode.name === 'code') {
      const codeAttrs = parseSafeTagAttrs(maybeCode.rawAttrs)
      const closeCode = /<\/code\s*>$/i.exec(trimmedBody.slice(maybeCode.end))
      if (codeAttrs && hasOnlyAttrs(codeAttrs, SPAN_SAFE_ATTRS) && closeCode) {
        const cls = codeAttrs.get('class') ?? ''
        const langMatch = /\b(?:language|lang)-([a-z0-9_+-]+)\b/i.exec(cls)
        if (langMatch) lang = langMatch[1]!
        rawBody = trimmedBody.slice(maybeCode.end, maybeCode.end + closeCode.index)
      }
    }
    const restoredBody = mask.restore(rawBody)
    if (restoredBody.includes('<') || restoredBody.includes('>')) {
      pos = closeRe.lastIndex
      continue
    }
    const decoded = decodeBasicEntities(restoredBody.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    let maxRun = 2
    for (const m of decoded.matchAll(/`+/g)) if (m[0].length > maxRun) maxRun = m[0].length
    const fence = '`'.repeat(maxRun + 1)
    const outerPrefix = lineLayout(lines[openLineIdx]!).quotePrefix
    const bodyLines = decoded.split(/\r?\n/).map(l => {
      const clean = outerPrefix && l.startsWith(outerPrefix) ? l.slice(outerPrefix.length) : l
      return `${outerPrefix}${clean}`
    }).join('\n')
    const fenced = `${outerPrefix}${fence}${lang}\n${bodyLines}\n${outerPrefix}${fence}`
    const placeholder = mask.protect(fenced)

    const beforeOnLine = text.slice(lineStarts[openLineIdx]!, tag.start).slice(outerPrefix.length)
    const afterSlice = text.slice(closeRe.lastIndex)
    const needLead = beforeOnLine.trim() !== '' ? `\n${outerPrefix.trimEnd()}\n` : ''
    const needTrail = afterSlice && !/^[ \t]*(?:\r?\n|$)/.test(afterSlice) ? `\n${outerPrefix.trimEnd()}\n${outerPrefix}` : ''
    if (needLead) {
      out += text.slice(cursor, tag.start).replace(/[ \t]+$/, '') + needLead + placeholder + needTrail
    } else {
      const cutTo = Math.max(cursor, lineStarts[openLineIdx]!)
      out += text.slice(cursor, cutTo) + placeholder + needTrail
    }
    cursor = closeRe.lastIndex
    pos = closeRe.lastIndex
    changed = true
  }
  if (!changed) return text
  out += text.slice(cursor)
  return out
}

/** Pass 0b：将单行安全 `<code>` / `<kbd>` 转为 Markdown 行内代码并立即受 mask 保护。 */
function convertSafeInlineCode(text: string, mask: MaskedCode): string {
  if (!/<(?:code|kbd)(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const tableLines = findGfmTableLines(text)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    const line = lines[i]!
    if (!/<(?:code|kbd)(?=[\s/>])/i.test(line)) continue
    const inTable = tableLines.has(i)
    let out = ''
    let cursor = 0
    let pos = 0
    let lineChanged = false
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag || tag.closing || tag.selfClosing || (tag.name !== 'code' && tag.name !== 'kbd')) {
        pos = tag ? tag.end : open + 1
        continue
      }
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, SPAN_SAFE_ATTRS)) { pos = tag.end; continue }
      const closeRe = new RegExp(`</${tag.name}\\s*>`, 'gi')
      closeRe.lastIndex = tag.end
      const closeMatch = closeRe.exec(line)
      if (!closeMatch) { pos = tag.end; continue }
      const inner = mask.restore(line.slice(tag.end, closeMatch.index))
      if (!inner || inner.includes('<') || inner.includes('>')) {
        pos = closeRe.lastIndex
        continue
      }
      let decoded = decodeBasicEntities(inner)
      if (inTable) decoded = decoded.replace(/\|/g, '\\|')
      let maxRun = 0
      for (const m of decoded.matchAll(/`+/g)) if (m[0].length > maxRun) maxRun = m[0].length
      const fence = '`'.repeat(maxRun + 1)
      const needsPad = decoded.startsWith('`') || decoded.endsWith('`')
        || (decoded.startsWith(' ') && decoded.endsWith(' ') && /[^ ]/.test(decoded))
      const span = needsPad ? `${fence} ${decoded} ${fence}` : `${fence}${decoded}${fence}`
      out += line.slice(cursor, tag.start) + mask.protect(span)
      cursor = closeRe.lastIndex
      pos = closeRe.lastIndex
      lineChanged = true
    }
    if (lineChanged) {
      out += line.slice(cursor)
      lines[i] = out
      changed = true
    }
  }
  return changed ? joinLinesWithBreaks(lines, breaks) : text
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
      if (!isSafeHttpUrl(src)) {
        pos = tag.end
        continue
      }
      const safeUrl = encodeMarkdownUrl(src, inTable)
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

/** Pass 1b：将日系/轻小说角色卡常用的 `<ruby>基字<rt>注音</rt></ruby>` 转为 `基字(注音)`。 */
function convertSafeRuby(text: string): string {
  if (!/<ruby(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    const line = lines[i]!
    if (!/<ruby(?=[\s/>])/i.test(line)) continue
    let out = ''
    let cursor = 0
    let pos = 0
    let lineChanged = false
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag || tag.closing || tag.selfClosing || tag.name !== 'ruby') {
        pos = tag ? tag.end : open + 1
        continue
      }
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, SPAN_SAFE_ATTRS)) { pos = tag.end; continue }
      const closeRe = /<\/ruby\s*>/gi
      closeRe.lastIndex = tag.end
      const closeMatch = closeRe.exec(line)
      if (!closeMatch) { pos = tag.end; continue }
      const inner = line.slice(tag.end, closeMatch.index)
      let rubyOut = ''
      let rubyPos = 0
      let valid = true
      let sawRt = false
      while (rubyPos < inner.length) {
        const lt = inner.indexOf('<', rubyPos)
        if (lt < 0) {
          rubyOut += inner.slice(rubyPos)
          break
        }
        rubyOut += inner.slice(rubyPos, lt)
        const innerTag = parseHtmlTagAt(inner, lt)
        if (!innerTag || innerTag.closing || innerTag.selfClosing
          || (innerTag.name !== 'rt' && innerTag.name !== 'rb' && innerTag.name !== 'rp')) {
          valid = false
          break
        }
        const innerAttrs = parseSafeTagAttrs(innerTag.rawAttrs)
        if (!innerAttrs || !hasOnlyAttrs(innerAttrs, SPAN_SAFE_ATTRS)) { valid = false; break }
        const endInnerRe = new RegExp(`</${innerTag.name}\\s*>`, 'gi')
        endInnerRe.lastIndex = innerTag.end
        const endInner = endInnerRe.exec(inner)
        if (!endInner) { valid = false; break }
        const piece = inner.slice(innerTag.end, endInner.index)
        if (piece.includes('<') || piece.includes('>')) { valid = false; break }
        if (innerTag.name === 'rt') {
          const reading = piece.trim()
          if (reading) {
            rubyOut += `(${reading})`
            sawRt = true
          }
        } else if (innerTag.name === 'rb') {
          rubyOut += piece
        }
        rubyPos = endInnerRe.lastIndex
      }
      if (!valid || !sawRt || !rubyOut.trim()) { pos = closeRe.lastIndex; continue }
      out += line.slice(cursor, tag.start) + rubyOut
      cursor = closeRe.lastIndex
      pos = closeRe.lastIndex
      lineChanged = true
    }
    if (lineChanged) {
      out += line.slice(cursor)
      lines[i] = out
      changed = true
    }
  }
  return changed ? joinLinesWithBreaks(lines, breaks) : text
}

/** Pass 2：剥离纯样式 `<font>`/`<span>`/`<small>`/`<mark>`/`<u>` 外壳。 */
function unwrapSafePresentational(text: string): string {
  if (!/<\/?(?:font|span|small|mark|u)(?=[\s/>])/i.test(text)) return text
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
  const stacks = new Map<string, Array<{ start: number; end: number; safe: boolean }>>()
  const stackOf = (name: string) => {
    let list = stacks.get(name)
    if (!list) { list = []; stacks.set(name, list) }
    return list
  }
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) break
    const tag = parseHtmlTagAt(text, open)
    if (!tag) { pos = open + 1; continue }
    if (!PRESENTATIONAL_WRAPPER_NAMES.has(tag.name)) { pos = tag.end; continue }
    const lineIdx = lineOfOffset(tag.start)
    if (indented.has(lineIdx)) { pos = tag.end; continue }
    const stack = stackOf(tag.name)
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
      // 真正无对应开标签的孤立闭标签直接剥离（含不安全开标签的配对闭标签已在 stack 分支消费），
      // 既消除行内残留也避免独占行触发 CommonMark Type 7 HTML 块。
      removeRanges.push({ start: tag.start, end: tag.end })
    }
    pos = tag.end
  }
  // 跨 HTML 卡片拆分、作者漏写闭标签或流式输出留下的未闭合安全样式开标签同样剥离。
  for (const list of stacks.values()) {
    for (const opened of list) {
      if (!opened.safe) continue
      removeRanges.push({ start: opened.start, end: opened.end })
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

/** Pass 2b：将安全的 `http(s)` `<a href="...">文本</a>` 转为标准 Markdown 链接。 */
function convertSafeLinks(text: string): string {
  if (!/<a(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const tableLines = findGfmTableLines(text)
  let changed = false

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    const line = lines[i]!
    if (!/<a(?=[\s/>])/i.test(line)) continue
    const inTable = tableLines.has(i)
    let out = ''
    let cursor = 0
    let pos = 0
    let lineChanged = false
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag || tag.closing || tag.selfClosing || tag.name !== 'a') {
        pos = tag ? tag.end : open + 1
        continue
      }
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      const rawHref = attrs?.get('href')
      if (!attrs || rawHref === undefined || !hasOnlyAttrs(attrs, ANCHOR_SAFE_ATTRS)) {
        pos = tag.end
        continue
      }
      const href = decodeBasicEntities(rawHref).trim()
      if (!isSafeHttpUrl(href)) {
        pos = tag.end
        continue
      }
      const closeRe = /<\/a\s*>/gi
      closeRe.lastIndex = tag.end
      const closeMatch = closeRe.exec(line)
      if (!closeMatch) { pos = tag.end; continue }
      const inner = line.slice(tag.end, closeMatch.index).trim()
      const isSingleMdImage = /^!\[(?:\\.|[^\[\]\\])*\]\([^()\s]+\)$/.test(inner)
      if (!inner || inner.includes('<') || inner.includes('>') || (!isSingleMdImage && (inner.includes('[') || inner.includes(']')))) {
        pos = closeRe.lastIndex
        continue
      }
      const safeUrl = encodeMarkdownUrl(href, inTable)
      const safeLabel = inTable && !isSingleMdImage ? inner.replace(/\|/g, '\\|') : inner
      out += line.slice(cursor, tag.start) + `[${safeLabel}](${safeUrl})`
      cursor = closeRe.lastIndex
      pos = closeRe.lastIndex
      lineChanged = true
    }
    if (lineChanged) {
      out += line.slice(cursor)
      lines[i] = out
      changed = true
    }
  }
  return changed ? joinLinesWithBreaks(lines, breaks) : text
}

function hasFencePlaceholder(text: string, mask: MaskedCode): boolean {
  if (!mask.prefix || !text.includes(mask.prefix)) return false
  let pos = 0
  while (pos < text.length) {
    const at = text.indexOf(mask.prefix, pos)
    if (at < 0) break
    const close = text.indexOf(mask.suffix, at + mask.prefix.length)
    if (close < 0) break
    const idxStr = text.slice(at + mask.prefix.length, close)
    if (/^\d+$/.test(idxStr)) {
      const original = mask.saved[Number(idxStr)]
      if (original && (original.includes('\n') || /^(`{3,}|~{3,})/.test(original))) return true
    }
    pos = close + mask.suffix.length
  }
  return false
}

const BLOCKQUOTE_STOP_RE = /^(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|[-+*][ \t]+|\d{1,9}[.)][ \t]+|<)/

/** 处理配对消除后剩余的孤立 `</blockquote>` 与未闭合安全 `<blockquote>`，避免 Type 6 HTML 块吞掉代码围栏。 */
function normalizeUnmatchedBlockquotes(text: string, mask: MaskedCode): string {
  if (!/<\/?blockquote(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const tableLines = findGfmTableLines(text)
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

  const stack: Array<{ tag: ParsedTag; lineIdx: number; safe: boolean }> = []
  const orphanCloses = new Map<number, Array<{ start: number; end: number }>>()
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) break
    const tag = parseHtmlTagAt(text, open)
    if (!tag) { pos = open + 1; continue }
    if (tag.name !== 'blockquote') { pos = tag.end; continue }
    const lineIdx = lineOf(tag.start)
    if (indented.has(lineIdx)) { pos = tag.end; continue }
    if (!tag.closing && !tag.selfClosing) {
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      stack.push({ tag, lineIdx, safe: attrs !== null && hasOnlyAttrs(attrs, QUOTE_SAFE_ATTRS) })
    } else if (tag.closing) {
      if (stack.length > 0) {
        stack.pop()
      } else {
        const endLine = lineOf(Math.max(tag.start, tag.end - 1))
        if (endLine === lineIdx) {
          const base = lineStarts[lineIdx]!
          const list = orphanCloses.get(lineIdx) ?? []
          list.push({ start: tag.start - base, end: tag.end - base })
          orphanCloses.set(lineIdx, list)
        }
      }
    }
    pos = tag.end
  }

  const unclosedSafe = new Map<number, ParsedTag>()
  for (const entry of stack) {
    if (!entry.safe || tableLines.has(entry.lineIdx)) continue
    const endLine = lineOf(Math.max(entry.tag.start, entry.tag.end - 1))
    if (endLine === entry.lineIdx && !unclosedSafe.has(entry.lineIdx)) {
      unclosedSafe.set(entry.lineIdx, entry.tag)
    }
  }
  if (orphanCloses.size === 0 && unclosedSafe.size === 0) return text

  const nextLines: string[] = []
  const nextBreaks: string[] = []
  const pushLine = (line: string, br: string | undefined) => {
    nextLines.push(line)
    if (br !== undefined) nextBreaks.push(br)
  }

  const isPlainContinuation = (idx: number, outerPrefix: string): boolean => {
    if (idx >= lines.length || indented.has(idx) || tableLines.has(idx)) return false
    if (unclosedSafe.has(idx) || orphanCloses.has(idx)) return false
    const l = lines[idx]!
    const lay = lineLayout(l)
    if (lay.quotePrefix !== outerPrefix) return false
    const body = l.slice(lay.contentStart)
    if (!body.trim()) return false
    if (hasFencePlaceholder(body, mask) || isPlaceholderLine(body.trim(), mask)) return false
    if (BLOCKQUOTE_STOP_RE.test(body)) return false
    return true
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const br = i < breaks.length ? breaks[i] : undefined
    const closeCuts = orphanCloses.get(i)
    const openTag = unclosedSafe.get(i)

    if (openTag) {
      const base = lineStarts[i]!
      const localStart = openTag.start - base
      const localEnd = openTag.end - base
      const layout = lineLayout(line)
      const outerPrefix = layout.quotePrefix
      const before = line.slice(outerPrefix.length, localStart)
      let after = line.slice(localEnd)
      // 同一行开标签之后若还残留孤立闭标签一并裁掉。
      if (closeCuts) {
        const afterCuts = closeCuts.filter(cut => cut.start >= localEnd)
        if (afterCuts.length > 0) {
          let rebuilt = ''
          let cursor = localEnd
          for (const cut of afterCuts) {
            if (cut.start > cursor) rebuilt += line.slice(cursor, cut.start)
            cursor = Math.max(cursor, cut.end)
          }
          rebuilt += line.slice(cursor)
          after = rebuilt
        }
      }
      let emittedQuote = false
      if (before.trim() !== '') {
        pushLine(line.slice(0, localStart).replace(/[ \t]+$/, ''), '\n')
        if (after.trim() !== '' || isPlainContinuation(i + 1, outerPrefix)) {
          pushLine(outerPrefix.trimEnd(), '\n')
        }
      }
      let lastIdx = i
      if (after.trim() !== '') {
        pushLine(`${outerPrefix}> ${after.trimStart()}`, br)
        emittedQuote = true
      }
      // 顺带引用紧随的连续普通续行，遇空行、代码围栏或块标记即止。
      let j = i + 1
      while (isPlainContinuation(j, outerPrefix)) {
        const jLine = lines[j]!
        const jBr = j < breaks.length ? breaks[j] : undefined
        const clean = jLine.slice(outerPrefix.length).trimStart()
        pushLine(`${outerPrefix}> ${clean}`, jBr)
        emittedQuote = true
        lastIdx = j
        j++
      }
      if (emittedQuote && j < lines.length) {
        const stopLine = lines[j]!
        const stopLayout = lineLayout(stopLine)
        if (stopLine.slice(stopLayout.quotePrefix.length).trim() !== '') {
          // 如果最后一条引用行原本没有尾换行（不可能在 j < lines.length 时发生，但防御性确保），补齐空行防懒延续。
          if (nextBreaks.length < nextLines.length) nextBreaks.push('\n')
          pushLine(outerPrefix.trimEnd(), '\n')
        }
      }
      i = lastIdx
      continue
    }

    if (closeCuts) {
      const layout = lineLayout(line)
      let stripped = ''
      let cursor = 0
      for (const cut of closeCuts) {
        if (cut.start > cursor) stripped += line.slice(cursor, cut.start)
        cursor = Math.max(cursor, cut.end)
      }
      stripped += line.slice(cursor)
      if (stripped.slice(layout.quotePrefix.length).trim() === '') continue
      line = stripped
    }

    pushLine(line, br)
  }

  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
}

/** 栈式剥离无属性 `<center>`/`</center>`（含行内混排、未闭合与孤立闭标签），保留带属性 `<center style=...>`。 */
function unwrapSafeCenters(text: string): string {
  if (!/<\/?center(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
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

  const removeRanges: Array<{ start: number; end: number }> = []
  const stack: Array<{ start: number; end: number; safe: boolean }> = []
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('<', pos)
    if (open < 0) break
    const tag = parseHtmlTagAt(text, open)
    if (!tag) { pos = open + 1; continue }
    if (tag.name !== 'center') { pos = tag.end; continue }
    if (indented.has(lineOf(tag.start))) { pos = tag.end; continue }
    if (!tag.closing) {
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      const safe = attrs !== null && attrs.size === 0
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
      removeRanges.push({ start: tag.start, end: tag.end })
    }
    pos = tag.end
  }
  for (const opened of stack) {
    if (opened.safe) removeRanges.push({ start: opened.start, end: opened.end })
  }
  if (removeRanges.length === 0) return text
  removeRanges.sort((a, b) => a.start - b.start)

  const perLine = new Map<number, Array<{ start: number; end: number }>>()
  for (const range of removeRanges) {
    const startLine = lineOf(range.start)
    const endLine = lineOf(Math.max(range.start, range.end - 1))
    if (startLine !== endLine) {
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
    const trimmedEnd = line.trimEnd().length
    const cutAtStart = cuts[0]!.start === layout.contentStart
    const cutAtEnd = cuts[cuts.length - 1]!.end >= trimmedEnd
    let stripped = ''
    let cursor = 0
    for (const cut of cuts) {
      if (cut.start > cursor) stripped += line.slice(cursor, cut.start)
      cursor = Math.max(cursor, cut.end)
    }
    stripped += line.slice(cursor)
    if (stripped.slice(layout.quotePrefix.length).trim() === '') continue
    if (cutAtStart) {
      const prefix = line.slice(0, layout.contentStart)
      stripped = prefix + stripped.slice(prefix.length).replace(/^[ \t]+/, '')
    }
    if (cutAtEnd) stripped = stripped.replace(/[ \t]+$/, '')
    nextLines.push(stripped)
    if (i < breaks.length) nextBreaks.push(breaks[i]!)
  }
  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
}

const HEADING_FORBIDDEN_INNER_RE = /<\/?(?:div|table|section|article|details|script|style|iframe|h[1-6]|blockquote|p|hr)\b/i

/** 转换安全的 `<h1>`-`<h6>` 标题：支持同行尾随正文/标签、多行标题以及未闭合单行标题。 */
function convertSafeHeadings(text: string, mask: MaskedCode): string {
  if (!/<h[1-6](?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const nextLines: string[] = []
  const nextBreaks: string[] = []
  let changed = false

  const emitHeadingChain = (quotePrefix: string, rawContent: string, br: string | undefined): boolean => {
    let working = rawContent
    let emittedAny = false
    for (let iter = 0; iter < 32 && working; iter++) {
      const openTag = parseHtmlTagAt(working, 0)
      if (!openTag || openTag.closing || openTag.selfClosing || !/^h[1-6]$/.test(openTag.name)) break
      const attrs = parseSafeTagAttrs(openTag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) break
      const level = Number(openTag.name[1])
      const closeRe = new RegExp(`</${openTag.name}\\s*>`, 'i')
      const afterOpen = working.slice(openTag.end)
      const closeMatch = closeRe.exec(afterOpen)
      if (!closeMatch) {
        if (!emittedAny) break
        const trailing = afterOpen.trim()
        if (!trailing || HEADING_FORBIDDEN_INNER_RE.test(trailing) || hasFencePlaceholder(trailing, mask)) break
        nextLines.push(`${quotePrefix}${'#'.repeat(level)} ${trailing}`)
        if (br !== undefined) nextBreaks.push(br)
        working = ''
        break
      }
      const inner = afterOpen.slice(0, closeMatch.index).trim()
      if (!inner || HEADING_FORBIDDEN_INNER_RE.test(inner) || hasFencePlaceholder(inner, mask)) break
      const afterClose = afterOpen.slice(closeMatch.index + closeMatch[0].length).trimStart()
      nextLines.push(`${quotePrefix}${'#'.repeat(level)} ${inner}`)
      emittedAny = true
      if (afterClose) {
        nextBreaks.push('\n')
        working = afterClose
      } else {
        if (br !== undefined) nextBreaks.push(br)
        working = ''
      }
    }
    if (!emittedAny) return false
    if (working) {
      nextLines.push(`${quotePrefix}${working}`)
      if (br !== undefined) nextBreaks.push(br)
    }
    return true
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const br = i < breaks.length ? breaks[i] : undefined
    if (indented.has(i) || !/<h[1-6](?=[\s/>])/i.test(line)) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const layout = lineLayout(line)
    const trimmed = line.slice(layout.contentStart).trimEnd()
    if (emitHeadingChain(layout.quotePrefix, trimmed, br)) {
      changed = true
      continue
    }

    const openTag = parseHtmlTagAt(trimmed, 0)
    if (!openTag || openTag.closing || openTag.selfClosing || !/^h[1-6]$/.test(openTag.name)) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const attrs = parseSafeTagAttrs(openTag.rawAttrs)
    if (!attrs || !hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const level = Number(openTag.name[1])
    const closeRe = new RegExp(`</${openTag.name}\\s*>`, 'i')
    const afterOpen = trimmed.slice(openTag.end)

    // 同行已出现闭合标签却未通过 emitHeadingChain（例如含禁止内层或为空）：保守原样保留。
    if (closeRe.test(afterOpen)) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }

    // 多行标题：如 <h2 align="center">\n  序章：星港\n</h2>
    const firstPart = afterOpen.trim()
    if (!HEADING_FORBIDDEN_INNER_RE.test(firstPart) && !hasFencePlaceholder(firstPart, mask)) {
      const parts: string[] = firstPart ? [firstPart] : []
      let matchedEnd = -1
      let trailingAfterClose = ''
      const maxScan = Math.min(lines.length - 1, i + 6)
      for (let j = i + 1; j <= maxScan; j++) {
        if (indented.has(j)) break
        const jLine = lines[j]!
        const jLayout = lineLayout(jLine)
        if (jLayout.quotePrefix !== layout.quotePrefix) break
        const jTrimmed = jLine.slice(jLayout.contentStart).trimEnd()
        if (!jTrimmed || hasFencePlaceholder(jTrimmed, mask)) break
        const jClose = closeRe.exec(jTrimmed)
        if (jClose) {
          const beforeClose = jTrimmed.slice(0, jClose.index).trim()
          if (beforeClose) parts.push(beforeClose)
          const combined = parts.join(' ').trim()
          if (combined && !HEADING_FORBIDDEN_INNER_RE.test(combined)) {
            matchedEnd = j
            trailingAfterClose = jTrimmed.slice(jClose.index + jClose[0].length).trimStart()
          }
          break
        }
        if (HEADING_FORBIDDEN_INNER_RE.test(jTrimmed)) break
        parts.push(jTrimmed)
      }
      if (matchedEnd >= 0) {
        nextLines.push(`${layout.quotePrefix}${'#'.repeat(level)} ${parts.join(' ').trim()}`)
        const endBr = matchedEnd < breaks.length ? breaks[matchedEnd] : undefined
        if (trailingAfterClose) {
          nextBreaks.push('\n')
          if (!emitHeadingChain(layout.quotePrefix, trailingAfterClose, endBr)) {
            nextLines.push(`${layout.quotePrefix}${trailingAfterClose}`)
            if (endBr !== undefined) nextBreaks.push(endBr)
          }
        } else if (endBr !== undefined) {
          nextBreaks.push(endBr)
        }
        i = matchedEnd
        changed = true
        continue
      }

      // 未闭合的单行安全标题（如 <h3>角色档案\n```json...）：转为 ATX 标题避免 Type 6 块吞掉后文围栏。
      if (firstPart) {
        nextLines.push(`${layout.quotePrefix}${'#'.repeat(level)} ${firstPart}`)
        if (br !== undefined) nextBreaks.push(br)
        changed = true
        continue
      }

      // 独占行的空安全开标题（如 <h3>\n```json...）若后文不存在匹配闭标签，丢弃以免开启 Type 6 块吞掉围栏。
      let depth = 1
      let foundLaterClose = false
      for (let k = i + 1; k < lines.length; k++) {
        if (indented.has(k)) continue
        const kLine = lines[k]!
        if (!kLine.includes('<')) continue
        let kPos = 0
        while (kPos < kLine.length) {
          const lt = kLine.indexOf('<', kPos)
          if (lt < 0) break
          const t = parseHtmlTagAt(kLine, lt)
          if (!t) { kPos = lt + 1; continue }
          if (t.name === openTag.name && !t.selfClosing) {
            if (t.closing) {
              depth--
              if (depth === 0) { foundLaterClose = true; break }
            } else {
              depth++
            }
          }
          kPos = t.end
        }
        if (foundLaterClose) break
      }
      if (!foundLaterClose) {
        changed = true
        continue
      }
    }
    nextLines.push(line)
    if (br !== undefined) nextBreaks.push(br)
  }
  if (!changed) return text
  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
}

const LIST_ITEM_FORBIDDEN_INNER_RE = /<\/?(?:div|table|section|article|details|script|style|iframe|ul|ol|li|blockquote|h[1-6]|hr)\b/i

/** 转换不在 `<ul>`/`<ol>` 容器内的孤立安全 `<li>` 条目为 Markdown 列表项，避免裸露标签或 Type 6 块吞掉后文围栏。 */
function convertSafeBareListItems(text: string, mask: MaskedCode): string {
  if (!/<li(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const nextLines: string[] = []
  const nextBreaks: string[] = []
  let listContainerDepth = 0
  let changed = false

  const updateListDepth = (line: string, from: number) => {
    let pos = from
    while (pos < line.length) {
      const lt = line.indexOf('<', pos)
      if (lt < 0) break
      const tag = parseHtmlTagAt(line, lt)
      if (!tag) { pos = lt + 1; continue }
      if ((tag.name === 'ul' || tag.name === 'ol') && !tag.selfClosing) {
        if (!tag.closing) listContainerDepth++
        else if (listContainerDepth > 0) listContainerDepth--
      }
      pos = tag.end
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const br = i < breaks.length ? breaks[i] : undefined
    if (indented.has(i)) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const layout = lineLayout(line)
    if (listContainerDepth > 0 || !/<li(?=[\s/>])/i.test(line)) {
      if (line.includes('<')) updateListDepth(line, layout.contentStart)
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const trimmed = line.slice(layout.contentStart).trimEnd()
    let working = trimmed
    let emittedAny = false
    for (let iter = 0; iter < 32 && working; iter++) {
      const openTag = parseHtmlTagAt(working, 0)
      if (!openTag || openTag.closing || openTag.selfClosing || openTag.name !== 'li') break
      const attrs = parseSafeTagAttrs(openTag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) break
      const afterOpen = working.slice(openTag.end)
      const closeMatch = /<\/li\s*>/i.exec(afterOpen)
      if (closeMatch) {
        const inner = afterOpen.slice(0, closeMatch.index).trim()
        if (!inner || LIST_ITEM_FORBIDDEN_INNER_RE.test(inner) || hasFencePlaceholder(inner, mask)) break
        const afterClose = afterOpen.slice(closeMatch.index + closeMatch[0].length).trimStart()
        nextLines.push(`${layout.quotePrefix}- ${inner}`)
        emittedAny = true
        if (afterClose) {
          nextBreaks.push('\n')
          working = afterClose
        } else {
          if (br !== undefined) nextBreaks.push(br)
          working = ''
        }
        continue
      }
      const single = afterOpen.trim()
      if (!single || LIST_ITEM_FORBIDDEN_INNER_RE.test(single) || hasFencePlaceholder(single, mask)) break
      nextLines.push(`${layout.quotePrefix}- ${single}`)
      if (br !== undefined) nextBreaks.push(br)
      emittedAny = true
      working = ''
    }
    if (emittedAny) {
      if (working) {
        updateListDepth(working, 0)
        nextLines.push(`${layout.quotePrefix}${working}`)
        if (br !== undefined) nextBreaks.push(br)
      }
      changed = true
      continue
    }
    updateListDepth(line, layout.contentStart)
    nextLines.push(line)
    if (br !== undefined) nextBreaks.push(br)
  }

  if (!changed) return text
  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
}

/** Pass 3：处理块级包装标签（`<blockquote>`、`<center>`、`<h1>`-`<h6>`、`<p>`、`<hr>`）。 */
function normalizeBlockHtml(text: string, mask: MaskedCode): string {
  if (!/<\/?(?:center|p|h[1-6]|blockquote|hr|li)(?=[\s/>])/i.test(text)) return text
  let current = text

  // 3a: 配对 <blockquote>...</blockquote>（由内向外，最多 4 层），随后兜底处理孤立/未闭合安全引用。
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
  current = normalizeUnmatchedBlockquotes(current, mask)

  // 3b: 无属性 <center> 外壳（先于 h1-h6 剥离，使 <center><h2>标题</h2></center> 能继续转为 ## 标题）
  current = unwrapSafeCenters(current)

  // 3c: 安全 <h1>..<h6> 标题（支持同行尾随、多行与未闭合单行标题）
  current = convertSafeHeadings(current, mask)

  // 3d: <p>（成对同行与独占行）及 <hr>
  let changed3d = false
  if (/<\/?(?:p|hr)(?=[\s/>])/i.test(current)) {
    const { lines, breaks } = splitLinesWithBreaks(current)
    const indented = findIndentedCodeLines(lines)
    const nextLines: string[] = []
    const nextBreaks: string[] = []
    const pStack: boolean[] = []

    const pushLine = (line: string, br: string | undefined) => {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const br = i < breaks.length ? breaks[i] : undefined
      if (indented.has(i) || !/<\/?(?:p|hr)(?=[\s/>])/i.test(line)) {
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
            changed3d = true
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
        if (singleTag.name === 'p') {
          if (!singleTag.closing) {
            const attrs = parseSafeTagAttrs(singleTag.rawAttrs)
            const safe = attrs !== null && hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)
            if (!singleTag.selfClosing) pStack.push(safe)
            if (safe) {
              changed3d = true
              const prevLine = nextLines[nextLines.length - 1]
              if (prevLine !== undefined && prevLine.slice(lineLayout(prevLine).quotePrefix.length).trim() !== '') {
                pushLine(layout.quotePrefix.trimEnd(), '\n')
              }
              continue
            }
          } else {
            const matchedSafe = pStack.length > 0 ? pStack.pop()! : true
            if (matchedSafe) {
              changed3d = true
              const nextOrig = lines[i + 1]
              if (nextOrig !== undefined && nextOrig.slice(lineLayout(nextOrig).quotePrefix.length).trim() !== '') {
                pushLine(layout.quotePrefix.trimEnd(), '\n')
              }
              continue
            }
          }
        }
      }

      // 行内出现 <p>...</p> 或行内 <hr>
      let working = content
      let lineChanged = false
      let startsWithBlockBreak = false
      let endsWithBlockBreak = false
      if (/<\/?(?:p|hr)(?=[\s/>])/i.test(working)) {
        let out = ''
        let cursor = 0
        let pos = 0
        while (pos < working.length) {
          const open = working.indexOf('<', pos)
          if (open < 0) break
          const tag = parseHtmlTagAt(working, open)
          if (!tag) { pos = open + 1; continue }
          if (tag.name === 'hr' && !tag.closing) {
            const attrs = parseSafeTagAttrs(tag.rawAttrs)
            if (attrs && hasOnlyAttrs(attrs, HR_SAFE_ATTRS)) {
              const before = working.slice(cursor, tag.start)
              if (out.length === 0 && before.trim() === '') startsWithBlockBreak = true
              out += before.trimEnd()
              if (out.trim()) out += `\n${layout.quotePrefix.trimEnd()}\n`
              out += `${layout.quotePrefix}---`
              const rest = working.slice(tag.end).trimStart()
              if (rest) {
                out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
              } else {
                endsWithBlockBreak = true
              }
              cursor = tag.end + (working.slice(tag.end).length - rest.length)
              pos = cursor
              lineChanged = true
              continue
            }
          }
          if (tag.name === 'p') {
            if (!tag.closing && tag.selfClosing) {
              const attrs = parseSafeTagAttrs(tag.rawAttrs)
              if (attrs && hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) {
                const before = working.slice(cursor, tag.start)
                if (out.length === 0 && before.trim() === '') {
                  startsWithBlockBreak = true
                } else {
                  out += before.trimEnd()
                }
                const rest = working.slice(tag.end).trimStart()
                if (rest) {
                  if (out.trim()) out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
                } else {
                  endsWithBlockBreak = true
                }
                cursor = tag.end + (working.slice(tag.end).length - rest.length)
                pos = cursor
                lineChanged = true
                continue
              }
            } else if (!tag.closing && !tag.selfClosing) {
              const attrs = parseSafeTagAttrs(tag.rawAttrs)
              const safe = attrs !== null && hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)
              pStack.push(safe)
              if (safe) {
                const before = working.slice(cursor, tag.start)
                if (out.length === 0 && before.trim() === '') {
                  startsWithBlockBreak = true
                  out += before
                } else if (out.length + before.trim().length > 0 && !out.endsWith('\n\n') && before.trim()) {
                  out += before.trimEnd() + `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
                } else {
                  out += before
                }
                cursor = tag.end
                pos = tag.end
                lineChanged = true
                continue
              }
            } else if (tag.closing) {
              const matchedSafe = pStack.length > 0 ? pStack.pop()! : true
              if (matchedSafe) {
                out += working.slice(cursor, tag.start).trimEnd()
                const rest = working.slice(tag.end).trimStart()
                if (rest) {
                  out += `\n${layout.quotePrefix.trimEnd()}\n${layout.quotePrefix}`
                } else {
                  endsWithBlockBreak = true
                }
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
        changed3d = true
        if (startsWithBlockBreak) {
          const prevLine = nextLines[nextLines.length - 1]
          if (prevLine !== undefined) {
            const prevLayout = lineLayout(prevLine)
            if (prevLine.slice(prevLayout.quotePrefix.length).trim() !== '') {
              pushLine(prevLayout.quotePrefix === layout.quotePrefix ? layout.quotePrefix.trimEnd() : '', '\n')
            }
          }
        }
        const prefix = line.slice(0, layout.contentStart)
        const emitted = working.startsWith(layout.quotePrefix) ? working : prefix + working
        pushLine(emitted, br)
        // 行尾闭合 </p> 或行尾 <hr> 后紧跟另一段落时确保空行分隔。
        if (endsWithBlockBreak) {
          const nextOrig = lines[i + 1]
          if (nextOrig !== undefined) {
            const nextLayout = lineLayout(nextOrig)
            if (nextOrig.slice(nextLayout.quotePrefix.length).trim() !== '') {
              pushLine(nextLayout.quotePrefix === layout.quotePrefix ? layout.quotePrefix.trimEnd() : '', '\n')
            }
          }
        }
      } else {
        pushLine(line, br)
      }
    }
    if (changed3d) {
      while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
      current = joinLinesWithBreaks(nextLines, nextBreaks)
      // 若剥离 `<p>` 外壳后露出 `<p><h3>标题</h3></p>` 这类标题，再跑一次标题转换。
      if (/<h[1-6](?=[\s/>])/i.test(current)) {
        current = convertSafeHeadings(current, mask)
      }
    }
  }

  // 3e: 脱离 `<ul>`/`<ol>` 的孤立安全 `<li>` 条目
  current = convertSafeBareListItems(current, mask)

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

/** Pass 4：把满足 CommonMark 贴合条件的纯样式行内格式化标签转为 Markdown 强调/删除线。 */
function convertSafeInlineFormatting(text: string, mask: MaskedCode): string {
  if (!/<(?:b|strong|i|em|s|del|strike)(?=[\s/>])/i.test(text)) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  let changed = false

  const validateNestedStarCore = (
    core: string,
    outerMarker: '**' | '*',
    beforeChar: string,
    afterChar: string,
  ): { firstChar: string; lastChar: string; leftTriple: boolean; rightTriple: boolean } | null => {
    const innerRe = outerMarker === '**' ? /\*[^*]+\*/g : /\*\*[^*]+\*\*/g
    const innerWidth = outerMarker === '**' ? 1 : 2
    const innerMarker: '**' | '*' = outerMarker === '**' ? '*' : '**'
    if (outerMarker === '**' && core.includes('**')) return null
    const matches: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (let m = innerRe.exec(core); m; m = innerRe.exec(core)) {
      if (core.slice(cursor, m.index).includes('*')) return null
      matches.push({ start: m.index, end: innerRe.lastIndex })
      cursor = innerRe.lastIndex
    }
    if (core.slice(cursor).includes('*') || matches.length === 0) return null

    for (const m of matches) {
      const innerText = core.slice(m.start + innerWidth, m.end - innerWidth)
      if (!innerText) return null
      const inBefore = m.start === 0 ? beforeChar : boundaryChar(core, m.start - 1, 'end', mask)
      const inAfter = m.end === core.length ? afterChar : boundaryChar(core, m.end, 'start', mask)
      const inFirst = boundaryChar(innerText, 0, 'start', mask)
      const inLast = boundaryChar(innerText, innerText.length - 1, 'end', mask)
      if (!canFlank(inBefore, inFirst, inLast, inAfter, innerMarker, false)) return null
    }

    const leftTriple = matches[0]!.start === 0
    const rightTriple = matches[matches.length - 1]!.end === core.length
    const firstSlice = leftTriple ? core.slice(innerWidth, matches[0]!.end - innerWidth) : core
    const lastSlice = rightTriple ? core.slice(matches[matches.length - 1]!.start + innerWidth, core.length - innerWidth) : core
    return {
      firstChar: boundaryChar(firstSlice, 0, 'start', mask),
      lastChar: boundaryChar(lastSlice, lastSlice.length - 1, 'end', mask),
      leftTriple,
      rightTriple,
    }
  }

  const formatInlineSegment = (
    seg: string,
    prevChar: string,
    nextChar: string,
    spec: { marker: '**' | '*' | '~~'; cjkFriendly: boolean },
  ): string | null => {
    const leadSpaces = /^[ \t]*/.exec(seg)![0]!
    const trailSpaces = /[ \t]*$/.exec(seg)![0]!
    const core = seg.slice(leadSpaces.length, seg.length - trailSpaces.length)
    if (!core) return null
    const beforeChar = leadSpaces.length > 0 ? ' ' : prevChar
    const afterChar = trailSpaces.length > 0 ? ' ' : nextChar
    if (spec.marker === '~~') {
      if (core.includes('~')) return null
      const firstChar = boundaryChar(core, 0, 'start', mask)
      const lastChar = boundaryChar(core, core.length - 1, 'end', mask)
      if (!canFlank(beforeChar, firstChar, lastChar, afterChar, spec.marker, spec.cjkFriendly)) return null
      return leadSpaces + spec.marker + core + spec.marker + trailSpaces
    }
    if (!core.includes('*')) {
      const firstChar = boundaryChar(core, 0, 'start', mask)
      const lastChar = boundaryChar(core, core.length - 1, 'end', mask)
      if (!canFlank(beforeChar, firstChar, lastChar, afterChar, spec.marker, spec.cjkFriendly)) return null
      return leadSpaces + spec.marker + core + spec.marker + trailSpaces
    }
    const nested = validateNestedStarCore(core, spec.marker, beforeChar, afterChar)
    if (!nested) return null
    const markerChar = spec.marker[0]!
    if (!nested.firstChar || !nested.lastChar || isUnicodeWhitespace(nested.firstChar) || isUnicodeWhitespace(nested.lastChar)) return null
    if (beforeChar === markerChar || afterChar === markerChar) return null
    const leftCjk = nested.leftTriple ? false : spec.cjkFriendly
    const rightCjk = nested.rightTriple ? false : spec.cjkFriendly
    const leftOk = !isUnicodePunctuation(nested.firstChar)
      || isUnicodeWhitespace(beforeChar)
      || isUnicodePunctuation(beforeChar)
      || (leftCjk && isCjkChar(beforeChar))
    const rightOk = !isUnicodePunctuation(nested.lastChar)
      || isUnicodeWhitespace(afterChar)
      || isUnicodePunctuation(afterChar)
      || (rightCjk && isCjkChar(afterChar))
    if (!leftOk || !rightOk) return null
    return leadSpaces + spec.marker + core + spec.marker + trailSpaces
  }

  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i)) continue
    let line = lines[i]!
    if (!/<(?:b|strong|i|em|s|del|strike)(?=[\s/>])/i.test(line)) continue
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
        if (!tag || tag.closing || tag.selfClosing) {
          pos = tag ? tag.end : open + 1
          continue
        }
        const spec = INLINE_FORMAT_MAP[tag.name]
        if (!spec) { pos = tag.end; continue }
        const attrs = parseSafeTagAttrs(tag.rawAttrs)
        if (!attrs || !hasOnlyAttrs(attrs, SPAN_SAFE_ATTRS)) { pos = tag.end; continue }
        const closeRe = new RegExp(`</${tag.name}\\s*>`, 'gi')
        closeRe.lastIndex = tag.end
        const closeMatch = closeRe.exec(line)
        if (!closeMatch) { pos = tag.end; continue }
        const inner = line.slice(tag.end, closeMatch.index)
        const outerBefore = boundaryChar(line, tag.start - 1, 'end', mask)
        const outerAfter = boundaryChar(line, closeRe.lastIndex, 'start', mask)

        // 含嵌套标签时仅允许内部存在安全 <br>（按 <br> 拆段分别包裹），其它嵌套留给更内层或跳过。
        if (inner.includes('<') || inner.includes('>')) {
          const segments: Array<{ kind: 'text'; text: string } | { kind: 'br'; raw: string }> = []
          let segPos = 0
          let brCount = 0
          let valid = true
          while (segPos < inner.length) {
            const lt = inner.indexOf('<', segPos)
            if (lt < 0) {
              const tail = inner.slice(segPos)
              if (tail.includes('>')) { valid = false; break }
              if (tail) segments.push({ kind: 'text', text: tail })
              break
            }
            const chunk = inner.slice(segPos, lt)
            if (chunk.includes('>')) { valid = false; break }
            if (chunk) segments.push({ kind: 'text', text: chunk })
            const innerTag = parseHtmlTagAt(inner, lt)
            if (!innerTag || innerTag.closing || innerTag.name !== 'br') { valid = false; break }
            const brAttrs = parseSafeTagAttrs(innerTag.rawAttrs)
            if (!brAttrs || !hasOnlyAttrs(brAttrs, BR_SAFE_ATTRS)) { valid = false; break }
            segments.push({ kind: 'br', raw: inner.slice(innerTag.start, innerTag.end) })
            brCount++
            segPos = innerTag.end
          }
          if (!valid || brCount === 0) { pos = tag.end; continue }
          let rebuilt = ''
          let nonEmptyCount = 0
          for (let s = 0; s < segments.length; s++) {
            const seg = segments[s]!
            if (seg.kind === 'br') {
              rebuilt += seg.raw
              continue
            }
            if (!seg.text.trim()) {
              rebuilt += seg.text
              continue
            }
            const segBefore = s === 0 ? outerBefore : ' '
            const segAfter = s === segments.length - 1 ? outerAfter : ' '
            const formatted = formatInlineSegment(seg.text, segBefore, segAfter, spec)
            if (formatted === null) { valid = false; break }
            rebuilt += formatted
            nonEmptyCount++
          }
          if (!valid || nonEmptyCount === 0) { pos = closeRe.lastIndex; continue }
          out += line.slice(cursor, tag.start) + rebuilt
          cursor = closeRe.lastIndex
          pos = closeRe.lastIndex
          passChanged = true
          continue
        }

        const formatted = formatInlineSegment(inner, outerBefore, outerAfter, spec)
        if (formatted === null) {
          pos = closeRe.lastIndex
          continue
        }
        out += line.slice(cursor, tag.start) + formatted
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

  // 4b: 多行纯样式 <b>/<i>/<s>（如跨行旁白/对白），逐行按 CommonMark 贴合条件包裹。
  const afterSingle = changed ? joinLinesWithBreaks(lines, breaks) : text
  if (!/<(?:b|strong|i|em|s|del|strike)(?=[\s/>])/i.test(afterSingle)) return afterSingle
  const tableLines = findGfmTableLines(afterSingle)
  const blockMarkerRe = /^(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|[-+*][ \t]+|\d{1,9}[.)][ \t]+|>)/

  let multiChanged = false
  for (let i = 0; i < lines.length; i++) {
    if (indented.has(i) || tableLines.has(i)) continue
    const line = lines[i]!
    if (!/<(?:b|strong|i|em|s|del|strike)(?=[\s/>])/i.test(line)) continue
    const startLayout = lineLayout(line)
    let pos = startLayout.contentStart
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag || tag.closing || tag.selfClosing) {
        pos = tag ? tag.end : open + 1
        continue
      }
      const spec = INLINE_FORMAT_MAP[tag.name]
      if (!spec) { pos = tag.end; continue }
      const attrs = parseSafeTagAttrs(tag.rawAttrs)
      if (!attrs || !hasOnlyAttrs(attrs, SPAN_SAFE_ATTRS)) { pos = tag.end; continue }
      const firstTail = line.slice(tag.end)
      if (firstTail.includes('<') || firstTail.includes('>') || hasFencePlaceholder(firstTail, mask)) {
        pos = tag.end
        continue
      }
      const closeRe = new RegExp(`</${tag.name}\\s*>`, 'i')
      let closeLine = -1
      let closeMatch: RegExpExecArray | null = null
      let valid = true
      const maxScan = Math.min(lines.length - 1, i + 8)
      for (let j = i + 1; j <= maxScan; j++) {
        if (indented.has(j) || tableLines.has(j)) { valid = false; break }
        const jLine = lines[j]!
        const jLayout = lineLayout(jLine)
        if (jLayout.quotePrefix !== startLayout.quotePrefix) { valid = false; break }
        const jContent = jLine.slice(jLayout.quotePrefix.length)
        if (hasFencePlaceholder(jContent, mask)) { valid = false; break }
        const found = closeRe.exec(jLine)
        if (found) {
          const beforeClose = jLine.slice(jLayout.quotePrefix.length, found.index)
          if (beforeClose.includes('<') || beforeClose.includes('>') || blockMarkerRe.test(beforeClose.trimStart())) {
            valid = false
          } else {
            closeLine = j
            closeMatch = found
          }
          break
        }
        if (jContent.includes('<') || jContent.includes('>') || blockMarkerRe.test(jContent.trimStart())) {
          valid = false
          break
        }
      }
      if (!valid || closeLine < 0 || !closeMatch) { pos = tag.end; continue }

      // 逐行尝试包裹；全部非空行都满足贴合规则才整体替换。
      const replacements = new Map<number, string>()
      let nonEmptyCount = 0
      const outerBefore = boundaryChar(line, tag.start - 1, 'end', mask)
      const closeEnd = closeMatch.index + closeMatch[0].length
      const outerAfter = boundaryChar(lines[closeLine]!, closeEnd, 'start', mask)

      if (firstTail.trim()) {
        const formatted = formatInlineSegment(firstTail, outerBefore, ' ', spec)
        if (formatted === null) { pos = tag.end; continue }
        replacements.set(i, line.slice(0, tag.start) + formatted)
        nonEmptyCount++
      } else {
        replacements.set(i, line.slice(0, tag.start) + firstTail)
      }
      for (let j = i + 1; j < closeLine; j++) {
        const jLine = lines[j]!
        const jBody = jLine.slice(startLayout.quotePrefix.length)
        if (!jBody.trim()) continue
        const formatted = formatInlineSegment(jBody, ' ', ' ', spec)
        if (formatted === null) { valid = false; break }
        replacements.set(j, startLayout.quotePrefix + formatted)
        nonEmptyCount++
      }
      if (valid) {
        const endLine = lines[closeLine]!
        const endBody = endLine.slice(startLayout.quotePrefix.length, closeMatch.index)
        const endTail = endLine.slice(closeEnd)
        if (endBody.trim()) {
          const formatted = formatInlineSegment(endBody, ' ', outerAfter, spec)
          if (formatted === null) valid = false
          else {
            replacements.set(closeLine, startLayout.quotePrefix + formatted + endTail)
            nonEmptyCount++
          }
        } else {
          replacements.set(closeLine, startLayout.quotePrefix + endBody + endTail)
        }
      }
      if (!valid || nonEmptyCount === 0) { pos = tag.end; continue }
      for (const [idx, nextLine] of replacements) lines[idx] = nextLine
      multiChanged = true
      i = lines[closeLine]!.slice(closeEnd).includes('<') ? closeLine - 1 : closeLine
      break
    }
  }

  return changed || multiChanged ? joinLinesWithBreaks(lines, breaks) : text
}

const ORPHAN_CLOSE_TAG_NAMES = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'figcaption', 'details', 'summary',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'form', 'fieldset', 'legend',
  'blockquote', 'center', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'strong', 'i', 'em', 's', 'del', 'strike',
])

const SAFE_EMPTY_SELF_CLOSING_BLOCKS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'figcaption', 'details', 'summary', 'p', 'blockquote', 'center',
])

const ORPHAN_STANDALONE_INLINE_OPENS = new Set(['b', 'strong', 'i', 'em', 's', 'del', 'strike'])

/**
 * Pass 4c：清理会触发 CommonMark Type 6/7 HTML 块并吞掉紧随代码围栏的独占行残余标签：
 * - 无对应开标签的闭合块/格式标签（如 `</div>`/`</details>`/`</summary>`/`</b>`）；
 * - 纯样式空自闭合结构容器（如 `<div/>`/`<section class="gap"/>`）；
 * - 后文无任何匹配闭标签的纯样式独占行格式化开标签（如 `<b>\n```json...`）。
 * 成对出现的不安全/未转换标签与缩进代码块一律原样保留。
 */
function stripOrphanBlockCloseLines(text: string): string {
  if (!text.includes('<')) return text
  const { lines, breaks } = splitLinesWithBreaks(text)
  const indented = findIndentedCodeLines(lines)
  const openCounts = new Map<string, number>()
  const nextLines: string[] = []
  const nextBreaks: string[] = []
  let changed = false

  const hasMatchingCloseLater = (fromLine: number, tagName: string): boolean => {
    let depth = 1
    for (let k = fromLine + 1; k < lines.length; k++) {
      if (indented.has(k)) continue
      const kLine = lines[k]!
      if (!kLine.includes('<')) continue
      let kPos = 0
      while (kPos < kLine.length) {
        const lt = kLine.indexOf('<', kPos)
        if (lt < 0) break
        const t = parseHtmlTagAt(kLine, lt)
        if (!t) { kPos = lt + 1; continue }
        if (t.name === tagName && !t.selfClosing) {
          if (t.closing) {
            depth--
            if (depth === 0) return true
          } else {
            depth++
          }
        }
        kPos = t.end
      }
    }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const br = i < breaks.length ? breaks[i] : undefined
    if (indented.has(i) || !line.includes('<')) {
      nextLines.push(line)
      if (br !== undefined) nextBreaks.push(br)
      continue
    }
    const layout = lineLayout(line)
    const content = line.slice(layout.contentStart).trimEnd()
    // 判定该行是否完全由无对应开标签的闭合标签、空自闭合结构容器或真正未闭合的纯样式开标签组成。
    let allDroppable = false
    if (content.startsWith('<')) {
      let pos = 0
      let count = 0
      let ok = true
      while (pos < content.length) {
        while (pos < content.length && (content[pos] === ' ' || content[pos] === '\t')) pos++
        if (pos >= content.length) break
        const tag = parseHtmlTagAt(content, pos)
        if (!tag) { ok = false; break }
        if (tag.closing) {
          if (!ORPHAN_CLOSE_TAG_NAMES.has(tag.name) || (openCounts.get(tag.name) ?? 0) > 0) {
            ok = false
            break
          }
        } else if (tag.selfClosing) {
          if (!SAFE_EMPTY_SELF_CLOSING_BLOCKS.has(tag.name)) { ok = false; break }
          const attrs = parseSafeTagAttrs(tag.rawAttrs)
          if (!attrs || !hasOnlyAttrs(attrs, BLOCK_SAFE_ATTRS)) { ok = false; break }
        } else if (ORPHAN_STANDALONE_INLINE_OPENS.has(tag.name)) {
          const attrs = parseSafeTagAttrs(tag.rawAttrs)
          if (!attrs || !hasOnlyAttrs(attrs, SPAN_SAFE_ATTRS) || hasMatchingCloseLater(i, tag.name)) {
            ok = false
            break
          }
        } else {
          ok = false
          break
        }
        count++
        pos = tag.end
      }
      allDroppable = ok && count > 0
    }
    if (allDroppable) {
      changed = true
      continue
    }
    // 非可丢弃行：记录本行内所有相关标签的开闭计数，防止误删成对闭标签。
    let pos = layout.contentStart
    while (pos < line.length) {
      const open = line.indexOf('<', pos)
      if (open < 0) break
      const tag = parseHtmlTagAt(line, open)
      if (!tag) { pos = open + 1; continue }
      if (ORPHAN_CLOSE_TAG_NAMES.has(tag.name) && !tag.selfClosing) {
        const cur = openCounts.get(tag.name) ?? 0
        if (!tag.closing) openCounts.set(tag.name, cur + 1)
        else if (cur > 0) openCounts.set(tag.name, cur - 1)
      }
      pos = tag.end
    }
    nextLines.push(line)
    if (br !== undefined) nextBreaks.push(br)
  }

  if (!changed) return text
  while (nextBreaks.length >= nextLines.length && nextBreaks.length > 0) nextBreaks.pop()
  return joinLinesWithBreaks(nextLines, nextBreaks)
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
      const hasContentBefore = out.slice(Math.min(out.length, layout.quotePrefix.length)).trim() !== ''
      if (atLineEnd) {
        if (runCount >= 2 && nextLine !== undefined && nextContent.trim() !== '') {
          const nextQuote = lineLayout(nextLine).quotePrefix
          out += `\n${nextQuote === layout.quotePrefix ? layout.quotePrefix.trimEnd() : ''}`
        } else if (runCount === 1 && nextIsContinuation) {
          out += '  '
        }
        c = line.length
      } else if (!hasContentBefore) {
        // 行首（或引用前缀后直接）出现 <br>：输出干净的空行而非带两个前导空格的硬换行。
        out += `\n${layout.quotePrefix}`
        c = end + (afterSlice.length - afterTrimmed.length)
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
  out = convertSafePreBlocks(out, mask)
  out = convertSafeInlineCode(out, mask)
  out = convertSafeImages(out, mask)
  out = unwrapSafePresentational(out)
  out = convertSafeRuby(out)
  out = convertSafeLinks(out)
  out = normalizeBlockHtml(out, mask)
  out = convertSafeInlineFormatting(out, mask)
  out = stripOrphanBlockCloseLines(out)
  out = convertSafeLinks(out)
  out = convertSafeLineBreaks(out, mask)
  if (out === mask.masked) return text
  return mask.restore(out.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1'))
}
