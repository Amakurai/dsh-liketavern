/** 重放 JSON 的无损结构共享：有序对象与数组分页复用；先核算拓扑、逻辑深度和展开容量，再按需恢复入参。 */
import { measureTemplateJson, TEMPLATE_INPUT_MAX_CHARS } from './templateBudget.js'
import type { TemplateReplayShared } from './templateReplay.js'

export type TemplateReplayJsonShared =
  | {jsonArray:number[]}
  | {jsonObject:Array<[string,number]>}
  | {jsonArrayPages:number[]}
  | {jsonObjectPages:number[]}

export const TEMPLATE_REPLAY_JSON_PAGE = 64
const MAX_VISITS=8*1024*1024
interface Shape {chars:number;visits:number;depth:number;physical:number;count:number;kind:'value'|'array'|'object'|'prefix'}
export function templateReplayJsonVisits(value:unknown,limit=MAX_VISITS):number {
  let visits=0
  const scan=(value:unknown):void=> {
    if(++visits>limit) throw new Error('模板重放操作超过展开容量')
    if(value && typeof value==='object') for(const child of Object.values(value)) scan(child)
  }
  scan(value);return visits
}

/** 内容摘要只用于相等节点去重；节点保留原键序，分页根只复制少量页引用。 */
export class TemplateReplayJsonWriter {
  private readonly nodes=new Map<string,number>()
  private readonly values=new Map<string,number>()
  private readonly objectBoundaries=new Map<string,boolean>()
  private readonly shared:TemplateReplayShared[]
  private readonly digest:(text:string)=>string
  private readonly appended:(chars:number)=>void
  constructor(shared:TemplateReplayShared[],digest:(text:string)=>string,appended:(chars:number)=>void) {
    this.shared=shared;this.digest=digest;this.appended=appended
    shared.forEach((item,index)=> {
      if(!('text' in item) && !('array' in item)) this.nodes.set(digest(JSON.stringify(item)),index)
      if('value' in item) this.values.set(digest(JSON.stringify(item.value)),index)
    })
  }
  private intern(item:{value:unknown}|TemplateReplayJsonShared):number {
    const json=JSON.stringify(item),hash=this.digest(json),known=this.nodes.get(hash)
    if(known!==undefined) return known
    const index=this.shared.push(item)-1
    this.nodes.set(hash,index);this.appended(json.length)
    return index
  }
  private pages(refs:number[],kind:'array'|'object'):number {
    while(refs.length>1) {
      const next:number[]=[]
      for(const page of this.partition(refs,ref=>(ref&15)===0,2)) {
        next.push(page.length===1?page[0]!:this.intern(kind==='array'?{jsonArrayPages:page}:{jsonObjectPages:page}))
      }
      refs=next
    }
    return refs[0]!
  }
  /** 内容决定边界，插入/裁剪后在下一锚点重新对齐；最大页长限制最坏节点大小。 */
  private partition<T>(values:T[],boundary:(value:T)=>boolean,min=1):T[][] {
    const pages:T[][]=[]
    let page:T[]=[]
    for(const value of values) {
      page.push(value)
      if(page.length>=TEMPLATE_REPLAY_JSON_PAGE || page.length>=min && boundary(value)) {pages.push(page);page=[]}
    }
    if(page.length) pages.push(page)
    return pages
  }
  private objectBoundary(key:string):boolean {
    let boundary=this.objectBoundaries.get(key)
    if(boundary===undefined) {boundary=this.digest(key).endsWith('0');this.objectBoundaries.set(key,boundary)}
    return boundary
  }
  write(value:unknown,json=JSON.stringify(value)):number {
    const fingerprint=this.digest(json),known=this.values.get(fingerprint)
    if(known!==undefined) return known
    const stored=this.writeNew(value,json)
    this.values.set(fingerprint,stored)
    return stored
  }
  private writeNew(value:unknown,json:string):number {
    if(json.length<256 || !value || typeof value!=='object') return this.intern({value})
    const refs:number[]=[]
    if(Array.isArray(value)) {
      const children=value.map(child=>this.write(child))
      for(const page of this.partition(children,ref=>(ref&15)===0)) refs.push(this.intern({jsonArray:page}))
      return this.pages(refs,'array')
    }
    const entries=Object.entries(value)
    for(const page of this.partition(entries,([key])=>this.objectBoundary(key))) refs.push(this.intern({jsonObject:page.map(([key,child])=>[key,this.write(child)])}))
    return this.pages(refs,'object')
  }
}

/** 每个节点都必须独立可安全展开；不能用很小的引用图放大成无限对象或绕过输入计量。 */
export function templateReplaySharedReader(shared:TemplateReplayShared[]):{
  sizes:number[];expand:(index:number)=>unknown;measure:(index:number,length?:number)=>{chars:number;visits:number}
} {
  const shapes:Shape[]=[]
  const references=(value:unknown,at:number):number[]=> {
    if(!Array.isArray(value) || value.length>TEMPLATE_REPLAY_JSON_PAGE || value.some(ref=>!Number.isSafeInteger(ref)||ref<0||ref>=at)) throw new Error('模板重放 JSON 引用无效')
    return value as number[]
  }
  const objectEntries=function*(at:number):Generator<[string,number]> {
    const item=shared[at]!
    if('jsonObject' in item) yield* item.jsonObject
    else if('jsonObjectPages' in item) for(const page of item.jsonObjectPages) yield* objectEntries(page)
    else throw new Error('模板重放对象分页形状无效')
  }
  for(let at=0;at<shared.length;at++) {
    const item=shared[at]!
    let shape:Shape
    if('value' in item || 'array' in item || 'text' in item) {
      const value='value' in item?item.value:'array' in item?item.array:item.text
      let depth=0,visits=0
      const scan=(value:unknown,level:number):void=> {
        if(++visits>MAX_VISITS || level>64) throw new Error('模板重放 JSON 结构超过展开容量')
        depth=Math.max(depth,level)
        if(value && typeof value==='object') for(const child of Object.values(value)) scan(child,level+1)
      }
      // 计量先拒绝循环，随后遍历只统计逻辑结构；旧内联共享项同样受保护。
      const chars=measureTemplateJson(value,TEMPLATE_INPUT_MAX_CHARS)
      scan(value,0)
      shape={chars,depth,visits,physical:0,count:0,kind:'value' in item?'value':'prefix'}
    } else {
      let refs:number[],count:number,chars=2,visits=1,depth=0,physical=1,kind:'array'|'object'
      const pages='jsonArrayPages' in item || 'jsonObjectPages' in item
      if('jsonObject' in item) {
        if(!Array.isArray(item.jsonObject) || item.jsonObject.length>TEMPLATE_REPLAY_JSON_PAGE) throw new Error('模板重放对象节点无效')
        const keys=new Set<string>()
        refs=item.jsonObject.map(entry=> {
          if(!Array.isArray(entry) || entry.length!==2 || typeof entry[0]!=='string' || keys.has(entry[0])
            || ['__proto__','constructor','prototype'].includes(entry[0])) throw new Error('模板重放对象键无效或重复')
          keys.add(entry[0]);chars+=JSON.stringify(entry[0]).length+1
          return entry[1]
        })
        references(refs,at);kind='object';count=refs.length
      } else if('jsonArray' in item) {refs=references(item.jsonArray,at);kind='array';count=refs.length}
      else {
        kind='jsonArrayPages' in item?'array':'object'
        refs=references('jsonArrayPages' in item?item.jsonArrayPages:item.jsonObjectPages,at)
        if(refs.length<2) throw new Error('模板重放分页节点无效')
        count=0
      }
      for(const ref of refs) {
        const child=shapes[ref]!
        if(child.kind==='prefix' || pages && (child.kind!==kind || child.count===0)) throw new Error('模板重放 JSON 子节点形状无效')
        chars+=child.chars-(pages?2:0)
        visits+=child.visits-(pages?1:0)
        depth=Math.max(depth,child.depth+(pages?0:1))
        physical=Math.max(physical,child.physical+1)
        if(pages) count+=child.count
      }
      chars+=Math.max(0,refs.length-1)
      shape={chars,visits,depth,physical,count,kind}
      if(chars>TEMPLATE_INPUT_MAX_CHARS || visits>MAX_VISITS || depth>64 || physical>128) throw new Error('模板重放 JSON 引用超过展开容量')
      if(pages && kind==='object') {
        const keys=new Set<string>()
        for(const [key] of objectEntries(at)) {
          if(keys.has(key)) throw new Error('模板重放对象分页含重复键')
          keys.add(key)
        }
      }
    }
    shapes.push(shape)
  }
  const expand=(index:number):unknown=> {
    const item=shared[index]!
    if('value' in item) return item.value
    if('jsonArray' in item) return item.jsonArray.map(expand)
    if('jsonArrayPages' in item) {
      const result:unknown[]=[]
      for(const page of item.jsonArrayPages) for(const value of expand(page) as unknown[]) result.push(value)
      return result
    }
    if('jsonObject' in item || 'jsonObjectPages' in item) return Object.fromEntries([...objectEntries(index)].map(([key,ref])=>[key,expand(ref)]))
    throw new Error('模板重放整项引用指向前缀')
  }
  const arrayMeasures=new Map<number,{chars:number[];visits:number[]}>()
  const measure=(index:number,length?:number):{chars:number;visits:number}=> {
    if(length===undefined) return shapes[index]!
    const item=shared[index]!
    if('array' in item) {
      let prefixes=arrayMeasures.get(index)
      if(!prefixes) {
        prefixes={chars:[2],visits:[1]}
        for(const value of item.array) {
          prefixes.chars.push(prefixes.chars.at(-1)!+measureTemplateJson(value)+(prefixes.chars.length>1?1:0))
          prefixes.visits.push(prefixes.visits.at(-1)!+templateReplayJsonVisits(value))
        }
        arrayMeasures.set(index,prefixes)
      }
      return {chars:prefixes.chars[length]!,visits:prefixes.visits[length]!}
    }
    if('text' in item) {
      let chars=2,remaining=length
      for(const segment of item.text) {
        if(!remaining) break
        const take=Math.min(remaining,segment.length)
        chars+=measureTemplateJson(take===segment.length?segment:segment.slice(0,take))-2
        remaining-=take
      }
      return {chars,visits:1}
    }
    throw new Error('模板重放前缀形状无效')
  }
  return {sizes:shapes.map(shape=>shape.chars),expand,measure}
}
