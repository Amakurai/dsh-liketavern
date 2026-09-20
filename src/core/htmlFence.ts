/** 定位明确允许展示的 Markdown HTML 围栏；跳过注释、原始/惰性内容元素及其它语言代码块，保留完整围栏边界。 */
import { findHtmlDocument, findHtmlFragment, findHtmlOpaqueEnd } from './htmlFragment.js'
import { markdownCodeScanner } from './markdownCode.js'

export function findHtmlFence(text:string):{start:number;end:number;contentStart:number;contentEnd:number}|null {
  const code=markdownCodeScanner(text)
  const tokens=/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|pre|code|template|noscript)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
  for(let token=tokens.exec(text);token;token=tokens.exec(text)) {
    const raw=token[0]
    if(raw.startsWith('<!--'))continue
    if(token[1]) {
      const end=findHtmlOpaqueEnd(text,tokens.lastIndex,token[1])
      if(end===null)return null
      tokens.lastIndex=end;continue
    }
    const fence=code.fence(token.index)
    if(!fence) {
      const end=code.inlineEnd(token.index)
      if(end!==null)tokens.lastIndex=end
      continue
    }
    if(!fence.closed)return null
    tokens.lastIndex=fence.end
    const info=fence.info.trim().toLowerCase()
    if(!fence.standalone||!['','html','text','xml'].includes(info))continue
    const content=text.slice(fence.contentStart,fence.contentEnd),trimmed=content.trim()
    // 明确标成 html/xml 的围栏本身就是作者给出的执行边界。button、p、自定义元素等
    // 不需要再伪装成 div 才能进入沙箱；无语言/text 围栏仍走结构识别，避免把普通代码提升为卡面。
    if(!trimmed||(!['html','xml'].includes(info)&&!findHtmlDocument(trimmed)&&!findHtmlFragment(trimmed)))continue
    const start=fence.contentStart+content.indexOf(trimmed)
    return {start:token.index,end:fence.end,contentStart:start,contentEnd:start+trimmed.length}
  }
  return null
}
