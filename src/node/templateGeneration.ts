/** 完整模拟序列的 GENERATE 阶段：按消息顺序求值有界来源，冻结首次上下文并把历史注入映射到本轮通道。 */
import { createHash, randomUUID } from 'node:crypto'
import type { AssembleInput, AssembledPrompt, AssembleLogEntry, TemplateSequenceMessage } from '../core/assemble.js'
import { expandMacros, type MacroContext } from '../core/macros.js'
import { parseTemplatePlacement, type TemplatePlacement } from '../core/templatePlacement.js'
import {hasEjs} from '../core/template.js'
import type { ChatMessage, WorldInfoEntry } from '../core/types.js'
import type { TemplateSandbox } from './templateSandbox.js'
import {estimateTokens} from '../core/tokenize.js'
import type {TemplateRegexSource} from './templateRegexSources.js'

type ContentPlacement=Extract<TemplatePlacement,{kind:'content'}>
interface Hook {entry:WorldInfoEntry;placement:ContentPlacement;expression?:RegExp}
interface Source {text:string;key:string;context:MacroContext}
const MAX_CHARS=1024*1024
const checked=(text:string):string=> {
  if(text.length>MAX_CHARS) throw new Error('GENERATE 上下文或输出超过 1 MiB 上限')
  return text
}
const identity=(message:ChatMessage)=>createHash('sha256').update(JSON.stringify(message)).digest('hex')

/** core 保留最后一条历史与稳定通道；隔离模板扩张后仍超预算时明确失败，不能靠占位成本绕过。 */
export function validateTemplateGenerationBudget(assembled:AssembledPrompt,budget:number):void {
  if(assembled.stats.tokensAfter>budget || estimateTokens(assembled.system)>budget) {
    throw new Error('模板展开后的提示词超过可用窗口，请缩减模板或提高上下文容量')
  }
}

/** 正则回调也使用同一轮来源缓存，主动激活重组不得重复执行变量写入。 */
export function createTemplateGeneration(
  sandbox:TemplateSandbox, entries:WorldInfoEntry[], macroCtx:MacroContext, regexCache:Map<string,string>,
):Pick<AssembleInput,'renderTemplate'|'processTemplateSequence'> {
  // U+E000 是 core 宏引擎的冻结开括号，不能复用为来源边界。
  const prefix=`\uF100tavern-source:${randomUUID()}:`, end='\uF101'
  const sources:Source[]=[]
  const hooks:Hook[]=entries.flatMap(entry=> {
    const placement=parseTemplatePlacement(entry.comment)
    if(placement?.kind!=='content') return []
    let expression:RegExp|undefined
    if(placement.mode==='regex') {
      try {expression=new RegExp(placement.regex,'i')} catch {throw new Error(`无效定位正则：${placement.regex}`)}
    }
    return [{entry,placement,expression}]
  }).sort((a,b)=>a.entry.order-b.entry.order || a.entry.key.localeCompare(b.entry.key))
  const transform=(text:string,key:string,meta:{role:string;worldinfo:boolean;depth:number}):string=> {
    // activewi 会给既有来源加内部标记；同来源首次结果冻结，不能因该标记变化重跑回调。
    const cacheKey=JSON.stringify([key,meta])
    if(!regexCache.has(cacheKey)) {
      const before=JSON.stringify(sandbox.activationRequests())
      regexCache.set(cacheKey,sandbox.transformRegex(text,'generate',meta))
      if(JSON.stringify(sandbox.activationRequests())!==before) throw new Error('正则回调不能激活世界书，请在模板正文中调用 activewi')
    }
    return regexCache.get(cacheKey)!
  }
  const replace=(text:string,render:(source:Source,prior:string,index:number)=>string,depth=0,
    literal?:(text:string,prior:string,index:number)=>string):string=> {
    if(depth>16) throw new Error('模板来源嵌套超过 16 层上限')
    let offset=0,output=''
    while(true) {
      const start=text.indexOf(prefix,offset)
      if(start<0) return checked(output+(literal?literal(text.slice(offset),output,offset):text.slice(offset)))
      output=checked(output+(literal?literal(text.slice(offset,start),output,offset):text.slice(offset,start)))
      const finish=text.indexOf(end,start+prefix.length)
      const index=Number(text.slice(start+prefix.length,finish))
      const source=sources[index]
      if(finish<0 || !Number.isSafeInteger(index) || !source) throw new Error('模板来源占位损坏')
      const resolved={...source,text:replace(source.text,render,depth+1)}
      output=checked(output+render(resolved,output,index))
      offset=finish+end.length
    }
  }
  return {
    renderTemplate:(text,key,context)=> {
      if(sources.length>=4096) throw new Error('模板来源超过 4096 条上限')
      // 内部动态标记不属于角色原文，也不能让同一匹配的来源偏移在重组后改变。
      text=text.replace(/^(?:<% \/\* (?:activewi|conditional lore|positioned template|preprocessed) \*\/ %>)+/,'')
      sources.push({text,key,context})
      return `${prefix}${sources.length-1}${end}`
    },
    processTemplateSequence:(sequence:TemplateSequenceMessage[])=> {
      // 这是 ST 模拟序列，不读取或替换 dsh 的实际请求消息；占位还原后的数据不含任何内部标记。
      let generateData=sequence.map(({message})=>({...message,content:replace(message.content,source=>source.text)}))
      checked(JSON.stringify(generateData))
      const originalData=generateData
      const sourceByOrigin=new Map<string,Source>(),sourceOccurrences=new Map<string,number>(),sourceParents=new Map<string,string>()
      const flatten=(text:string,owner:Source|undefined,anchor:string,depth=0):TemplateRegexSource[]=> {
        if(depth>16) throw new Error('模板来源嵌套超过 16 层上限')
        const parts:TemplateRegexSource[]=[]
        let offset=0,rawOffset=0,lastOrigin='start'
        while(true) {
          const start=text.indexOf(prefix,offset),stop=start<0?text.length:start
          const literal=text.slice(offset,stop)
          const finish=start<0?-1:text.indexOf(end,start+prefix.length)
          const source=start<0?undefined:sources[Number(text.slice(start+prefix.length,finish))]
          if(start>=0 && (finish<0 || !source)) throw new Error('模板来源占位损坏')
          const sourceKey=source?createHash('sha256').update(source.key).digest('hex'):''
          const count=sourceOccurrences.get(sourceKey) ?? 0,key=source?`source:${sourceKey}:${count}`:'end'
          if(literal || !text) parts.push({key:owner?anchor:`${anchor}:${lastOrigin}:${key}`,text:literal,start:owner?rawOffset:0})
          rawOffset+=literal.length
          if(!source) return parts
          sourceOccurrences.set(sourceKey,count+1)
          sourceByOrigin.set(key,source)
          if(owner) sourceParents.set(key,anchor)
          const nested=flatten(source.text,source,key,depth+1)
          parts.push(...nested)
          rawOffset+=nested.reduce((length,part)=>length+part.text.length,0)
          offset=finish+end.length
          lastOrigin=key
          if(parts.length>4096) throw new Error('模板来源超过 4096 段上限')
        }
      }
      const rawParts=sequence.map(item=>flatten(item.message.content,undefined,
        `layout:${item.message.role}:${item.worldinfo}`))
      const log:AssembleLogEntry[]=[],turnContext:string[]=[],matched=new Set<Hook>()
      const occurrence=new Map<string,number>()
      let buffer=''
      const renderHook=(hook:Hook,index:number,prior:string,message:ChatMessage|undefined,matchKey:string):string=> {
        matched.add(hook)
        const {entry}=hook
        const data={generateData,generateBuffer:checked(prior),
          world_info:{...entry,key:entry.keys,keysecondary:entry.secondaryKeys,world:entry.sourceRef,disable:!entry.enabled},
          matched_message:message?.content ?? '',matched_message_index:index,matched_message_role:message?.role ?? ''}
        const key=`${entry.key}:generation:${matchKey}`
        const prepared=transform(expandMacros(entry.content,macroCtx),key,{role:message?.role ?? 'system',worldinfo:true,depth:0})
        return checked(expandMacros(sandbox.renderSource(prepared,key,data),macroCtx))
      }
      const runHooks=(selected:Hook[],index:number,prior:string,message:ChatMessage|undefined,matchKey:string):string=> {
        let text=''
        // 同一位置的多个世界书项共享该位置之前的 buffer，与上游 evaluateWIEntities 一致。
        for(const hook of selected) text=checked(text+renderHook(hook,index,prior,message,matchKey))
        return text
      }
      const globals=(at:'before'|'after')=>hooks.filter(h=>h.placement.mode==='global'&&h.placement.at===at)
      const before=runHooks(globals('before'),0,'',generateData[0],'global')
      buffer=before
      // ST basic 在宿主组装时先处理；本地模拟显式执行整包 basic 后关闭该阶段。
      // 快照由沙箱保留，activewi 新增来源仍使用首次 basic 规则，不续期或重复注册。
      sandbox.render('<% __prepareTemplateBasicRegex() %>')
      const basicParts=rawParts.map((parts,index)=> {
        const item=sequence[index]!
        return sandbox.transformRegexSources(parts,'basic',{role:item.message.role,worldinfo:item.worldinfo,depth:item.depth},'basic-message')
      })
      sandbox.render('<% __clearTemplateBasicRegex() %>')
      generateData=generateData.map((message,index)=>({...message,content:basicParts[index]!.map(part=>part.text).join('')}))
      checked(JSON.stringify(generateData))
      for(let index=0;index<sequence.length;index++) {
        const item=sequence[index]!,raw=generateData[index]!
        item.originalContent=originalData[index]!.content
        const hash=identity(raw), count=occurrence.get(hash) ?? 0
        occurrence.set(hash,count+1)
        const matchKey=`match:${hash}:${count}`
        const select=(at:'before'|'after',message:ChatMessage)=>hooks.filter(h=> {
          const p=h.placement
          if(p.at!==at || p.mode==='global') return false
          return p.mode==='index' ? (p.index<0?sequence.length+p.index:p.index)===index : h.expression!.test(message.content)
        })
        const phase=(at:'before'|'after',prior:string,message:ChatMessage)=> {
          let output=''
          for(const hook of select(at,message)) output=checked(output+renderHook(hook,index,prior,message,
            hook.placement.mode==='index'?`index:${hook.placement.index}`:matchKey))
          return output
        }
        const localBefore=phase('before',buffer,raw)
        const meta={role:item.message.role,worldinfo:item.worldinfo,depth:item.depth}
        const activationBefore=JSON.stringify(sandbox.activationRequests())
        const transformed=sandbox.transformRegexSources(basicParts[index]!,'generate',meta,'generate-message')
        if(JSON.stringify(sandbox.activationRequests())!==activationBefore) throw new Error('正则回调不能激活世界书，请在模板正文中调用 activewi')
        // 正则在整条消息上匹配，映射后仍按原来源求值；跨来源删除不会执行被删代码。
        const visited=new Set<string>()
        const directChild=(key:string,parent:string|undefined):string=> {
          while(sourceParents.has(key)&&sourceParents.get(key)!==parent) key=sourceParents.get(key)!
          return key
        }
        const renderParts=(parts:TemplateRegexSource[]):string=> {
          let output=''
          for(let at=0;at<parts.length;) {
            const part=parts[at]!
            const key=directChild(part.key,undefined),group:TemplateRegexSource[]=[]
            while(at<parts.length&&directChild(parts[at]!.key,undefined)===key) group.push(parts[at++]!)
            const source=sourceByOrigin.get(key)
            visited.add(key)
            for(const child of group) visited.add(child.key)
            // outlet 宏带入的是原文；子代码与父代码共同编译，服从父 if/loop 并共享词法变量。
            // 整棵来源冻结首次结果，activewi 重组不能重新执行父模板或其中的子代码。
            const text=checked(group.map(value=>value.text).join(''))
            const result=hasEjs(text)||source&&hasEjs(source.text)
              ? expandMacros(sandbox.renderSource(text,source?.key ?? key,
                {generateData,generateBuffer:checked(buffer+localBefore+output)}),source?.context ?? macroCtx)
              : text
            output=checked(output+result)
          }
          return output
        }
        const rendered=renderParts(transformed)
        // 删除整个来源也要冻结空结果，否则后续 activewi 改变匹配范围时会补执行旧代码。
        for(const part of rawParts[index]!) {
          const source=sourceByOrigin.get(part.key)
          if(source&&hasEjs(source.text)&&!visited.has(part.key)) {
            sandbox.renderSource('',source.key,{generateData,generateBuffer:checked(buffer+localBefore+rendered)})
          }
        }
        if(item.history) item.historyContent=rendered
        const localAfter=phase('after',checked(buffer+localBefore+rendered),{...raw,content:rendered})
        const leading=index===0?before:''
        const output=checked(leading+localBefore+rendered+localAfter)
        item.message.content=/^【世界书·(?:常驻|本轮触发)】\s*$/.test(output)?'':output
        if(item.history && (leading||localBefore||localAfter)) {
          const text=leading+localBefore+localAfter
          turnContext.push(`【模板注入·${item.message.role}·模拟位置 ${index}】\n${text}`)
        }
        buffer=checked(buffer+localBefore+rendered+localAfter)
      }
      const after=runHooks(globals('after'),Math.max(0,sequence.length-1),buffer,
        sequence.at(-1)?.message,'global')
      const last=sequence.at(-1)
      if(last) {
        last.message.content=checked(last.message.content+after)
        if(last.history&&after) turnContext.push(`【模板注入·${last.message.role}·模拟位置 ${sequence.length-1}】\n${after}`)
      } else if(before||after) {
        // 空模拟序列仍允许声明与变量初始化；正文只能进入插件自己的本轮通道。
        turnContext.push(before+after)
      }
      for(const hook of hooks) log.push({kind:'template-placement',detail:matched.has(hook)
        ? `${hook.entry.comment}：按模拟消息顺序执行；历史位置正文映射到 tavern:turn，不改写宿主历史或角色`
        : `${hook.entry.comment}：未找到目标消息，未执行模板`})
      return {turnContext,log}
    },
  }
}
