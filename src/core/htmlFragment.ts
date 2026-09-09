/** 识别没有文档外壳的卡面片段：只定位闭合容器，保留原字节，跳过代码示例、注释和原始文本元素。 */
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'table', 'ul', 'ol', 'form', 'fieldset'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'pre', 'code'])

export function findHtmlFragment(text: string): { start: number; end: number } | null {
  // 属性引号内的 > 或 </div> 不参与闭合计数；各分支首字符互斥，避免嵌套回溯。
  const tokens = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/g
  let root = '', depth = 0, start = -1, end = -1, ticks = 0, marker = ''
  let lower: string | undefined
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const raw = token[0], at = token.index
    if (!depth && end >= 0 && text.slice(end, at).trim()) break
    if (raw.startsWith('`') || raw.startsWith('~')) {
      if (!depth) {
        if (!ticks) { ticks = raw.length; marker = raw[0]! }
        else if (raw[0] === marker && raw.length === ticks) ticks = 0
      }
      continue
    }
    if (ticks || raw.startsWith('<!--')) continue
    const tag = token[1]!.toLowerCase(), closing = raw.startsWith('</')
    if (!closing && RAW_TEXT.has(tag)) {
      lower ??= text.toLowerCase()
      const close = lower.indexOf('</' + tag, tokens.lastIndex)
      if (close < 0) break
      tokens.lastIndex = close
      continue
    }
    if (!depth) {
      if (closing || !CONTAINERS.has(tag) || raw.endsWith('/>')) {
        if (end >= 0) break
        continue
      }
      // 四空格/制表符缩进的顶层标签属于 Markdown 代码；容器内部缩进不受影响。
      const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at)
      if (/^(?: {4}|\t)/.test(line) && !line.trim()) continue
      root = tag; depth = 1
      if (start < 0) start = at
    } else if (tag === root) {
      if (closing) {
        if (--depth === 0) end = tokens.lastIndex
      } else if (!raw.endsWith('/>')) depth++
    }
  }
  return end < 0 ? null : { start, end }
}
