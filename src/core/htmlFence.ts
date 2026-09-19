/** 定位明确允许展示的 Markdown HTML 围栏；跳过注释、原始文本元素及其它语言代码块，保留完整围栏边界。 */
import { findHtmlDocument, findHtmlFragment } from './htmlFragment.js'
import { markdownCodeScanner } from './markdownCode.js'

export function findHtmlFence(text:string):{start:number;end:number;contentStart:number;contentEnd:number}|null {
  const code=markdownCodeScanner(text)
  const tokens=/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|pre|code)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
  for(let token=tokens.exec(text);token;token=tokens.exec(text)) {
    const raw=token[0]
    if(raw.startsWith('<!--'))continue
    if(token[1]) {
      const close=new RegExp('</'+token[1]+'\\s*>','gi');close.lastIndex=tokens.lastIndex
      if(!close.exec(text))return null
      tokens.lastIndex=close.lastIndex;continue
    }
    const fence=code.fence(token.index)
    if(!fence) {
      const end=code.inlineEnd(token.index)
      if(end!==null)tokens.lastIndex=end
      continue
    }
    if(!fence.closed)return null
    tokens.lastIndex=fence.end
    if(!fence.standalone||!['','html','text','xml'].includes(fence.info.trim().toLowerCase()))continue
    const content=text.slice(fence.contentStart,fence.contentEnd),trimmed=content.trim()
    if(!findHtmlDocument(trimmed)&&!findHtmlFragment(trimmed))continue
    const start=fence.contentStart+content.indexOf(trimmed)
    return {start:token.index,end:fence.end,contentStart:start,contentEnd:start+trimmed.length}
  }
  return null
}
