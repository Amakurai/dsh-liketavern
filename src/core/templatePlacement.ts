/** 提示词定位语法解析；仅解析字符串参数，正则匹配和模板求值留在可终止 worker 内。 */
import type { ChatRole } from './types.js'

export type TemplatePlacement =
  | {kind:'insert';role:ChatRole;order?:number;mode:'pos';pos:number}
  | {kind:'insert';role:ChatRole;order?:number;mode:'target';target:ChatRole;index:number;at:'before'|'after'}
  | {kind:'insert';role:ChatRole;order?:number;mode:'regex';regex:string;at:'before'|'after'}
  | {kind:'content';mode:'index';index:number;at:'before'|'after'}
  | {kind:'content';mode:'regex';regex:string;at:'before'|'after'}
  | {kind:'content';mode:'global';at:'before'|'after'}

const role = (value:string):ChatRole=> {
  if (!['system','user','assistant'].includes(value)) throw new Error(`无效注入角色：${value}`)
  return value as ChatRole
}
function integer(value:string):number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`无效注入下标：${value}`)
  return Number(value)
}
function parameters(text:string):Map<string,string> {
  text=text.trim()
  if (text.startsWith('[') && text.endsWith(']')) text=text.slice(1,-1)
  const result=new Map<string,string>()
  let at=0
  while(at<text.length) {
    while(/[\s,]/.test(text[at] ?? '') && at<text.length) at++
    if(at===text.length) break
    const key=/^[a-zA-Z]+\s*=\s*/.exec(text.slice(at))
    if(!key) throw new Error('无效 @INJECT 参数格式')
    const name=key[0].split('=')[0]!.trim().toLowerCase()
    at+=key[0].length
    let value=''
    const quote=text[at]
    if(quote==='"'||quote==="'") {
      at++; let closed=false
      while(at<text.length) {
        const char=text[at++]!
        if(char===quote) {closed=true;break}
        if(char==='\\' && text[at]===quote) value+=text[at++]
        else value+=char
      }
      if(!closed) throw new Error('@INJECT 引号未闭合')
    } else {
      // 只有逗号或空格之后的 key= 才分隔，保留正则量词 {1,3} 与字符类。
      const rest=text.slice(at)
      const boundary=/[,\s]+(?=[a-zA-Z]+\s*=)/.exec(rest)
      const length=boundary?.index ?? rest.length
      value=rest.slice(0,length).trim().replace(/,$/,'');at+=length
    }
    if(result.has(name)||!value) throw new Error(`重复或空注入参数：${name}`)
    result.set(name,value)
  }
  return result
}

export function parseTemplatePlacement(label:string):TemplatePlacement|null {
  const global=/^\[GENERATE:(BEFORE|AFTER)\]/i.exec(label)
  if(global) return {kind:'content',mode:'global',at:global[1]!.toLowerCase() as 'before'|'after'}
  const indexed=/^\[GENERATE:(-?\d+):(BEFORE|AFTER)\]/i.exec(label)
  if(indexed) return {kind:'content',mode:'index',index:integer(indexed[1]!),at:indexed[2]!.toLowerCase() as 'before'|'after'}
  const regexHeader=/^\[GENERATE:(?:(BEFORE|AFTER):)?REGEX:/i.exec(label)
  if(regexHeader) {
    const end=label.lastIndexOf(']')
    if(end<=regexHeader[0].length) throw new Error('GENERATE:REGEX 缺少模式或闭合方括号')
    return {kind:'content',mode:'regex',regex:label.slice(regexHeader[0].length,end),at:regexHeader[1]?.toLowerCase()==='after'?'after':'before'}
  }
  if(!/^@INJECT\b/i.test(label)) return null
  const values=parameters(label.replace(/^@INJECT\b/i,''))
  for(const key of values.keys()) if(!['pos','target','index','at','role','regex','order'].includes(key)) throw new Error(`未知注入参数：${key}`)
  const modes=['pos','target','regex'].filter(key=>values.has(key))
  if(modes.length!==1) throw new Error('@INJECT 必须指定且只指定 pos、target 或 regex')
  const common={kind:'insert' as const,role:role(values.get('role') ?? 'system'),order:values.has('order')?integer(values.get('order')!):undefined}
  const at=values.get('at') ?? 'before'
  if(at!=='before'&&at!=='after') throw new Error('注入 at 必须是 before 或 after')
  if(modes[0]==='pos') {
    if(values.has('at')||values.has('index')) throw new Error('pos 模式不接受 at/index')
    return {...common,mode:'pos',pos:integer(values.get('pos')!)}
  }
  if(modes[0]==='target') return {...common,mode:'target',target:role(values.get('target')!),index:integer(values.get('index') ?? '1'),at}
  if(values.has('index')) throw new Error('regex 模式不接受 index')
  return {...common,mode:'regex',regex:values.get('regex')!,at}
}
