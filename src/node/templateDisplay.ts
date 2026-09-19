/** 展示模板在隔离 worker 内格式化；Markdown 引擎仅在 QuickJS 中运行，产物以有序片段交给安全 iframe。 */
import {
  parseTemplateDisplayParts,
  sanitizeTemplateDisplayParts,
  splitTemplateDisplay,
  type TemplateDisplayPart,
} from '../core/templateDisplay.js'
import type { WorldInfoEntry, MacroContext, RegexRule } from '../core/types.js'
import { applyRegexRules } from '../core/regex.js'
import { stripOpaqueDisplayMetaParts } from '../core/displaySanitize.js'
import type { TemplateSandbox } from './templateSandbox.js'

export const TEMPLATE_DISPLAY=String.raw`
let messageConverter;
function formatTemplateMessage(value) {
  const text=String(value ?? '');
  if(text.length>1024*1024) throw Error('消息格式化输入超过 1 MiB 上限');
  messageConverter ||= __TavernTemplateLibraries.createMessageFormatter();
  const output=messageConverter(text);
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
  const rawParts:TemplateDisplayPart[]=[]
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
      rawParts.push({kind:'html',text:entry.templateMessageFormatting?sandbox.formatMessage(value):value,...(entry.templateIframe?{title:entry.templateIframe}:{})})
      return
    }
    if(entry?.templateMessageFormatting) {
      rawParts.push({kind:'html',text:sandbox.formatMessage(value)})
      return
    }
    rawParts.push({kind:'markdown',text:value})
  }
  const project=()=>{
    // BEFORE/正文/AFTER 是同一逻辑展示流；先跨来源收起机读块，再做任何 HTML 定位。
    for(const source of stripOpaqueDisplayMetaParts(parseTemplateDisplayParts(rawParts),false,'\n')) {
      if(source.kind==='html') {
        if(source.text) parts.push(source)
        continue
      }
      for(const part of splitTemplateDisplay(source.text,true)) {
      if(part.kind==='html') parts.push(part)
      else if(FRAGMENT_HTML.test(part.text)) parts.push({kind:'html',text:sandbox.formatMessage(part.text)})
      else parts.push(part)
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
  project()
  return {text:sandbox.resolveOutlets(textPieces.join('\n')),parts:sanitizeTemplateDisplayParts(parts)}
}

/** 已提交片段的展示正则仍在 worker 内运行；逐片段保留角色卡框和正文位置。 */
export function presentTemplateDisplay(parts:TemplateDisplayPart[],rules:RegexRule[],macroCtx:MacroContext):TemplateDisplayPart[] {
  const output:TemplateDisplayPart[]=[]
  // 旧缓存或外部输入可能把开闭标签分在不同 part；必须先整体清理，再逐片跑展示正则。
  const rendered=sanitizeTemplateDisplayParts(parts).map(part=>({
    ...part,
    text:applyRegexRules(part.text,rules,{scope:'output',timing:'render'},macroCtx).text,
  }))
  // 展示正则可能在不同既有片段中生成开闭标签；整体清理后才能安全拆分新生成的 HTML。
  for(const part of stripOpaqueDisplayMetaParts(parseTemplateDisplayParts(rendered))) {
    if(part.kind==='html') {
      if(part.text) output.push(part)
    }
    else output.push(...splitTemplateDisplay(part.text))
  }
  return sanitizeTemplateDisplayParts(output)
}
