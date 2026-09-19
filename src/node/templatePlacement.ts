/** worker 内定位注入：模拟序列与结构化布局保留 role/位置，两段兼容通道另保存本轮正文。 */
import { parseTemplatePlacement, type TemplatePlacement } from '../core/templatePlacement.js'
import type { AssembledPrompt } from '../core/assemble.js'
import type { ChatMessage, MacroContext, WorldInfoEntry } from '../core/types.js'
import { expandMacros } from '../core/macros.js'
import { estimateTokens } from '../core/tokenize.js'
import type { TemplateSandbox } from './templateSandbox.js'
import { createHash } from 'node:crypto'
import type { PromptLayoutEntry, PromptLayoutPlacement, PromptMessageProvenance } from '../core/promptLayout.js'

interface LocatedEntry {entry:WorldInfoEntry;placement:TemplatePlacement;order:number}
interface Insertion {at:number;item:LocatedEntry;text:string;entryKey?:string}

export function applyTemplatePlacements(
  assembled:AssembledPrompt, entries:WorldInfoEntry[], sandbox:TemplateSandbox,
  macroCtx:MacroContext, budget:number,
):AssembledPrompt {
  const located:LocatedEntry[]=entries.flatMap(entry=> {
    const placement=parseTemplatePlacement(entry.comment)
    return placement ? [{entry,placement,order:placement.kind==='insert' ? placement.order ?? entry.order : entry.order}] : []
  }).sort((a,b)=>a.order-b.order || a.entry.key.localeCompare(b.entry.key))
  if(!located.length) return assembled
  if(!assembled.messageProvenance || !assembled.layout) throw new Error('定位注入缺少模拟消息来源索引')
  let messages=assembled.messages.map(message=>({...message}))
  let provenance=assembled.messageProvenance.map(origin=>({...origin}))
  const layout={...assembled.layout,entries:assembled.layout.entries.map(entry=>({...entry,sourceKeys:[...entry.sourceKeys]}))}
  let insertionId=0
  const boundary=(origin:PromptMessageProvenance|undefined,side:'before'|'after'):PromptLayoutPlacement=> {
    if(origin?.kind==='layout') return {kind:'entry-relative',entryKey:origin.entryKey,side}
    if(origin?.kind==='history') {
      // GENERATE 的前后片段属于同一条模拟消息，INSERT 必须落在整条消息的外侧。
      const hooks=layout.entries.filter(entry=>entry.placement.kind==='history-relative'
        && entry.placement.anchor.inputIndex===origin.anchor.inputIndex && entry.placement.side===side)
      const outer=side==='before'?hooks[0]:hooks.at(-1)
      return outer ? {kind:'entry-relative',entryKey:outer.key,side} : {kind:'history-relative',anchor:{...origin.anchor},side}
    }
    const anchor=[...layout.history].reverse().find(item=>item.chat)
    return {kind:'after-history',...(anchor?{anchor:{...anchor}}:{})}
  }
  const addLayout=(item:LocatedEntry,text:string,at:number,side:'before'|'after'='before'):string=> {
    const origin=provenance[at] ?? provenance.at(-1)
    const placement=boundary(origin,at>=provenance.length?'after':side)
    const key=`template-insert:${insertionId++}`
    const role=item.placement.kind==='insert'?item.placement.role:messages[at]?.role ?? 'system'
    const entry:PromptLayoutEntry={key,role,content:text,sourceKeys:[item.entry.key],turnLocal:true,placement}
    if(placement.kind==='entry-relative') {
      let index=layout.entries.findIndex(value=>value.key===placement.entryKey)
      if(index<0) throw new Error('定位注入的布局来源不存在')
      if(placement.side==='after') {
        let sibling=-1
        layout.entries.forEach((value,at)=>{if(value.placement.kind==='entry-relative'
          && value.placement.entryKey===placement.entryKey && value.placement.side==='after') sibling=at})
        if(sibling>=0) index=sibling
      }
      layout.entries.splice(index+(placement.side==='after'?1:0),0,entry)
    } else layout.entries.push(entry)
    return key
  }
  const live:string[]=[], log=[...assembled.log]
  let outputChars=0
  const render=(item:LocatedEntry,index:number,matched?:ChatMessage,sourceSuffix='')=> {
    const entry=item.entry
    const worldInfo={...entry,key:entry.keys,keysecondary:entry.secondaryKeys,world:entry.sourceRef,disable:!entry.enabled}
    const data={world_info:worldInfo,matched_message:matched?.content ?? '',matched_message_index:index,matched_message_role:matched?.role ?? ''}
    const role=item.placement.kind==='insert'?item.placement.role:matched?.role ?? 'system'
    const source=`${entry.key}:placement${sourceSuffix}`
    // 注入与普通生成正文一样先执行 generate 正则，再编译其结果；同轮重组复用来源匹配缓存。
    const raw=expandMacros(entry.content,macroCtx).replace(/^(?:<% \/\* (?:activewi|conditional lore|positioned template|preprocessed) \*\/ %>)+/,'')
    const activationBefore=JSON.stringify(sandbox.activationRequests())
    const prepared=sandbox.transformRegexSources([{key:source,text:raw,start:0}],'generate',
      {role,worldinfo:true,depth:0},'generate-placement').map(part=>part.text).join('')
    if(JSON.stringify(sandbox.activationRequests())!==activationBefore) throw new Error('正则回调不能激活世界书，请在模板正文中调用 activewi')
    const result=expandMacros(sandbox.renderSource(prepared,source,data),macroCtx)
    outputChars+=result.length
    if(outputChars>1024*1024) throw new Error('定位注入输出超过 1 MiB 上限')
    return result
  }
  const record=(item:LocatedEntry,index:number,text:string)=> {
    if(!text.trim()) return
    const role=item.placement.kind==='insert' ? item.placement.role : messages[index]?.role ?? 'system'
    live.push(`【模板注入·${role}·模拟位置 ${index}】\n${text}`)
    log.push({kind:'template-placement',detail:`${item.entry.comment}：模拟位置 ${index} 已保存到冻结布局；其它通道映射到 tavern:turn，原宿主历史正文不变`})
  }
  const missing=(item:LocatedEntry)=>log.push({kind:'template-placement',detail:`${item.entry.comment}：未找到目标消息，未执行模板`})
  const regexp=(pattern:string,flags='')=> {
    try {return new RegExp(pattern,flags)} catch {throw new Error(`无效定位正则：${pattern}`)}
  }
  for(const item of located.filter(i=>i.placement.kind==='content')) {
    const placement=item.placement
    if(placement.kind!=='content' || placement.mode==='global') continue
    const expression=placement.mode==='regex' ? regexp(placement.regex,'i') : null
    const targets=placement.mode==='index'
      ? [placement.index<0 ? messages.length+placement.index : placement.index].filter(i=>i>=0&&i<messages.length)
      : messages.flatMap((m,i)=>expression!.test(m.content)?[i]:[])
    if(!targets.length) {missing(item);continue}
    const occurrences=new Map<string,number>()
    for(const index of targets) {
      const message=messages[index]!
      // 主动激活可能在历史前新增消息；同一正文移动后仍重放首次结果，重复正文按出现次数区分。
      const identity=createHash('sha256').update(JSON.stringify(message)).digest('hex')
      const occurrence=occurrences.get(identity) ?? 0
      occurrences.set(identity,occurrence+1)
      const source=placement.mode==='index' ? `index:${placement.index}` : `match:${identity}:${occurrence}`
      const text=render(item,index,message,`:${source}`)
      record(item,index,text)
      if(text.trim()) {
        const origin=provenance[index]
        if(origin?.kind==='layout') {
          const entry=layout.entries.find(value=>value.key===origin.entryKey)
          if(!entry) throw new Error('定位注入的布局来源不存在')
          entry.content=placement.at==='before'?[text,entry.content].filter(Boolean).join('\n'):[entry.content,text].filter(Boolean).join('\n')
          entry.turnLocal=true
          entry.sourceKeys.push(item.entry.key)
        } else addLayout(item,text,index,placement.at)
      }
      message.content=placement.at==='before' ? [text,message.content].filter(Boolean).join('\n') : [message.content,text].filter(Boolean).join('\n')
    }
  }
  const apply=(queue:Insertion[])=> {
    const groups=new Map<number,Insertion[]>()
    for(const insertion of queue) {
      const group=groups.get(insertion.at) ?? []
      group.push(insertion)
      groups.set(insertion.at,group)
    }
    for(const insertion of queue) insertion.entryKey=addLayout(insertion.item,insertion.text,insertion.at)
    provenance=Array.from({length:messages.length+1},(_,index)=>[
      ...(groups.get(index) ?? []).map(insertion=>({kind:'layout' as const,entryKey:insertion.entryKey!})),
      ...(provenance[index]?[provenance[index]!]:[]),
    ]).flat()
    messages=Array.from({length:messages.length+1},(_,index)=>[
      ...(groups.get(index) ?? []).map(({item,text})=>({role:item.placement.kind==='insert'?item.placement.role:'system',content:text} as ChatMessage)),
      ...(messages[index]?[messages[index]!]:[]),
    ]).flat()
  }
  const positions:Insertion[]=[]
  for(const item of located) {
    const p=item.placement
    if(p.kind!=='insert'||p.mode==='regex') continue
    let at:number
    if(p.mode==='pos') at=Math.min(messages.length,Math.max(0,p.pos<0?messages.length+p.pos:Math.max(0,p.pos-1)))
    else {
      const targets=messages.flatMap((m,i)=>m.role===p.target?[i]:[])
      const target=targets[p.index<0?targets.length+p.index:Math.max(0,p.index-1)]
      if(target===undefined) {missing(item);continue}
      at=target+(p.at==='after'?1:0)
    }
    const text=render(item,at,messages[Math.min(at,messages.length-1)])
    if(text.trim()) {positions.push({at,item,text});record(item,at,text)}
  }
  apply(positions)
  const regexes:Insertion[]=[]
  for(const item of located) {
    const p=item.placement
    if(p.kind!=='insert'||p.mode!=='regex') continue
    const expression=regexp(p.regex)
    const match=messages.findIndex(message=>expression.test(message.content))
    if(match<0) {missing(item);continue}
    const at=match+(p.at==='after'?1:0)
    const text=render(item,match,messages[match])
    if(text.trim()) {regexes.push({at,item,text});record(item,at,text)}
  }
  apply(regexes)
  const tokensAfter=messages.reduce((total,m)=>total+estimateTokens(m.content),0)
  if(tokensAfter>budget) throw new Error('定位注入后的模拟提示词超过可用窗口，请缩减注入或提高上下文容量')
  const turnContext=[assembled.turnContext,...live].filter(Boolean).join('\n\n')
  return {...assembled,messages,messageProvenance:provenance,layout,turnContext,system:[assembled.standing,turnContext].filter(Boolean).join('\n\n'),log,
    stats:{...assembled.stats,tokensAfter}}
}
