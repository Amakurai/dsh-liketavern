/** 展示模板在隔离 worker 内格式化；真实 Showdown 仅在 QuickJS 中运行，产物以有序片段交给安全 iframe。 */
import { parseTemplateDisplayParts, splitTemplateDisplay, type TemplateDisplayPart } from '../core/templateDisplay.js'
import type { WorldInfoEntry, MacroContext, RegexRule } from '../core/types.js'
import { applyRegexRules } from '../core/regex.js'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import type { TemplateSandbox } from './templateSandbox.js'

export const TEMPLATE_DISPLAY=String.raw`
let messageConverter;
function formatTemplateMessage(value) {
  const text=String(value ?? '');
  if(text.length>1024*1024) throw Error('消息格式化输入超过 1 MiB 上限');
  messageConverter ||= new __TavernTemplateLibraries.showdown.Converter({
    emoji:true,literalMidWordUnderscores:true,parseImgDimensions:true,tables:true,underline:true,
    simpleLineBreaks:true,strikethrough:true,disableForced4SpacesIndentedSublists:true,
    metadata:false,completeHTMLDocument:false,noHeaderId:true,tablesHeaderId:false,
  });
  const output=messageConverter.makeHtml(text);
  if(output.length>1024*1024) throw Error('消息格式化输出超过 1 MiB 上限');
  return output;
}
globalThis.__formatTemplateMessage=formatTemplateMessage;
__templateEscaper=(value,_locals)=>input.phase==='generate' ? String(value ?? '') : formatTemplateMessage(value);
`;

const FRAGMENT_HTML=/<\/?(?:p|div|span|strong|em|b|i|u|s|del|a|img|br|hr|h[1-6]|table|thead|tbody|tr|th|td|ul|ol|li|blockquote|pre|code|details|summary|section|article|main|button|input|form|svg|canvas|iframe)\b/i

export function renderTemplateDisplay(text:string,entries:WorldInfoEntry[],sandbox:TemplateSandbox,
  meta:{role:string;worldinfo:boolean;depth:number},decorate:boolean):{text:string;parts:TemplateDisplayPart[]} {
  const parts:TemplateDisplayPart[]=[]
  const textPieces:string[]=[]
  const sources:{value:string;entry?:WorldInfoEntry}[]=[]
  const append=(value:string,entry?:WorldInfoEntry)=>{
    textPieces.push(value)
    sources.push({value,entry})
  }
  const present=(raw:string,entry?:WorldInfoEntry)=>{
    const value=sandbox.resolveOutlets(raw)
    if(!value.trim()) return
    if(entry?.templateIframe!==undefined) {
      parts.push({kind:'html',text:entry.templateMessageFormatting?sandbox.formatMessage(value):value,...(entry.templateIframe?{title:entry.templateIframe}:{})})
      return
    }
    if(entry?.templateMessageFormatting) {
      parts.push({kind:'html',text:sandbox.formatMessage(value)})
      return
    }
    for(const part of splitTemplateDisplay(value,true)) {
      if(part.kind==='html') parts.push(part)
      else if(FRAGMENT_HTML.test(part.text)) parts.push({kind:'html',text:sandbox.formatMessage(part.text)})
      else {
        const clean=stripDisplayMeta(part.text)
        if(clean) parts.push({kind:'markdown',text:clean})
      }
    }
  }
  const renderEntries=(position:'BEFORE'|'AFTER')=>{
    for(const entry of entries.filter(entry=>entry.enabled && !entry.templateOnlyPreload && entry.comment.toUpperCase().startsWith(`[RENDER:${position}]`)).sort((a,b)=>a.order-b.order)) {
      if(!entry.templateCondition || sandbox.condition(entry.templateCondition)) append(sandbox.render(entry.content,{},entry.key),entry)
    }
  }
  if(decorate) renderEntries('BEFORE')
  append(decorate ? sandbox.transformRegex(sandbox.render(sandbox.transformRegex(text,'message',meta)),'after',meta) : sandbox.render(text))
  if(decorate) renderEntries('AFTER')
  for(const source of sources) present(source.value,source.entry)
  return {text:sandbox.resolveOutlets(textPieces.join('\n')),parts:parseTemplateDisplayParts(parts)}
}

/** 已提交片段的展示正则仍在 worker 内运行；逐片段保留角色卡框和正文位置。 */
export function presentTemplateDisplay(parts:TemplateDisplayPart[],rules:RegexRule[],macroCtx:MacroContext):TemplateDisplayPart[] {
  const output:TemplateDisplayPart[]=[]
  for(const part of parseTemplateDisplayParts(parts)) {
    const rendered=applyRegexRules(part.text,rules,{scope:'output',timing:'render'},macroCtx).text
    if(part.kind==='html') output.push({...part,text:rendered})
    else output.push(...splitTemplateDisplay(rendered))
  }
  return parseTemplateDisplayParts(output)
}
