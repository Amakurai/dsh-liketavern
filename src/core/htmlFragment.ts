/** 识别没有文档外壳的卡面片段：闭合容器与相邻样式/脚本共用沙箱，保留原字节并跳过代码示例。 */
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'table', 'ul', 'ol', 'form', 'fieldset', 'details'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'pre', 'code'])

/** 完整文档也按标签扫描；注释、代码示例与 script/style 字符串不参与文档边界判断。 */
export function findHtmlDocument(text:string):{start:number;end:number}|null {
  const tokens=/<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
  let start=-1,root='',ticks=0,marker=''
  for(let token=tokens.exec(text);token;token=tokens.exec(text)) {
    const raw=token[0],at=token.index
    if(raw.startsWith('<!--'))continue
    if(raw.startsWith('`')||raw.startsWith('~')) {
      if(start<0) {
        if(!ticks){ticks=raw.length;marker=raw[0]!}
        else if(raw[0]===marker&&raw.length===ticks)ticks=0
      }
      continue
    }
    if(ticks)continue
    const line=text.slice(text.lastIndexOf('\n',at-1)+1,at)
    if(start<0&&/^(?: {4}|\t)/.test(line))continue
    const tag=token[1]?.toLowerCase(),closing=raw.startsWith('</')
    if(start<0&&(/^<!doctype/i.test(raw)||!closing&&(tag==='html'||tag==='body'))) {
      start=at;root=tag==='body'?'body':'html'
    }
    if(tag&&!closing&&RAW_TEXT.has(tag)) {
      const closeRe=new RegExp('</'+tag+'\\s*>','gi');closeRe.lastIndex=tokens.lastIndex
      if(!closeRe.exec(text))break
      tokens.lastIndex=closeRe.lastIndex
    } else if(start>=0&&closing&&tag===root) {
      // 旧卡偶尔只写 body 起点却仍以 html 收尾；把紧跟的外壳闭标签一并保留。
      const tail=root==='body'?/^\s*<\/html\s*>/i.exec(text.slice(tokens.lastIndex)):null
      return {start,end:tokens.lastIndex+(tail?.[0].length??0)}
    }
  }
  return null
}

export function findHtmlFragment(text: string): { start: number; end: number } | null {
  // 属性引号内的 > 或 </div> 不参与闭合计数；各分支首字符互斥，避免嵌套回溯。
  const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
  let root = '', depth = 0, start = -1, end = -1, ticks = 0, marker = ''
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
    if (ticks) continue
    if (raw.startsWith('<!--')) {
      if (!depth && end >= 0) end = tokens.lastIndex
      continue
    }
    if (/^<!doctype/i.test(raw)) break
    const tag = token[1]!.toLowerCase(), closing = raw.startsWith('</')
    const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at)
    const indented = /^(?: {4}|\t)/.test(line)
    if (!depth && !closing && (tag === 'html' || tag === 'body')) {
      if (indented) continue
      break
    }
    if (!closing && RAW_TEXT.has(tag)) {
      const closeRe = new RegExp('</' + tag + '\\s*>', 'gi')
      closeRe.lastIndex = tokens.lastIndex
      if (!closeRe.exec(text)) break
      tokens.lastIndex = closeRe.lastIndex
      if (!depth) {
        if ((tag !== 'style' && tag !== 'script') || indented) {
          if (end >= 0) break
        } else {
          if (start < 0) start = at
          end = tokens.lastIndex
        }
      }
      continue
    }
    if (!depth) {
      if (closing || !CONTAINERS.has(tag) || raw.endsWith('/>')) {
        if (end >= 0) break
        continue
      }
      // 四空格/制表符缩进的顶层标签属于 Markdown 代码；容器内部缩进不受影响。
      if (indented) { if (end >= 0) break; continue }
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
