/** 定位明确允许展示的 Markdown HTML 围栏；跳过注释、原始文本元素及其它语言代码块，保留完整围栏边界。 */
import { findHtmlDocument, findHtmlFragment } from './htmlFragment.js'

export function findHtmlFence(text:string):{start:number;end:number;contentStart:number;contentEnd:number}|null {
  const tokens=/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|pre|code)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi
  for(let token=tokens.exec(text);token;token=tokens.exec(text)) {
    const raw=token[0]
    if(raw.startsWith('<!--'))continue
    if(token[1]) {
      const close=new RegExp('</'+token[1]+'\\s*>','gi');close.lastIndex=tokens.lastIndex
      if(!close.exec(text))return null
      tokens.lastIndex=close.lastIndex;continue
    }
    const line=text.slice(text.lastIndexOf('\n',token.index-1)+1,token.index)
    if(raw.length<3||!/^ {0,3}$/.test(line)) {
      if(raw[0]==='`') {
        const close=new RegExp('(?<!`)`{'+raw.length+'}(?!`)','g');close.lastIndex=tokens.lastIndex
        if(close.exec(text))tokens.lastIndex=close.lastIndex
      }
      continue
    }
    const info=/^([^\r\n]*)\r?\n/.exec(text.slice(tokens.lastIndex))
    if(!info)return null
    const contentStart=tokens.lastIndex+info[0].length
    const close=new RegExp('^ {0,3}'+raw[0]+'{'+raw.length+',}[ \\t]*(?:\\r?\\n|$)','gm');close.lastIndex=contentStart
    const closing=close.exec(text)
    if(!closing)return null
    tokens.lastIndex=close.lastIndex
    if(!['','html','text','xml'].includes(info[1]!.trim().toLowerCase()))continue
    const content=text.slice(contentStart,closing.index),trimmed=content.trim()
    if(!findHtmlDocument(trimmed)&&!findHtmlFragment(trimmed))continue
    const start=contentStart+content.indexOf(trimmed)
    return {start:token.index,end:close.lastIndex,contentStart:start,contentEnd:start+trimmed.length}
  }
  return null
}
