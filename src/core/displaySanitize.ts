/**
 * 展示层收起模型输出的机读标签与未闭合的 HTML 小部件。不改会话存储，不进入 prompt。
 *
 * 社区预设常让模型在正文末尾写 UpdateVariable，或贴一段日志小部件 HTML。
 * 预设若没带展示正则，Markdown 会把这些当正文渲染。封面整页 HTML 原样留给 iframe；
 * 小部件 HTML 后面若还有正文，拆开后只对正文做收起。
 */
import { collectRenderedHtml, locateRenderedHtml } from './regex.js'
import { findHtmlOpaqueEnd, HTML_CARD_CONTAINERS, LENIENT_OPAQUE } from './htmlFragment.js'
import { markdownCodeScanner } from './markdownCode.js'

const DISPLAY_META_TAGS = [
  'initvar',
  'UpdateVariable',
  'JSONPatch',
  'Analysis',
  'think',
  'thinking',
  'StatusPlaceHolderImpl',
] as const

type TextRange = { start: number; end: number }
type MetaStackEntry = { name: string; start: number; tokenEnd: number; slash: boolean }
const DISPLAY_META_NAMES = new Set<string>(DISPLAY_META_TAGS.map(tag => tag.toLowerCase()))

/** 是否为展示层应隐藏的机读块标签名（忽略大小写）。 */
export function isDisplayMetaTagName(name: string): boolean {
  return DISPLAY_META_NAMES.has(name.toLowerCase())
}
/** 真正 raw-text 的脚本可含标签字面量；style 能通过 CSS content 直接展示属性或字符串，不能豁免。 */
const OPAQUE_HTML_TAGS = new Set(['script'])
/** 这些容器把内层标签当可见文本；其中的 script/style 不能反过来开启不可见 raw-text 状态。 */
const VISIBLE_TEXT_TAGS = new Set(['textarea', 'title', 'xmp', 'plaintext', 'style', 'select', 'option', 'math', 'svg'])
const TAG_HEAD_RE = /<(\/?)([A-Za-z][\w:-]*)/y
const isHtmlSpace = (char: string | undefined): boolean => char === '\t' || char === '\n' || char === '\f' || char === '\r' || char === ' '

function tagHead(text: string, start: number, limit = text.length): { closing: boolean; name: string; end: number } | null {
  TAG_HEAD_RE.lastIndex = start
  const parsed = TAG_HEAD_RE.exec(text)
  const end = TAG_HEAD_RE.lastIndex
  if (!parsed?.[2] || end > limit || end < limit && !/[\t\n\f\r />]/.test(text[end]!)) return null
  return { closing: parsed[1] === '/', name: parsed[2].toLowerCase(), end }
}

/** 畸形且未闭合的普通标签后仍可能出现机读块；只扫描一次并按隐私优先隐藏至文末。 */
function firstDisplayMetaOpen(text: string, start: number, limit = text.length): number {
  let cursor = start
  while (cursor < limit) {
    const open = text.indexOf('<', cursor)
    if (open < 0 || open >= limit) return -1
    const head = tagHead(text, open, limit)
    if (head && !head.closing && DISPLAY_META_NAMES.has(head.name)) return open
    cursor = open + 1
  }
  return -1
}

/** 找到 HTML 标签的 `>`；属性引号里的大于号不结束标签。 */
function htmlTagEnd(text: string, start: number, limit = text.length): number {
  const head = tagHead(text, start, limit)
  if (!head) return -2
  type State = 'before-name' | 'name' | 'after-name' | 'before-value' | 'unquoted' | 'quoted' | 'after-value'
  let state: State = 'before-name'
  let quote: '"' | "'" | null = null
  for (let i = head.end; i < limit; i++) {
    const char = text[i]!
    if (state === 'quoted') {
      if (char === quote) { quote = null; state = 'after-value' }
      continue
    }
    if (char === '>') return i + 1
    if (state === 'before-name') {
      if (isHtmlSpace(char) || char === '/') continue
      state = 'name'
      continue
    }
    if (state === 'name') {
      if (isHtmlSpace(char)) state = 'after-name'
      else if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
      continue
    }
    if (state === 'after-name') {
      if (isHtmlSpace(char)) continue
      if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
      else state = 'name'
      continue
    }
    if (state === 'before-value') {
      if (isHtmlSpace(char)) continue
      if (char === '"' || char === "'") { quote = char; state = 'quoted' }
      else state = 'unquoted'
      continue
    }
    if (state === 'unquoted') {
      if (isHtmlSpace(char)) state = 'before-name'
      continue
    }
    if (state === 'after-value') {
      if (isHtmlSpace(char) || char === '/') state = 'before-name'
      else state = 'name'
    }
  }
  return -1
}

/** `/` 只有在属性名边界或引号值之后紧邻 `>` 时才设置 HTML self-closing flag。 */
function isHtmlSelfClosingTag(text: string, headEnd: number, tokenEnd: number): boolean {
  const slash = tokenEnd - 2
  if (slash < headEnd || text[slash] !== '/') return false
  type State = 'before-name' | 'name' | 'after-name' | 'before-value' | 'unquoted' | 'quoted' | 'after-value'
  let state: State = 'before-name'
  let quote: '"' | "'" | null = null
  for (let i = headEnd; i < slash; i++) {
    const char = text[i]!
    if (state === 'quoted') {
      if (char === quote) { quote = null; state = 'after-value' }
      continue
    }
    if (state === 'before-name') {
      if (isHtmlSpace(char) || char === '/') continue
      state = 'name'
    }
    else if (state === 'name') {
      if (isHtmlSpace(char)) state = 'after-name'
      else if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
    }
    else if (state === 'after-name') {
      if (isHtmlSpace(char)) continue
      if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
      else state = 'name'
    }
    else if (state === 'before-value') {
      if (isHtmlSpace(char)) continue
      if (char === '"' || char === "'") { quote = char; state = 'quoted' }
      else state = 'unquoted'
    }
    else if (state === 'unquoted') {
      if (isHtmlSpace(char)) state = 'before-name'
    }
    else if (state === 'after-value') {
      if (isHtmlSpace(char) || char === '/') state = 'before-name'
      else state = 'name'
    }
  }
  return state === 'before-name' || state === 'name' || state === 'after-name' || state === 'after-value'
}

/** 在当前片段内找 raw/代码元素自身闭标签；不会跨进下一个独立 iframe/Markdown part。 */
function opaqueCloseToken(text: string, name: string, start: number, limit: number): TextRange | null {
  let cursor = start
  while (cursor < limit) {
    const open = text.indexOf('<', cursor)
    if (open < 0 || open >= limit) return null
    const head = tagHead(text, open, limit)
    if (head?.closing && head.name === name) {
      const end = htmlTagEnd(text, open, limit)
      if (end > 0) return { start: open, end }
      if (end < 0) return null
    }
    cursor = open + 1
  }
  return null
}

/** select/option/MathML 使用普通标签 tokenizer；属性引号里的伪 closing token 不能提前结束容器。 */
function structuredCloseToken(
  text: string,
  name: string,
  start: number,
  limit: number,
  nested = false,
): TextRange | null {
  let cursor = start
  let depth = 1
  while (cursor < limit) {
    const open = text.indexOf('<', cursor)
    if (open < 0 || open >= limit) return null
    if ((name === 'math' || name === 'svg') && text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + '<![CDATA['.length)
      if (close < 0 || close >= limit) return null
      cursor = close + 3
      continue
    }
    if (text.startsWith('<!--', open)) {
      const end = htmlCommentEnd(text, open, limit)
      if (end < 0) return null
      cursor = end
      continue
    }
    const head = tagHead(text, open, limit)
    if (!head) {
      if (text.startsWith('<?', open) || text.startsWith('<!', open) || text.startsWith('</', open)) {
        const close = text.indexOf('>', open + 2)
        if (close < 0 || close >= limit) return null
        cursor = close + 1
      }
      else cursor = open + 1
      continue
    }
    const end = htmlTagEnd(text, open, limit)
    if (end < 0) return null
    if (head.name === name) {
      if (head.closing) {
        depth--
        if (depth === 0) return { start: open, end }
      }
      else if (nested && !isHtmlSelfClosingTag(text, head.end, end)) depth++
    }
    if (name !== 'math' && name !== 'svg' && !head.closing && head.name === 'script') {
      const scriptClose = opaqueCloseToken(text, 'script', end, limit)
      if (!scriptClose) return null
      cursor = scriptClose.end
      continue
    }
    cursor = end
  }
  return null
}

/** DOCTYPE 的 PUBLIC/SYSTEM 标识允许引号内出现 `>`。 */
function doctypeEnd(text: string, start: number, limit: number): number {
  let quote: '"' | "'" | null = null
  for (let index = start; index < limit; index++) {
    const char = text[index]!
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return index + 1
  }
  return -1
}

/** HTML 注释的正常闭合；若浏览器会更早 abrupt-close，则返回 -1 让调用方保守隐藏本段余下内容。 */
function htmlCommentEnd(text: string, open: number, limit: number): number {
  const content = open + 4
  if (content < limit && (text[content] === '>' || text.startsWith('->', content))) return -1
  for (let i = content; i < limit; i++) {
    if (text[i] !== '-' || text[i + 1] !== '-') continue
    if (text[i + 2] === '>') return i + 3 <= limit ? i + 3 : -1
    if (text[i + 2] === '!' && text[i + 3] === '>') return -1
  }
  return -1
}

type AttributeValueRange = TextRange & { quoted: boolean }

/** 按 HTML tokenizer 的属性状态收集值区间；引号只有在等号后的 value 状态才有语义。 */
function attributeValueRanges(text: string, start: number, limit: number): AttributeValueRange[] {
  type State = 'before-name' | 'name' | 'after-name' | 'before-value' | 'unquoted' | 'quoted' | 'after-value'
  const ranges: AttributeValueRange[] = []
  let state: State = 'before-name'
  let quote: '"' | "'" | null = null
  let valueStart = -1
  let valueQuoted = false
  const finish = (end: number): void => {
    if (valueStart >= 0) ranges.push({ start: valueStart, end, quoted: valueQuoted })
    valueStart = -1
    valueQuoted = false
  }
  for (let i = start; i < limit; i++) {
    const char = text[i]!
    if (state === 'quoted') {
      if (char === quote) { finish(i); quote = null; state = 'after-value' }
      continue
    }
    if (state === 'before-name') {
      if (isHtmlSpace(char) || char === '/') continue
      state = 'name'
      continue
    }
    if (state === 'name') {
      if (isHtmlSpace(char)) state = 'after-name'
      else if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
      continue
    }
    if (state === 'after-name') {
      if (isHtmlSpace(char)) continue
      if (char === '=') state = 'before-value'
      else if (char === '/') state = 'before-name'
      else state = 'name'
      continue
    }
    if (state === 'before-value') {
      if (isHtmlSpace(char)) continue
      if (char === '"' || char === "'") { quote = char; valueStart = i + 1; valueQuoted = true; state = 'quoted' }
      else { valueStart = i; valueQuoted = false; state = 'unquoted' }
      continue
    }
    if (state === 'unquoted') {
      if (isHtmlSpace(char)) { finish(i); state = 'before-name' }
      continue
    }
    if (state === 'after-value') {
      if (isHtmlSpace(char) || char === '/') state = 'before-name'
      else state = 'name'
    }
  }
  if (state === 'quoted' || state === 'unquoted') finish(limit)
  return ranges
}

type DecodedReferences = { text: string; starts: Int32Array; ends: Int32Array }
const META_REFERENCE_CANDIDATE_RE = /&(?:amp;|lt;?|#0*(?:38|60);?|#x0*(?:26|3c);?|num;|semi;|tab;|newline;|sol;)/i

function needsReferenceDecode(value: string): boolean {
  return value.includes('&') && (value.includes('<') || META_REFERENCE_CANDIDATE_RE.test(value))
}

type DecodedReferenceToken = { decoded: string; end: number }

function numericReferenceAt(value: string, start: number): { codePoint: number; end: number } | null {
  if (value[start] !== '#') return null
  let digit = start + 1
  const hex = value[digit]?.toLowerCase() === 'x'
  if (hex) digit++
  const begin = digit
  const valid = hex ? /[0-9a-f]/i : /[0-9]/
  while (digit < value.length && valid.test(value[digit]!)) digit++
  if (digit === begin) return null
  const raw = Number.parseInt(value.slice(begin, digit), hex ? 16 : 10)
  // HTML5 §13.2.5.80：NUL、UTF-16 代理码位与越界码点均映射为 U+FFFD，防止产生裸代理对或空字节。
  const codePoint = !Number.isFinite(raw) || raw <= 0 || raw > 0x10ffff || (raw >= 0xd800 && raw <= 0xdfff)
    ? 0xfffd
    : raw
  return { codePoint, end: value[digit] === ';' ? digit + 1 : digit }
}

/** 解析单个受支持字符引用；映射与轻量预判共用同一语义，避免两条解码路径漂移。 */
function decodedReferenceAt(value: string, index: number): DecodedReferenceToken {
  let cursor = index + 1
  let ampLayers = 0
  while (true) {
    if (value.slice(cursor, cursor + 4).toLowerCase() === 'amp;') {
      cursor += 4
      ampLayers++
      continue
    }
    const numericAmp = numericReferenceAt(value, cursor)
    if (numericAmp?.codePoint === 38) {
      cursor = numericAmp.end
      ampLayers++
      continue
    }
    break
  }
  const tail = value.slice(cursor, cursor + 8).toLowerCase()
  let decoded: string | null = null
  let end = cursor
  if (tail.startsWith('lt;')) { decoded = '<'; end += 3 }
  else if (tail.startsWith('gt;')) { decoded = '>'; end += 3 }
  else if (tail.startsWith('tab;')) { decoded = '\t'; end += 4 }
  else if (tail.startsWith('newline;')) { decoded = '\n'; end += 8 }
  else if (tail.startsWith('sol;')) { decoded = '/'; end += 4 }
  else if (tail.startsWith('num;')) { decoded = '#'; end += 4 }
  else if (tail.startsWith('semi;')) { decoded = ';'; end += 5 }
  else if (tail.startsWith('lt')) { decoded = '<'; end += 2 }
  else if (tail.startsWith('gt')) { decoded = '>'; end += 2 }
  else {
    const numeric = numericReferenceAt(value, cursor)
    if (numeric) { decoded = String.fromCodePoint(numeric.codePoint); end = numeric.end }
  }
  if (decoded !== null) return { decoded, end }
  if (ampLayers > 0) return { decoded: '&', end: cursor }
  return { decoded: '&', end: index + 1 }
}

/** 不建立逐字符源码 span，按 `&` 分块完成与正式映射相同的一轮解码。 */
function decodeReferenceTextPass(value: string): string {
  const out: string[] = []
  let copied = 0
  let cursor = 0
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor)
    if (amp < 0) break
    const token = decodedReferenceAt(value, amp)
    if (token.end === amp + 1) { cursor = token.end; continue }
    out.push(value.slice(copied, amp), token.decoded)
    copied = token.end
    cursor = token.end
  }
  if (out.length === 0) return value
  out.push(value.slice(copied))
  return out.join('')
}

/** 有界固定点轻量解码仅用于判断是否可能生成标签语法，不承担源码区间映射。 */
function decodeReferenceText(value: string): string {
  let current = value
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeReferenceTextPass(current)
    if (next === current) return next
    current = next
  }
  return current
}

/** 单轮字符引用解码；输入区间数组已指向原源码，非 `&` 连续片段通过 TypedArray 批量复制，多轮后仍精确删除原始字节区间。 */
function decodeReferencePass(current: DecodedReferences): DecodedReferences {
  const value = current.text
  if (!value.includes('&')) return current
  const inStarts = current.starts
  const inEnds = current.ends
  const fallbackEnd = inStarts.length > 0 ? inEnds[inStarts.length - 1]! : 0
  const out: string[] = []
  let nextStarts: Int32Array | null = null
  let nextEnds: Int32Array | null = null
  let outLen = 0
  let copied = 0
  let cursor = 0
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor)
    if (amp < 0) break
    const token = decodedReferenceAt(value, amp)
    if (token.end === amp + 1) { cursor = token.end; continue }
    if (nextStarts === null || nextEnds === null) {
      nextStarts = new Int32Array(value.length)
      nextEnds = new Int32Array(value.length)
    }
    if (amp > copied) {
      out.push(value.slice(copied, amp))
      nextStarts.set(inStarts.subarray(copied, amp), outLen)
      nextEnds.set(inEnds.subarray(copied, amp), outLen)
      outLen += amp - copied
    }
    const mappedStart = amp < inStarts.length ? inStarts[amp]! : fallbackEnd
    const endIdx = token.end - 1
    const mappedEnd = endIdx >= 0 && endIdx < inEnds.length ? inEnds[endIdx]! : (amp < inEnds.length ? inEnds[amp]! : fallbackEnd)
    out.push(token.decoded)
    for (let i = 0; i < token.decoded.length; i++) {
      nextStarts[outLen] = mappedStart
      nextEnds[outLen] = mappedEnd
      outLen++
    }
    copied = token.end
    cursor = token.end
  }
  if (nextStarts === null || nextEnds === null) return current
  if (copied < value.length) {
    out.push(value.slice(copied))
    nextStarts.set(inStarts.subarray(copied), outLen)
    nextEnds.set(inEnds.subarray(copied), outLen)
    outLen += value.length - copied
  }
  return { text: out.join(''), starts: nextStarts.subarray(0, outLen), ends: nextEnds.subarray(0, outLen) }
}

/** 有界固定点解码覆盖属性解析 + srcdoc/data/RCDATA 二次解析，同时保持 O(n)。 */
function decodeReferences(value: string, offset = 0): DecodedReferences {
  const starts = new Int32Array(value.length)
  const ends = new Int32Array(value.length)
  for (let i = 0; i < value.length; i++) {
    starts[i] = offset + i
    ends[i] = offset + i + 1
  }
  let current: DecodedReferences = { text: value, starts, ends }
  for (let pass = 0; pass < 4; pass++) {
    const next = decodeReferencePass(current)
    if (next.text === current.text) return next
    current = next
  }
  return current
}

/** 属性内部独立配对，供整值清理判断；属性中的孤立 closer 不关闭外层边界。 */
function attributeMetaState(value: string): { sawOpen: boolean; pending: Array<{ name: string; slash: boolean }> } {
  if (!value.includes('<') && !META_REFERENCE_CANDIDATE_RE.test(value)) return { sawOpen: false, pending: [] }
  const decoded = needsReferenceDecode(value) ? decodeReferenceText(value) : value
  const pending: Array<{ name: string; slash: boolean }> = []
  let sawOpen = false
  let cursor = 0
  while (cursor < decoded.length) {
    const open = decoded.indexOf('<', cursor)
    if (open < 0) break
    const head = tagHead(decoded, open)
    if (!head || !DISPLAY_META_NAMES.has(head.name)) { cursor = open + 1; continue }
    const end = htmlTagEnd(decoded, open)
    const slash = end > 0 && isHtmlSelfClosingTag(decoded, head.end, end)
    if (!head.closing) { sawOpen = true; pending.push({ name: head.name, slash }) }
    else if (pending.at(-1)?.name === head.name) pending.pop()
    if (end < 0) break
    cursor = end
  }
  return { sawOpen, pending }
}

type AttributeAnalysis = { values: AttributeValueRange[]; dangerous: TextRange[]; pending: MetaStackEntry[] }

/** 属性值可被 srcdoc、CSS attr() 或脚本再次展示；命中时清空，仅畸形未引号源码 opener 延续。 */
function analyzeAttributeValues(text: string, start: number, limit: number): AttributeAnalysis {
  const values = attributeValueRanges(text, start, limit)
  const dangerous: TextRange[] = []
  const pending: MetaStackEntry[] = []
  for (const value of values) {
    const state = attributeMetaState(text.slice(value.start, value.end))
    if (state.sawOpen) dangerous.push(value)
    if (value.quoted) continue
    const rawState = literalMetaState(text.slice(value.start, value.end))
    for (const opened of rawState.pending) {
      pending.push({ name: opened.name, start: value.start, tokenEnd: value.end, slash: opened.slash })
    }
  }
  return { values, dangerous, pending }
}

/** 畸形属性名里的 `<think>` 会借自己的 `>` 结束外层标签；把它当隐私 opener 延续到后文。 */
function embeddedAttributeNameOpeners(
  text: string,
  start: number,
  limit: number,
  values: readonly TextRange[],
): MetaStackEntry[] {
  const pending: MetaStackEntry[] = []
  let cursor = start
  let rangeIndex = 0
  while (cursor < limit) {
    const open = text.indexOf('<', cursor)
    if (open < 0 || open >= limit) break
    while (rangeIndex < values.length && values[rangeIndex]!.end <= open) rangeIndex++
    const value = values[rangeIndex]
    const insideValue = Boolean(value && open >= value.start && open < value.end)
    const head = tagHead(text, open, limit)
    if (head && !head.closing && DISPLAY_META_NAMES.has(head.name) && !insideValue) {
      pending.push({
        name: head.name,
        start: open,
        tokenEnd: text[limit] === '>' ? limit + 1 : limit,
        // 这里的 opener 已被外层畸形属性名吞入，不能再逐个向后重扫或信任 XML 式自闭合。
        slash: false,
      })
    }
    cursor = open + 1
  }
  return pending
}

function collectTagInteriorMeta(
  text: string,
  start: number,
  limit: number,
  stack: MetaStackEntry[],
  ranges: TextRange[],
): void {
  if (start >= limit) return
  const lt = text.indexOf('<', start)
  const amp = text.indexOf('&', start)
  if ((lt < 0 || lt >= limit) && (amp < 0 || amp >= limit)) return
  const attributes = analyzeAttributeValues(text, start, limit)
  ranges.push(...attributes.dangerous)
  const resume = text[limit] === '>' ? limit + 1 : limit
  stack.push(...[...attributes.pending, ...embeddedAttributeNameOpeners(text, start, limit, attributes.values)]
    .sort((a, b) => a.start - b.start)
    .map(opened => ({ ...opened, start: resume, tokenEnd: resume })))
}

/** 可见 raw/RCDATA 正文中的机读标签独立配对；孤立 closer 不得关闭外层边界。 */
function literalMetaState(value: string): { ranges: TextRange[]; pending: MetaStackEntry[] } {
  const ranges: TextRange[] = []
  const pending: MetaStackEntry[] = []
  let cursor = 0
  while (cursor < value.length) {
    const open = value.indexOf('<', cursor)
    if (open < 0) break
    const head = tagHead(value, open)
    if (!head || !DISPLAY_META_NAMES.has(head.name)) { cursor = open + 1; continue }
    const end = htmlTagEnd(value, open)
    const tokenEnd = end > 0 ? end : value.length
    const slash = end > 0 && isHtmlSelfClosingTag(value, head.end, end)
    if (!head.closing) pending.push({ name: head.name, start: open, tokenEnd, slash })
    else {
      const opened = pending.at(-1)
      if (!opened || opened.name !== head.name) ranges.push({ start: open, end: tokenEnd })
      else {
        ranges.push({ start: opened.start, end: tokenEnd })
        pending.pop()
      }
    }
    if (end < 0) break
    cursor = end
  }
  return { ranges, pending }
}

function mappedDecodedRange(range: TextRange, decoded: DecodedReferences, fallback: number): TextRange {
  const len = decoded.starts.length
  const hasFirst = range.start >= 0 && range.start < len
  const lastIdx = range.end - 1
  const hasLast = lastIdx >= 0 && lastIdx < len
  return {
    start: hasFirst ? decoded.starts[range.start]! : fallback,
    end: hasLast ? decoded.ends[lastIdx]! : (hasFirst ? decoded.ends[range.start]! : fallback),
  }
}

function collectLiteralMeta(
  text: string,
  start: number,
  end: number,
  decodeEntities: boolean,
  stack: MetaStackEntry[],
  ranges: TextRange[],
): void {
  if (start >= end) return
  const lt = text.indexOf('<', start)
  const hasLt = lt >= 0 && lt < end
  const amp = decodeEntities ? text.indexOf('&', start) : -1
  const hasAmp = amp >= 0 && amp < end
  if (!hasLt && !hasAmp) return
  const source = text.slice(start, end)
  const lightweight = decodeEntities && hasAmp && needsReferenceDecode(source) ? decodeReferenceText(source) : source
  const decode = lightweight !== source && lightweight.includes('<')
  if (!hasLt && !decode) return
  const decoded = decode ? decodeReferences(source, start) : null
  const visible = decoded?.text ?? source
  const map = (range: TextRange): TextRange => decoded
    ? mappedDecodedRange(range, decoded, end)
    : { start: start + range.start, end: start + range.end }
  let cursor = 0
  while (cursor < visible.length) {
    const open = visible.indexOf('<', cursor)
    if (open < 0) break
    const head = tagHead(visible, open)
    if (!head || !DISPLAY_META_NAMES.has(head.name)) { cursor = open + 1; continue }
    const tokenEnd = htmlTagEnd(visible, open)
    const localEnd = tokenEnd > 0 ? tokenEnd : visible.length
    const mapped = map({ start: open, end: localEnd })
    const slash = tokenEnd > 0 && isHtmlSelfClosingTag(visible, head.end, tokenEnd)
    if (!head.closing) stack.push({ name: head.name, start: mapped.start, tokenEnd: mapped.end, slash })
    else {
      const opened = stack.at(-1)
      if (!opened || opened.name !== head.name) ranges.push(mapped)
      else {
        ranges.push({ start: opened.start, end: mapped.end })
        stack.pop()
      }
    }
    if (tokenEnd < 0) break
    cursor = tokenEnd
  }
}

/** 注释/DOCTYPE 等不可见声明只在自身内部清理，内部 closer 不能关闭外层正文边界。 */
function collectIsolatedLiteralMeta(
  text: string,
  start: number,
  end: number,
  decodeEntities: boolean,
  ranges: TextRange[],
): void {
  const source = text.slice(start, end)
  const lightweight = decodeEntities && needsReferenceDecode(source) ? decodeReferenceText(source) : source
  const decode = lightweight !== source && lightweight.includes('<')
  if (!source.includes('<') && !decode) return
  const decoded = decode ? decodeReferences(source, start) : null
  const visible = decoded?.text ?? source
  const map = (range: TextRange): TextRange => decoded
    ? mappedDecodedRange(range, decoded, end)
    : { start: start + range.start, end: start + range.end }
  const local = literalMetaState(visible)
  ranges.push(...local.ranges.map(map))
  for (const opened of local.pending) {
    ranges.push(map({ start: opened.start, end: opened.slash ? opened.tokenEnd : visible.length }))
  }
}

/** 外来/选择控件内容按普通标签边界扫描；属性内 closer 不得关闭正文中的机读边界。 */
function collectStructuredVisibleMeta(
  text: string,
  start: number,
  end: number,
  removeComments: boolean,
  scriptOpaque: boolean,
  stack: MetaStackEntry[],
  ranges: TextRange[],
): void {
  let index = start
  while (index < end) {
    const open = text.indexOf('<', index)
    if (open < 0 || open >= end) {
      collectLiteralMeta(text, index, end, true, stack, ranges)
      break
    }
    if (open > index) collectLiteralMeta(text, index, open, true, stack, ranges)
    if (text.startsWith('<!--', open)) {
      const closed = htmlCommentEnd(text, open, end)
      const rangeEnd = closed < 0 ? end : closed
      if (removeComments || closed < 0) ranges.push({ start: open, end: rangeEnd })
      index = rangeEnd
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const contentStart = open + '<![CDATA['.length
      const close = text.indexOf(']]>', contentStart)
      const contentEnd = close < 0 || close >= end ? end : close
      collectLiteralMeta(text, contentStart, contentEnd, false, stack, ranges)
      index = close < 0 || close >= end ? end : close + 3
      continue
    }
    const parsed = tagHead(text, open, end)
    const invalidEndTag = text.startsWith('</', open) && !parsed
    if (text.startsWith('<?', open) || text.startsWith('<!', open) || invalidEndTag) {
      const doctype = /^<!doctype(?=[\t\n\f\r >])/i.test(text.slice(open, Math.min(open + 16, end)))
      const found = doctype ? doctypeEnd(text, open + 2, end) : (() => {
        const close = text.indexOf('>', open + 2)
        return close < 0 || close >= end ? -1 : close + 1
      })()
      const rangeEnd = found < 0 ? end : found
      if (doctype && removeComments) collectIsolatedLiteralMeta(text, open, rangeEnd, true, ranges)
      else if (removeComments) ranges.push({ start: open, end: rangeEnd })
      index = rangeEnd
      continue
    }
    if (!parsed) { index = open + 1; continue }
    const tokenEnd = htmlTagEnd(text, open, end)
    if (tokenEnd < 0) {
      if (DISPLAY_META_NAMES.has(parsed.name)) collectLiteralMeta(text, open, end, false, stack, ranges)
      else collectTagInteriorMeta(text, parsed.end, end, stack, ranges)
      break
    }
    if (DISPLAY_META_NAMES.has(parsed.name)) collectLiteralMeta(text, open, tokenEnd, false, stack, ranges)
    else {
      collectTagInteriorMeta(text, parsed.end, tokenEnd - 1, stack, ranges)
      if (scriptOpaque && !parsed.closing && parsed.name === 'script') {
        const closed = opaqueCloseToken(text, 'script', tokenEnd, end)
        if (!closed) break
        const closeHead = tagHead(text, closed.start, closed.end)
        if (closeHead) collectTagInteriorMeta(text, closeHead.end, closed.end - 1, stack, ranges)
        index = closed.end
        continue
      }
    }
    index = tokenEnd
  }
}

function mergeRanges(input: TextRange[]): TextRange[] {
  const sorted = input.filter(range => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: TextRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end) merged.push({ ...range })
    else previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

/**
 * 机读块是内容不透明边界：整块隐藏，未闭合时隐私优先隐藏到文末。
 * 扫描器只处理 DISPLAY_META_TAGS；details/style/widget 等卡面内容留给后续 HTML 拆分。
 */
function opaqueDisplayMetaRanges(
  text: string,
  removeComments: boolean,
  segments: readonly TextRange[] = [{ start: 0, end: text.length }],
): TextRange[] {
  if (!text.includes('<') && !text.includes('&')) return []
  const ranges: TextRange[] = []
  const stack: MetaStackEntry[] = []
  const streamEnd = segments.at(-1)?.end ?? text.length
  for (const segment of segments) {
    let opaque: string | null = null
    let index = segment.start
    while (index < segment.end) {
      const open = text.indexOf('<', index)

      // 每个展示 part 都在独立 Markdown/iframe 语境；opaque 只延续到本段自身闭标签，不能毒化后续 part。
      if (opaque) {
        const closed = opaqueCloseToken(text, opaque, index, segment.end)
        if (closed) {
          const head = tagHead(text, closed.start, closed.end)
          if (head) collectTagInteriorMeta(text, head.end, closed.end - 1, stack, ranges)
          opaque = null
          index = closed.end
          continue
        }
        // 畸形未闭合 opaque 内仍按隐私优先寻找机读 opener；正常闭合元素继续保留标签字面量。
        const hidden = firstDisplayMetaOpen(text, index, segment.end)
        if (hidden >= 0) { opaque = null; index = hidden; continue }
        break
      }

      if (open < 0 || open >= segment.end) {
        collectLiteralMeta(text, index, segment.end, true, stack, ranges)
        break
      }
      if (open > index) collectLiteralMeta(text, index, open, true, stack, ranges)

      if (text.startsWith('<!--', open)) {
        const closed = htmlCommentEnd(text, open, segment.end)
        const unclosed = closed < 0
        const end = unclosed ? segment.end : closed
        // 畸形注释在浏览器里可能 abrupt-close 后继续渲染；找不到精确闭合时整段隐藏才不会泄漏。
        if (removeComments || unclosed) ranges.push({ start: open, end })
        index = end
        continue
      }

      const parsed = tagHead(text, open, segment.end)
      const invalidEndTag = text.startsWith('</', open) && !parsed
      if (text.startsWith('<?', open) || text.startsWith('<!', open) || invalidEndTag) {
        const doctype = /^<!doctype(?=[\t\n\f\r >])/i.test(text.slice(open, Math.min(open + 16, segment.end)))
        const found = doctype
          ? doctypeEnd(text, open + 2, segment.end)
          : (() => {
              const close = text.indexOf('>', open + 2)
              return close < 0 || close >= segment.end ? -1 : close + 1
            })()
        const end = found < 0 ? segment.end : found
        if (doctype && removeComments) collectIsolatedLiteralMeta(text, open, end, true, ranges)
        if (removeComments && !doctype) ranges.push({ start: open, end })
        index = end
        continue
      }
      if (!parsed) { index = open + 1; continue }

      const end = htmlTagEnd(text, open, segment.end)
      if (end < 0) {
        if (DISPLAY_META_NAMES.has(parsed.name)) {
          ranges.push({ start: open, end: streamEnd })
        }
        else collectTagInteriorMeta(text, parsed.end, segment.end, stack, ranges)
        break
      }
      const { closing, name } = parsed
      const selfClosing = isHtmlSelfClosingTag(text, parsed.end, end)

      if (DISPLAY_META_NAMES.has(name)) {
        if (!closing) stack.push({ name, start: open, tokenEnd: end, slash: selfClosing })
        else {
          const opened = stack.at(-1)
          if (!opened || opened.name !== name) ranges.push({ start: open, end })
          else {
            ranges.push({ start: opened.start, end })
            stack.pop()
          }
        }
        index = end
        continue
      }

      collectTagInteriorMeta(text, parsed.end, end - 1, stack, ranges)
      if (!closing && VISIBLE_TEXT_TAGS.has(name)) {
        const structured = name === 'select' || name === 'option' || name === 'math' || name === 'svg'
        const closed = name === 'plaintext'
          ? null
          : structured
            ? structuredCloseToken(text, name, end, segment.end, name === 'math' || name === 'svg')
            : opaqueCloseToken(text, name, end, segment.end)
        const contentEnd = closed?.start ?? segment.end
        if (structured) collectStructuredVisibleMeta(
          text,
          end,
          contentEnd,
          removeComments,
          name === 'select' || name === 'option',
          stack,
          ranges,
        )
        else collectLiteralMeta(
          text,
          end,
          contentEnd,
          name === 'textarea' || name === 'title',
          stack,
          ranges,
        )
        if (closed) {
          const closeHead = tagHead(text, closed.start, closed.end)
          if (closeHead) collectTagInteriorMeta(text, closeHead.end, closed.end - 1, stack, ranges)
          index = closed.end
        }
        else index = segment.end
        continue
      }
      if (!closing && OPAQUE_HTML_TAGS.has(name)) {
        opaque = name
        index = end
        continue
      }
      index = end
    }
  }
  for (const opened of stack) ranges.push({ start: opened.start, end: opened.slash ? opened.tokenEnd : streamEnd })
  return mergeRanges(ranges)
}

function removeRanges(text: string, ranges: readonly TextRange[], offset = 0): string {
  if (ranges.length === 0) return text
  const end = offset + text.length
  let cursor = offset
  const out: string[] = []
  for (const range of ranges) {
    if (range.end <= offset) continue
    if (range.start >= end) break
    if (range.start > cursor) out.push(text.slice(cursor - offset, Math.min(range.start, end) - offset))
    cursor = Math.max(cursor, Math.min(range.end, end))
  }
  if (cursor < end) out.push(text.slice(cursor - offset))
  return out.join('')
}

/** 只删除机读块及其内容；不 trim，也不处理 details/style/widget/透明协议壳。 */
export function stripOpaqueDisplayMeta(text: string, removeComments = false): string {
  return removeRanges(text, opaqueDisplayMetaRanges(text, removeComments))
}

/** 跨有序片段延续机读标签状态，再把保留内容映射回原 kind/title。 */
export function stripOpaqueDisplayMetaParts<T extends { text: string }>(
  parts: readonly T[],
  removeComments = false,
  separator = '',
): T[] {
  const combined = parts.map(part => part.text).join(separator)
  let offset = 0
  const segments = parts.map(part => {
    const segment = { start: offset, end: offset + part.text.length }
    offset = segment.end + separator.length
    return segment
  })
  const ranges = opaqueDisplayMetaRanges(combined, removeComments, segments)
  return mapVisibleMetaParts(parts,ranges,separator)
}

/** 同一卡面跨宿主续写消息仍是连续 HTML；脚本和属性语境不能在消息边界重置。 */
export function stripContinuedDisplayMetaParts<T extends {text:string}>(parts:readonly T[]):T[] {
  return mapVisibleMetaParts(parts,opaqueDisplayMetaRanges(parts.map(part=>part.text).join(''),false),'')
}

function mapVisibleMetaParts<T extends {text:string}>(parts:readonly T[],ranges:TextRange[],separator:string):T[] {
  let offset = 0
  return parts.map(part => {
    const text = removeRanges(part.text, ranges, offset)
    offset += part.text.length + separator.length
    return { ...part, text }
  })
}

/**
 * 社区卡常用的机读协议标签（customize_HCI / now_plot / world_status）。
 * 下划线名或 PascalCase；不碰 div/p/span 等 HTML。
 */
const PROTOCOL_TAG_RE =
  /<\/?([A-Za-z][\w]*_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b[^>]*\/?>/g

// 机读协议常用全大写标签；HTML 本身不区分大小写，不能把 <DIV>/<BR> 当协议删掉。
const HTML_ELEMENT_NAMES = new Set(('a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blockquote body br button canvas '
  + 'caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed '
  + 'fencedframe fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr '
  + 'html i iframe img input ins kbd keygen label legend li link main map mark marquee menu menuitem meta meter nav nobr noframes '
  + 'noscript object ol optgroup option output p param picture plaintext portal pre progress q rb rp rt rtc ruby s samp '
  + 'script search section select slot small source span strike strong style sub summary sup svg table tbody td '
  + 'template textarea tfoot th thead time title tr track tt u ul var video wbr xmp '
  + 'animatemotion animatetransform circle clippath defs ellipse feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix '
  + 'fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage '
  + 'femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence filter foreignobject g image '
  + 'line lineargradient mask mpath path pattern polygon polyline radialgradient rect stop symbol text textpath tref tspan use view '
  + 'annotation-xml maction math menclose merror mfenced mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow mspace '
  + 'msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics').split(' '))

/** 是否为标准 HTML / SVG / MathML 元素名（忽略大小写）。 */
export function isKnownHtmlElementName(name: string): boolean {
  return HTML_ELEMENT_NAMES.has(name.toLowerCase())
}

const EMAIL_AUTOLINK_RE = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/
const URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>]+>$/
const AUTOLINK_SCHEMES = new Set([
  'http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'urn', 'irc', 'ircs',
  'ws', 'wss', 'ssh', 'git', 'file', 'magnet', 'news', 'xmpp', 'sip',
  'sips', 'sms', 'geo', 'data', 'blob', 'javascript', 'vbscript',
])
const CUSTOM_TAG_TOKEN_RE = /^<(\/?)([A-Za-z][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:[ \t][^<>]*?)?(\/?)>$/

function hasCodeIndent(line: string): boolean {
  let cols = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === ' ') cols += 1
    else if (ch === '\t') cols += 4 - (cols % 4)
    else break
    if (cols >= 4) return true
  }
  return false
}

/** 按 CommonMark 四列制表位剥离多层引用块前缀并判定剩余缩进是否达到 4 列缩进代码。 */
function scanBlockquoteAndIndent(line: string): { quotePrefixEnd: number; contentStart: number; indentedCode: boolean } {
  let index = 0
  let col = 0
  let quotePrefixEnd = 0
  while (index < line.length) {
    let probe = index
    let probeCol = col
    let spaces = 0
    while (probe < line.length && spaces < 4) {
      const ch = line[probe]!
      if (ch === ' ') {
        spaces++
        probeCol++
        probe++
      } else if (ch === '\t') {
        const width = 4 - (probeCol % 4)
        if (spaces + width >= 4) break
        spaces += width
        probeCol += width
        probe++
      } else {
        break
      }
    }
    if (line[probe] !== '>') break
    probe++
    probeCol++
    if (probe < line.length) {
      if (line[probe] === ' ') {
        probe++
        probeCol++
      } else if (line[probe] === '\t') {
        const width = 4 - (probeCol % 4)
        probe++
        index = probe
        quotePrefixEnd = probe
        let indentCols = width - 1
        col = probeCol + width
        if (indentCols >= 4) return { quotePrefixEnd, contentStart: index, indentedCode: true }
        while (index < line.length) {
          const ch = line[index]!
          if (ch === ' ') {
            indentCols++
            col++
            index++
          } else if (ch === '\t') {
            const tabWidth = 4 - (col % 4)
            indentCols += tabWidth
            col += tabWidth
            index++
          } else {
            break
          }
          if (indentCols >= 4) return { quotePrefixEnd, contentStart: index, indentedCode: true }
        }
        continue
      }
    }
    index = probe
    col = probeCol
    quotePrefixEnd = probe
  }
  let indentCols = 0
  while (index < line.length) {
    const ch = line[index]!
    if (ch === ' ') {
      indentCols++
      col++
      index++
    } else if (ch === '\t') {
      const width = 4 - (col % 4)
      indentCols += width
      col += width
      index++
    } else {
      break
    }
    if (indentCols >= 4) return { quotePrefixEnd, contentStart: index, indentedCode: true }
  }
  return { quotePrefixEnd, contentStart: index, indentedCode: false }
}

function customTagName(token: string): string | null {
  if (token.startsWith('<!--') || token.startsWith('<!') || token.startsWith('<?')) return null
  if (EMAIL_AUTOLINK_RE.test(token)) return null
  if (!/\s/.test(token)) {
    const uri = URI_AUTOLINK_RE.exec(token)
    if (uri && (token.includes('://') || AUTOLINK_SCHEMES.has(uri[1]!.toLowerCase()))) return null
  }
  const match = CUSTOM_TAG_TOKEN_RE.exec(token)
  if (!match) return null
  const name = match[2]!
  return isKnownHtmlElementName(name) ? null : name.toLowerCase()
}

function stripCustomTagTokensInLine(line: string, strippedNames: ReadonlySet<string>): string {
  if (!line.includes('<')) return line
  if (scanBlockquoteAndIndent(line).indentedCode) return line
  const out: string[] = []
  let cursor = 0
  let i = 0
  while (i < line.length) {
    if (line[i] !== '<') {
      i++
      continue
    }
    let j = i + 1
    while (j < line.length && line[j] !== '>' && line[j] !== '<') j++
    if (j < line.length && line[j] === '>') {
      const name = customTagName(line.slice(i, j + 1))
      if (name !== null && strippedNames.has(name)) {
        if (i > cursor) out.push(line.slice(cursor, i))
        cursor = j + 1
      }
      i = j + 1
      continue
    }
    i = j
  }
  if (cursor === 0) return line
  if (cursor < line.length) out.push(line.slice(cursor))
  return out.join('')
}

/**
 * 清理会触发 CommonMark Type 7 HTML 块并吞掉后续围栏的行首自定义伪标签，
 * 以及与这些已确认伪标签同行混写的配对残余；跳过缩进代码、自动链接与标准 HTML 元素。
 */
function stripCustomTags(text: string): string {
  if (!text.includes('<')) return text
  const strippedNames = new Set<string>()
  const firstPass: string[] = []
  const lineBreak = /\r?\n/g
  let lineStart = 0
  let changed = false

  const processLine = (line: string, breakText: string): void => {
    let handled = false
    if (line.includes('<')) {
      const layout = scanBlockquoteAndIndent(line)
      if (!layout.indentedCode) {
        const trimmed = line.slice(layout.contentStart).replace(/[ \t]+$/, '')
        if (trimmed.startsWith('<')) {
          const lineNames: string[] = []
          let pos = 0
          let allCustom = true
          while (pos < trimmed.length) {
            if (trimmed[pos] !== '<') { allCustom = false; break }
            let j = pos + 1
            while (j < trimmed.length && trimmed[j] !== '>' && trimmed[j] !== '<') j++
            if (j >= trimmed.length || trimmed[j] !== '>') { allCustom = false; break }
            const name = customTagName(trimmed.slice(pos, j + 1))
            if (name === null) { allCustom = false; break }
            lineNames.push(name)
            pos = j + 1
            while (pos < trimmed.length && (trimmed[pos] === ' ' || trimmed[pos] === '\t')) pos++
          }
          if (allCustom && lineNames.length > 0) {
            for (const name of lineNames) strippedNames.add(name)
            firstPass.push(line.slice(0, layout.quotePrefixEnd).replace(/[ \t]+$/, ''), breakText)
            changed = true
            handled = true
          }
        }
      }
    }
    if (!handled) firstPass.push(line, breakText)
  }

  for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
    processLine(text.slice(lineStart, match.index), match[0])
    lineStart = lineBreak.lastIndex
  }
  processLine(text.slice(lineStart), '')

  if (!changed) return text
  const pass1 = firstPass.join('')
  if (strippedNames.size === 0 || !pass1.includes('<')) return pass1

  const secondPass: string[] = []
  let sStart = 0
  let sChanged = false
  lineBreak.lastIndex = 0
  for (let match = lineBreak.exec(pass1); match; match = lineBreak.exec(pass1)) {
    const line = pass1.slice(sStart, match.index)
    const next = stripCustomTagTokensInLine(line, strippedNames)
    if (next !== line) sChanged = true
    secondPass.push(next, match[0])
    sStart = lineBreak.lastIndex
  }
  const tail = pass1.slice(sStart)
  const nextTail = stripCustomTagTokensInLine(tail, strippedNames)
  if (nextTail !== tail) sChanged = true
  secondPass.push(nextTail)
  return sChanged ? secondPass.join('') : pass1
}

function isCoverHtml(text: string): boolean {
  return /<!DOCTYPE\s+html/i.test(text) || /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text)
}

const DISPLAY_META_ALT = DISPLAY_META_TAGS.join('|')
const META_TAG_SCREEN_RE = new RegExp(`<(?:${DISPLAY_META_ALT}|style|details)(?=[\\t\\n\\f\\r />])`, 'i')
const CLOSED_EMPTY_META_RES = DISPLAY_META_TAGS.map((tag) => ({
  selfClosing: new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])[^>]*/[\\t\\n\\f\\r ]*>`, 'gi'),
  paired: new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])[^>]*>[\\s\\S]*?</${tag}[\\t\\n\\f\\r ]*>`, 'gi'),
}))
const UNCLOSED_ANY_META_RE = new RegExp(`<(?:${DISPLAY_META_ALT})(?=[\\t\\n\\f\\r />])`, 'i')
const WIDGET_TAIL_ANY_RE = /<(?:div\b[^>]*\b(?:stream-log|[\w-]*-box)\b|details\b[^>]*\b[\w-]*-box\b|style\b)/i

function stripClosedAndEmpty(text: string): string {
  let out = text
  for (let pass = 0; pass < 8; pass++) {
    if (!META_TAG_SCREEN_RE.test(out)) break
    let next = out
    for (const { selfClosing, paired } of CLOSED_EMPTY_META_RES) {
      next = next.replace(selfClosing, '')
      next = next.replace(paired, '')
    }
    next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    next = next.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')
    if (next === out) break
    out = next
  }
  return out
}

/** 未闭合的协议标签（流式输出到一半）从开标签切到文末。 */
function stripUnclosedMeta(text: string): string {
  const match = UNCLOSED_ANY_META_RE.exec(text)
  return match ? text.slice(0, match.index) : text
}

/**
 * 日志/折叠小部件几乎总是接在正文之后，且经常标签没闭合。
 * 从第一个特征开标签切到文末，避免半截 HTML 露出来。
 */
function stripWidgetTail(text: string): string {
  const match = WIDGET_TAIL_ANY_RE.exec(text)
  return match ? text.slice(0, match.index) : text
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+(?=\r?\n)/g, '')
    .replace(/(\r?\n)(?:\r?\n){2,}/g, '$1$1')
    .trim()
}

/** 收起未转换成 HTML 的协议开闭标签，留下内部正文。 */
function stripProtocolTags(text: string): string {
  return text.replace(PROTOCOL_TAG_RE, (match, name:string) => HTML_ELEMENT_NAMES.has(name.toLowerCase()) ? match : '')
}

/** 独立样式片段不应占一个空 iframe；跨过普通台词，将 CSS 交给下一张真正的卡面。 */
export function mergeDetachedCardStyles<T extends {kind:'markdown'|'html';text:string;title?:string}>(parts:readonly T[]):T[] {
  const styleOnly=/^\s*(?:<style\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/style\s*>\s*)+$/i
  const prefixes=new Map<number,string[]>()
  const moved=new Set<number>()
  for(let i=0;i<parts.length;i++) {
    const part=parts[i]!
    if(part.kind!=='html'||part.title||!styleOnly.test(part.text))continue
    let target=i+1
    while(target<parts.length && (parts[target]!.kind!=='html'||styleOnly.test(parts[target]!.text)))target++
    if(target===parts.length)continue
    const group=prefixes.get(target)??[]
    group.push(part.text)
    prefixes.set(target,group)
    moved.add(i)
  }
  return parts.flatMap((part,index)=>moved.has(index)?[]:[prefixes.has(index)
    ? {...part,text:prefixes.get(index)!.join('\n')+'\n'+part.text}
    : part])
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const COMMONMARK_TAG_RE = /<(?:\/([A-Za-z][\w:-]*)\s*>|([A-Za-z][\w:-]*)(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*(\/?)>)/y

interface MarkdownCodeProtectionOptions {
  skipHtmlFences?: boolean
  skipInsideHtml?: boolean
  initialOuterOpen?: ReadonlyMap<string, number>
  collectOpenMeta?: Map<string, number>
  skipAllCode?: boolean
}

function isExecutableHtmlFence(
  text: string,
  fence: NonNullable<ReturnType<ReturnType<typeof markdownCodeScanner>['fence']>>,
): boolean {
  if (!fence.standalone) return false
  const info = fence.info.trim().split(/\s+/)[0]!.toLowerCase()
  if (info === 'html' || info === 'xml') return true
  if (info === '' || info === 'text') {
    return streamingHtmlStart(text.slice(fence.contentStart, fence.contentEnd).trimStart(), false) !== null
  }
  return false
}

/**
 * 展示净化不得改写的 Markdown 代码区间：围栏（含开闭行）与行内代码。
 * 代码示例里的 `<style>`/`<details>`/`think`/协议标签是作者给模型看的正文，不是机读块；
 * 仅当外层存在尚未闭合的标签/注释/脚本边界，且候选代码区间吞入该外层边界的闭合标签时才拒绝保护。
 */
function markdownCodeRanges(text: string, options?: MarkdownCodeProtectionOptions): TextRange[] {
  const hasCodeTokens = !options?.skipAllCode && (text.includes('`') || text.includes('~~~'))
  if (!hasCodeTokens && !options?.collectOpenMeta) return []
  const ranges: TextRange[] = []
  const hasAngles = text.includes('<')
  const outerOpen = new Map<string, number>(options?.initialOuterOpen)
  let outerCursor = 0
  let blockedUntil = 0
  let rejectedSpan: { from: number; end: number; failAt: number } | null = null

  const pushOpen = (name: string): void => {
    outerOpen.set(name, (outerOpen.get(name) ?? 0) + 1)
    rejectedSpan = null
  }
  const popOpen = (name: string): void => {
    const count = outerOpen.get(name) ?? 0
    if (count <= 0) return
    if (count === 1) outerOpen.delete(name)
    else outerOpen.set(name, count - 1)
    rejectedSpan = null
  }
  const hasOpenHtmlElement = (): boolean => {
    for (const name of outerOpen.keys()) {
      if (isKnownHtmlElementName(name)) return true
    }
    return false
  }

  const advanceOuter = (target: number): boolean => {
    if (!hasAngles) return true
    if (target < blockedUntil) return false
    while (outerCursor < target) {
      const open = text.indexOf('<', outerCursor)
      if (open < 0 || open >= target) {
        outerCursor = target
        break
      }
      if (text.startsWith('<!--', open)) {
        const close = text.indexOf('-->', open + 4)
        const end = close < 0 ? text.length : close + 3
        blockedUntil = end
        outerCursor = end
        if (target < blockedUntil) return false
        continue
      }
      COMMONMARK_TAG_RE.lastIndex = open
      const cm = COMMONMARK_TAG_RE.exec(text)
      if (cm) {
        const end = COMMONMARK_TAG_RE.lastIndex
        const closingName = cm[1]?.toLowerCase()
        if (closingName) {
          popOpen(closingName)
        } else {
          const openName = cm[2]!.toLowerCase()
          const selfClosing = Boolean(cm[3])
          if (openName === 'script' && !selfClosing) {
            const closed = opaqueCloseToken(text, 'script', end, text.length)
            if (closed) {
              blockedUntil = closed.end
              outerCursor = closed.end
              if (target < blockedUntil) return false
              continue
            }
            pushOpen(openName)
          } else if (!selfClosing && !VOID_TAGS.has(openName)) {
            pushOpen(openName)
          }
        }
        blockedUntil = end
        outerCursor = end
        if (target < blockedUntil) return false
        continue
      }
      const head = tagHead(text, open)
      if (head?.closing) {
        const end = htmlTagEnd(text, open)
        if (end > 0) {
          popOpen(head.name)
          blockedUntil = end
          outerCursor = end
          if (target < blockedUntil) return false
          continue
        }
      } else if (head && DISPLAY_META_NAMES.has(head.name)) {
        const end = htmlTagEnd(text, open)
        if (end < 0 || !isHtmlSelfClosingTag(text, head.end, end)) pushOpen(head.name)
        if (end > 0) {
          blockedUntil = end
          outerCursor = end
          if (target < blockedUntil) return false
        } else {
          outerCursor = head.end
        }
        continue
      }
      outerCursor = open + 1
    }
    return target >= blockedUntil
  }

  const closesOuterBoundary = (start: number, end: number): boolean => {
    if (!hasAngles || outerOpen.size === 0) return false
    if (rejectedSpan && rejectedSpan.end === end && start <= rejectedSpan.failAt) {
      const nextLt = text.indexOf('<', rejectedSpan.from)
      if (nextLt < 0 || nextLt >= start) return true
    }
    let innerOpen: Map<string, number> | null = null
    let cursor = start
    while (cursor < end) {
      const open = text.indexOf('<', cursor)
      if (open < 0 || open >= end) break
      const head = tagHead(text, open, end)
      if (!head) {
        cursor = open + 1
        continue
      }
      const tokenEnd = htmlTagEnd(text, open, end)
      if (!outerOpen.has(head.name)) {
        cursor = tokenEnd > 0 ? tokenEnd : open + 1
        continue
      }
      if (tokenEnd < 0) {
        cursor = open + 1
        continue
      }
      if (VOID_TAGS.has(head.name) || isHtmlSelfClosingTag(text, head.end, tokenEnd)) {
        cursor = tokenEnd
        continue
      }
      if (!head.closing) {
        innerOpen ??= new Map()
        innerOpen.set(head.name, (innerOpen.get(head.name) ?? 0) + 1)
      } else {
        const local = innerOpen?.get(head.name) ?? 0
        if (local > 0) innerOpen!.set(head.name, local - 1)
        else {
          rejectedSpan = { from: start, end, failAt: open }
          return true
        }
      }
      cursor = tokenEnd
    }
    return false
  }

  if (hasCodeTokens) {
    const code = markdownCodeScanner(text)
    const tokens = /`+|~{3,}/g
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
      const at = token.index
      const fence = code.fence(at)
      if (fence) {
        if (options?.skipHtmlFences && isExecutableHtmlFence(text, fence)) {
          advanceOuter(at)
          if (fence.closed && outerOpen.size === 0) outerCursor = Math.max(outerCursor, fence.end)
          tokens.lastIndex = Math.max(fence.end, at + 1)
          continue
        }
        // 围栏区间不含闭合行后的换行：换行属于正文排版，仍交给 tidy 收尾。
        let end = fence.end
        while (end > at && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--
        if (advanceOuter(at) && !(options?.skipInsideHtml && hasOpenHtmlElement()) && !closesOuterBoundary(at, end)) {
          ranges.push({ start: at, end })
          outerCursor = Math.max(outerCursor, fence.end)
          rejectedSpan = null
          tokens.lastIndex = Math.max(fence.end, at + 1)
        }
        continue
      }
      const end = code.inlineEnd(at)
      if (end !== null && advanceOuter(at) && !(options?.skipInsideHtml && hasOpenHtmlElement()) && !closesOuterBoundary(at, end)) {
        ranges.push({ start: at, end })
        outerCursor = Math.max(outerCursor, end)
        rejectedSpan = null
        tokens.lastIndex = end
      }
    }
  }
  if (options?.collectOpenMeta) {
    advanceOuter(text.length)
    for (const [name, count] of outerOpen) {
      if (DISPLAY_META_NAMES.has(name) && count > 0) options.collectOpenMeta.set(name, count)
    }
  }
  return ranges
}

/**
 * 把代码区间换成占位符后跑整段净化管线，再原样还原：
 * 跨段状态（「从开标签切到文末」的截断、整篇 tidy）仍按整篇判定，
 * 但代码示例的字节不会被任何删除/截断规则改写。占位符前缀会先确认不在原文中出现。
 */
function protectMarkdownCode(
  text: string,
  options?: MarkdownCodeProtectionOptions,
): { masked: string; restore: (value: string) => string } {
  const ranges = markdownCodeRanges(text, options)
  if (ranges.length === 0) return { masked: text, restore: value => value }
  let prefix = '\uE000tavernCode'
  while (text.includes(prefix)) prefix += 'X'
  const suffix = '\uE001'
  const parts: string[] = []
  let masked = ''
  let cursor = 0
  for (const [index, range] of ranges.entries()) {
    masked += text.slice(cursor, range.start) + `${prefix}${index}${suffix}`
    parts.push(text.slice(range.start, range.end))
    cursor = range.end
  }
  masked += text.slice(cursor)
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${suffix}`, 'g')
  return { masked, restore: value => value.replace(pattern, (_raw, index: string) => parts[Number(index)] ?? '') }
}

/** 展示层机读清理：保护 Markdown 代码示例里的伪/机读标签，同时仍清理 HTML 卡片和 HTML 围栏内的机读块。 */
export function stripDisplayOpaqueMeta(text: string, removeComments = false): string {
  if (!text) return text
  const protectedCode = protectMarkdownCode(text, { skipHtmlFences: true, skipInsideHtml: true })
  return protectedCode.restore(stripOpaqueDisplayMeta(protectedCode.masked, removeComments))
}

/** 跨有序片段展示层机读清理：仅保护 Markdown 片段的代码示例，HTML 片段内反引号按原样 HTML 处理。 */
export function stripDisplayOpaqueMetaParts<T extends { kind?: 'markdown' | 'html'; text: string }>(
  parts: readonly T[],
  removeComments = false,
  separator = '',
): T[] {
  if (parts.length === 0) return []
  let prefix = '\uE000tavernCode'
  while (parts.some(part => part.text.includes(prefix))) prefix += 'X'
  const suffix = '\uE001'
  const saved: string[] = []
  let openMeta = new Map<string, number>()
  const maskedParts = parts.map(part => {
    const nextMeta = new Map<string, number>()
    const ranges = markdownCodeRanges(part.text, {
      skipHtmlFences: true,
      skipInsideHtml: true,
      initialOuterOpen: openMeta,
      collectOpenMeta: nextMeta,
      skipAllCode: part.kind === 'html',
    })
    openMeta = nextMeta
    if (ranges.length === 0) return part
    let masked = ''
    let cursor = 0
    for (const range of ranges) {
      const index = saved.length
      saved.push(part.text.slice(range.start, range.end))
      masked += part.text.slice(cursor, range.start) + `${prefix}${index}${suffix}`
      cursor = range.end
    }
    masked += part.text.slice(cursor)
    return { ...part, text: masked }
  })
  const visible = stripOpaqueDisplayMetaParts(maskedParts, removeComments, separator)
  if (saved.length === 0) return visible
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${suffix}`, 'g')
  return visible.map(part => ({
    ...part,
    text: part.text.replace(pattern, (_raw, index: string) => saved[Number(index)] ?? ''),
  }))
}

/** 去掉展示不该看见的机读块与小部件；角色正文与 Markdown 代码示例保留。 */
export function stripDisplayMeta(text: string): string {
  if (!text) return text
  const protectedCode = protectMarkdownCode(text)
  const visible = stripOpaqueDisplayMeta(protectedCode.masked)
  if (!visible.includes('<')) return protectedCode.restore(tidy(visible))
  if (isCoverHtml(visible)) return protectedCode.restore(visible)
  return protectedCode.restore(tidy(
    stripProtocolTags(stripCustomTags(stripWidgetTail(stripUnclosedMeta(stripClosedAndEmpty(stripHtmlComments(visible)))))),
  ))
}

const STREAMING_HTML_TAG_NAMES = [...HTML_CARD_CONTAINERS, 'html', 'body', 'style', 'script', 'template'] as const
const STREAMING_HTML_TAG_SET: ReadonlySet<string> = new Set(STREAMING_HTML_TAG_NAMES)

/**
 * 只识别正在生成的卡面起点，不执行模板或第三方正则。未闭合 HTML 不能送入 iframe，
 * 从首个卡面起暂缓展示尾部；完整回复仍由服务端按原文执行常规只读展示投影。
 * 与正式抽取共用容器集合和 Markdown 代码边界，普通代码示例不当成半张卡片。
 */
function streamingHtmlStart(text: string, scanMarkdown: boolean | ReturnType<typeof markdownCodeScanner> = true): number | null {
  if (!text.includes('<') && (!scanMarkdown || (!text.includes('```') && !text.includes('~~~')))) return null
  const code = scanMarkdown === true ? markdownCodeScanner(text) : scanMarkdown || null
  const tokens = /<|`+|~{3,}/g
  let lineStart = 0, nextLine = text.indexOf('\n')
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const at = token.index
    if (token[0] !== '<') {
      const fence = code?.fence(at)
      if (fence) {
        const info = fence.info.trim().split(/\s+/)[0]!.toLowerCase()
        if (fence.standalone && (['html', 'xml'].includes(info)
          || ['', 'text'].includes(info) && streamingHtmlStart(text.slice(fence.contentStart, fence.contentEnd).trimStart(), false) !== null)) return at
        tokens.lastIndex = fence.end
      } else {
        const end = code?.inlineEnd(at)
        if (end != null) tokens.lastIndex = end
      }
      continue
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4)
      if (end < 0) return null
      tokens.lastIndex = end + 3
      continue
    }
    while (nextLine >= 0 && nextLine < at) { lineStart = nextLine + 1; nextLine = text.indexOf('\n', lineStart) }
    const indented = hasCodeIndent(text.slice(lineStart, at))
    // 行首的卡面标签也可能在标签名内部截断；代码/注释已在上面跳过。
    // 单独的 < 仍按普通文字保留，不能把比较符号当成已确定的 HTML。
    if (!indented && !text.slice(lineStart, at).trim() && text.length - at <= 32 && text.indexOf('>', at + 1) < 0) {
      const tail=text.slice(at).toLowerCase()
      if (/^<[a-z]+$/.test(tail) && STREAMING_HTML_TAG_NAMES.some(tag=>tag.startsWith(tail.slice(1)))) return at
      if (/^<![a-z]+(?:\s+[a-z]*)?$/.test(tail) && '<!doctype html'.startsWith(tail.replace(/\s+/g,' '))) return at
    }
    if (!indented && /^<!doctype(?:\s+html\b|$)/i.test(text.slice(at, at + 20))) return at
    const head = tagHead(text, at)
    if (!head) continue
    if (!indented && !head.closing && STREAMING_HTML_TAG_SET.has(head.name)) return at
    const end = htmlTagEnd(text, at)
    if (end < 0) break
    tokens.lastIndex = end
    if (!head.closing && ['textarea', 'title', 'pre', 'code', 'noscript'].includes(head.name)) {
      const opaqueEnd = findHtmlOpaqueEnd(text, end, head.name)
      if (opaqueEnd !== null) tokens.lastIndex = opaqueEnd
      else if (!LENIENT_OPAQUE.has(head.name)) break
    }
  }
  return null
}

/** 流式正文只显示卡面前的台词；关闭交互卡时维持显式源码展示。 */
export function presentStreamingOutput(text: string, allowHtml: boolean): { text: string; pendingHtml: boolean } {
  if (!allowHtml) return { text: stripDisplayMeta(text), pendingHtml: false }
  const visible = stripDisplayOpaqueMeta(text)
  const start = streamingHtmlStart(visible)
  return { text: stripDisplayMeta(start === null ? visible : visible.slice(0, start)), pendingHtml: start !== null }
}

/** 找到未闭合卡面的起点；已完成的卡面、普通台词与代码示例不因后面的半张卡而被收起。 */
export function findIncompleteHtmlStart(text:string):number|null {
  let offset=0,previous:{start:number;end:number}|undefined
  for(let count=0;count<128;count++){
    const remaining=text.slice(offset)
    if(!remaining.includes('<')&&!remaining.includes('```')&&!remaining.includes('~~~'))return null
    const code=markdownCodeScanner(remaining)
    const start=streamingHtmlStart(remaining,code)
    if(start===null)return null
    const complete=locateRenderedHtml(remaining,code),completeStart=complete?.fence?.start??complete?.start
    if(complete&&completeStart!==undefined&&completeStart<=start){
      const end=offset+(complete.fence?.end??complete.start+complete.html.length)
      previous=complete.fence?undefined:{start:offset+completeStart,end};offset=end;continue
    }
    const at=offset+start
    // 紧贴完整组件的半段脚本/样式仍属于该组件，续写需要一起放入同一个沙箱。
    if(previous&&!text.slice(previous.end,at).trim()&&/^<(?:script|style|template)(?=[\s/>]|$)/i.test(text.slice(at)))return previous.start
    return at
  }
  if(streamingHtmlStart(text.slice(offset))!==null)throw new Error('交互卡展示片段过多')
  return null
}

/** 未闭合卡片只保留之前的内容，供显示提示；不补造 HTML、不运行脚本，也不修改存储原文。 */
export function hideIncompleteHtml(text:string):{text:string;pendingHtml?:true}{
  const start=findIncompleteHtmlStart(text)
  return start===null?{text}:{text:text.slice(0,start),pendingHtml:true}
}

/** 交互卡关闭后的源码回退：围栏长于内容中的反引号，不能逃逸成可执行 HTML。 */
export function htmlSourceFallback(html: string): string {
  let length = 3
  for (const match of html.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}html\n${html}\n${fence}`
}

/** 只在卡面之外收起机读标签；不能把已识别的 details/style 小部件连同正文裁掉。 */
function disabledHtmlText(rendered: string): string {
  const parts: string[] = []
  // 先在完整逻辑流上收起机读块；否则 HTML 拆分会切断 think/Analysis 等边界并泄漏内容。
  let remaining = stripDisplayOpaqueMeta(rendered, true)
  for (let i = 0; i < 128; i++) {
    const located = locateRenderedHtml(remaining)
    if (!located) { parts.push(stripDisplayMeta(remaining)); return parts.filter(Boolean).join('\n\n') }
    parts.push(stripDisplayMeta(remaining.slice(0, located.fence?.start ?? located.start)))
    parts.push(htmlSourceFallback(located.html))
    remaining = remaining.slice(located.fence?.end ?? located.start + located.html.length)
  }
  if (locateRenderedHtml(remaining)) throw new Error('交互卡展示片段过多')
  parts.push(stripDisplayMeta(remaining))
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 正则渲染后的展示拆分：交互卡 HTML 进 iframe（可能连续多段），剩余正文再收起机读标签。
 * `allowHtml` 为 false 时整段当文本（交互卡开关关闭）。
 */
export function presentRenderedOutput(
  rendered: string,
  allowHtml: boolean,
): { html: string | null; htmls: string[]; text: string; pendingHtml?:true } {
  if (!allowHtml) return { html: null, htmls: [], text: disabledHtmlText(rendered) }
  const visible=hideIncompleteHtml(stripDisplayOpaqueMeta(rendered))
  const { htmls, rest } = collectRenderedHtml(visible.text)
  const grouped=mergeDetachedCardStyles(htmls.map(text=>({kind:'html' as const,text}))).map(part=>part.text)
  return {
    html: grouped[0] ?? null,
    htmls: grouped,
    text: stripDisplayMeta(rest),
    ...(visible.pendingHtml?{pendingHtml:true as const}:{}),
  }
}
