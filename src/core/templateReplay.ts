/** 模板运行的持久恢复契约：完整隔离堆检查点加真实操作尾部，保留词法闭包而不单独序列化函数源码。 */
import type { TemplateContext,TemplateScopes,TemplateMessageMetadata } from './template.js'
import type { TemplateReplayBootstrap } from './templateContinuation.js'
import type { TemplateStickyState } from './templateSticky.js'
import type { TemplateCheckpointVmImage } from './templateCheckpoint.js'
import { measureTemplateJson, TEMPLATE_INPUT_MAX_CHARS, TEMPLATE_REPLAY_MAX_CHARS } from './templateBudget.js'
import { templateReplaySharedReader,templateReplayJsonVisits,type TemplateReplayJsonShared } from './templateReplayShared.js'

/** 入参对共享表的引用：整数取整项，二元组取共享文本的前 length 个码元或数组的前 length 项。 */
export type TemplateReplayRef = number | [index:number,length:number]
/** 多次求值共用的只读入参：旧整项继续支持；变化的 JSON 按有序页复用，累积缓冲和历史保留前缀。 */
export type TemplateReplayShared = {value:unknown} | {text:string[]} | {array:unknown[]} | TemplateReplayJsonShared
/** 来源正则的可序列化消息参数；basic 批次没有回调，generate 保持逐来源交错。 */
export interface TemplateReplayRegexMeta {role:string;worldinfo:boolean;depth:number}
export interface TemplateReplayRegexSource {key:string;text:string;start:number}
export interface TemplateReplayRegexSources {parts:TemplateReplayRegexSource[];meta:TemplateReplayRegexMeta}

export type TemplateReplayInstruction =
  | {kind:'render';text:string;data:Record<string,unknown>;source?:string;refs?:Record<string,TemplateReplayRef>}
  | {kind:'regexSources';stage:'basic'|'generate'|'message'|'after';meta:TemplateReplayRegexMeta;namespace:string;data:Record<string,unknown>;refs?:Record<string,TemplateReplayRef>}
  | {kind:'regexSourcesBatch';namespace:string;data:Record<string,unknown>;refs?:Record<string,TemplateReplayRef>}
  | {kind:'regex';text:string;stage:'generate'|'message'|'after';meta:{role:string;worldinfo:boolean;depth:number}}
  | {kind:'variables'}
  | {kind:'outlets';text:string}
  | {kind:'deferOutlets';value:boolean}
  | {kind:'phase';context:TemplateContext;refreshPreload:boolean}
  | {kind:'phaseData';data:Record<string,unknown>;refs?:Record<string,TemplateReplayRef>;refreshPreload:boolean}
  | {kind:'message';metadata:TemplateMessageMetadata|null}
  | {kind:'format';text:string}
  | {kind:'messageVariables'}
  | {kind:'sticky';action:'begin'|'finish'|'restore';state?:TemplateStickyState}

export type TemplateReplayOperation = TemplateReplayInstruction & {hash:string}
export type TemplateReplayDataInstruction = Extract<TemplateReplayInstruction,{data:Record<string,unknown>}>

/** 完整隔离堆覆盖此前操作；上下文元数据继续供归属与消息可见性校验，不能代替堆中的词法环境。 */
export interface TemplateReplayCheckpoint {
  version:1
  runtimeHash:string
  /** 宿主与已保存 VM 的命令/数据协议；缺省为旧检查点，须通过受信运行时登记解析。 */
  runtimeAbi?:string
  image:TemplateCheckpointVmImage
  context:TemplateContext
  outputInputChars:number
  resourceChars:number
}

export interface TemplateReplay {
  version:2
  /** 缺省表示旧 Showdown；可读取备份，但活动日志必须在旧版本完成或回滚，禁止静默迁移闭包。 */
  formatterVersion?:2
  context:TemplateContext
  operations:TemplateReplayOperation[]
  /** 来源及阶段的共享入参只保存一次；缺省表示全部内联，旧日志照常重放。 */
  shared?:TemplateReplayShared[]
  variables:TemplateScopes
  messageVariablesHash:string
  bootstrap?:TemplateReplayBootstrap
  /** 固定运行时的持久检查点；operations/shared 只保存检查点之后的尾部。 */
  checkpoint?:TemplateReplayCheckpoint
}

export const TEMPLATE_REPLAY_LIMIT = TEMPLATE_REPLAY_MAX_CHARS
/** 低于该长度的入参直接内联；引用和占位本身也占字节。 */
export const TEMPLATE_REPLAY_SHARE_MIN = 256
/** 结构共享允许很小的叶节点；物理 JSON 总量仍由重放预算限制。 */
const SHARED_ENTRIES_LIMIT = TEMPLATE_REPLAY_LIMIT / 8
/** 单轮历史与仍存活闭包均占用资源；执行预算由冻结输入决定，不截断活动闭包。 */
export const TEMPLATE_REPLAY_LIMIT_HINT = '冻结历史或仍存活的模板闭包超过安全资源容量，请压缩历史，或从较早楼层回退/创建分支后继续'
export function measureTemplateReplay(value:unknown):number {
  try {return measureTemplateJson(value,TEMPLATE_REPLAY_LIMIT)}
  catch {throw new Error(`模板重放超过安全资源上限：${TEMPLATE_REPLAY_LIMIT_HINT}`)}
}

/**
 * 压缩减少存储字节，不减少重新执行次数。按引用的逻辑入参累计授予恢复预算，
 * 每个共享项只计量一次；前缀使用完整项大小作保守上界，不展开历史或创建重复 JSON。
 */
export function measureTemplateReplayWork(replay:TemplateReplay):number {
  let chars=measureTemplateReplay(replay)
  if(replay.checkpoint) chars=Math.max(chars,replay.checkpoint.resourceChars)
  const shared=replay.shared ?? [],sizes=templateReplaySharedReader(shared).sizes
  for(const operation of replay.operations) {
    if(!('data' in operation) || !operation.refs) continue
    for(const ref of Object.values(operation.refs)) {
      const index=Array.isArray(ref)?ref[0]:ref,item=shared[index]
      if(!item) throw new Error('模板重放共享引用无效')
      const size=sizes[index]!
      chars+=size
      if(chars>=TEMPLATE_INPUT_MAX_CHARS) return TEMPLATE_INPUT_MAX_CHARS
    }
  }
  return chars
}

/** 外显哈希不覆盖闭包中的隐式格式化捕获，旧引擎的活动日志必须先在旧版本完成或回滚。 */
export function assertTemplateReplayFormatter(replay:Pick<TemplateReplay,'formatterVersion'>):void {
  if(replay.formatterVersion===undefined) throw new Error('消息格式化器已更新，旧模板包含未完成重放或跨轮闭包，已拒绝执行和提交；请备份后使用旧版本完成或回滚相关楼层')
  if(replay.formatterVersion!==2) throw new Error('模板消息格式化器版本不兼容，需要完成或回滚旧版本楼层')
}

export function templateReplayGenerationContext(replay:TemplateReplay):TemplateContext {
  return templateReplayLatestContext(replay,'generate')
}
/** 最近任意阶段用于提交态核验；指定 generate 时用于冻结资产与生成归属，不能混用两个含义。 */
export function templateReplayLatestContext(replay:TemplateReplay,phase?:TemplateContext['phase']):TemplateContext {
  let expand:ReturnType<typeof templateReplayData>|undefined
  for(let index=replay.operations.length-1;index>=0;index--) {
    const operation=replay.operations[index]!
    const context=operation.kind==='phase' ? operation.context : operation.kind==='phaseData'
      ? (expand ??= templateReplayData(replay))(operation) as unknown as TemplateContext : undefined
    if(context && (!phase || context.phase===phase)) return context
  }
  return replay.checkpoint && (!phase || replay.checkpoint.context.phase===phase) ? replay.checkpoint.context : replay.context
}

/** 共享表来自存储边界：每项只能是单一形状，文本分段必须是字符串。 */
export function parseTemplateReplayShared(value:unknown):TemplateReplayShared[] {
  if(!Array.isArray(value) || value.length>SHARED_ENTRIES_LIMIT) throw new Error('模板重放共享表无效或超限')
  for(const item of value) {
    if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).length!==1) throw new Error('模板重放共享项损坏')
    if(Object.hasOwn(item,'value')) continue
    if(Object.hasOwn(item,'array') && Array.isArray(item.array)) continue
    if(['jsonArray','jsonObject','jsonArrayPages','jsonObjectPages'].some(key=>Object.hasOwn(item,key))) continue
    if(!Object.hasOwn(item,'text') || !Array.isArray(item.text) || item.text.some((segment:unknown)=>typeof segment!=='string')) throw new Error('模板重放共享文本损坏')
  }
  templateReplaySharedReader(value as TemplateReplayShared[])
  return value as TemplateReplayShared[]
}

/** 直接正则指令不经过 EJS；记录、读取和重放共用来源形状及单消息边界。 */
export function parseTemplateReplayRegexParts(value:unknown,checked?:WeakSet<object>):TemplateReplayRegexSource[] {
  if(!Array.isArray(value) || value.length>4096) throw new Error('正则来源超过 4096 段上限')
  if(checked?.has(value)) return value as TemplateReplayRegexSource[]
  let size=0
  for(const part of value) {
    if(!part || typeof part!=='object' || Array.isArray(part) || typeof part.key!=='string' || part.key.length>4096 || typeof part.text!=='string'
      || !Number.isSafeInteger(part.start) || part.start<0 || Object.keys(part).some(key=>!['key','text','start'].includes(key))) throw new Error('正则来源区间无效')
    size+=part.text.length
  }
  if(size>TEMPLATE_INPUT_MAX_CHARS) throw new Error('正则来源正文超过安全资源容量')
  checked?.add(value)
  return value as TemplateReplayRegexSource[]
}
export function parseTemplateReplayRegexBatch(value:unknown,checked?:WeakSet<object>):TemplateReplayRegexSources[] {
  if(!Array.isArray(value) || value.length>4096) throw new Error('basic 正则消息批次超过 4096 条上限')
  for(const item of value) {
    if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(key=>!['parts','meta'].includes(key))
      || !item.meta || typeof item.meta!=='object' || Array.isArray(item.meta)
      || Object.keys(item.meta).some(key=>!['role','worldinfo','depth'].includes(key))
      || !['user','assistant','system'].includes(item.meta.role) || typeof item.meta.worldinfo!=='boolean' || !Number.isFinite(item.meta.depth)) throw new Error('basic 正则消息批次无效')
    parseTemplateReplayRegexParts(item.parts,checked)
  }
  return value as TemplateReplayRegexSources[]
}

/**
 * 校验全部引用后返回展开函数。占位保留原键顺序，展开结果与记录时传给模板的入参逐字节一致；
 * 展开只在重放时逐条进行，日志本身不保存重复内容。
 */
export function templateReplayData(replay:Pick<TemplateReplay,'operations'|'shared'>):(operation:TemplateReplayDataInstruction)=>Record<string,unknown> {
  const shared=replay.shared ?? []
  const sharedReader=templateReplaySharedReader(shared)
  const lengths=shared.map(item=>'text' in item ? item.text.reduce((total,segment)=>total+segment.length,0) : 'array' in item ? item.array.length : -1)
  const index=(value:unknown):value is number=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<shared.length
  for(const operation of replay.operations) {
    if(!('data' in operation) || operation.refs===undefined) continue
    for(const [key,ref] of Object.entries(operation.refs)) {
      if(!Object.hasOwn(operation.data,key) || operation.data[key]!==null) throw new Error('模板重放引用缺少入参占位')
      if(Array.isArray(ref)) {
        if(ref.length!==2 || !index(ref[0]) || lengths[ref[0]]!<0 || !Number.isSafeInteger(ref[1]) || ref[1]<0 || ref[1]>lengths[ref[0]]!) throw new Error('模板重放前缀引用无效')
      } else if(!index(ref) || lengths[ref]!>=0) throw new Error('模板重放共享引用无效')
    }
  }
  const texts=new Map<number,string>()
  const text=(at:number):string=> {
    let joined=texts.get(at)
    if(joined===undefined) {joined=(shared[at] as {text:string[]}).text.join('');texts.set(at,joined)}
    return joined
  }
  const expand=(operation:TemplateReplayDataInstruction):Record<string,unknown>=> {
    const refs=operation.refs
    if(!refs) return operation.data
    // 所有字段合计后再展开，防止多个合法的小图在同一个调用里共同放大到资源边界之外。
    let chars=measureTemplateJson(operation.data),visits=templateReplayJsonVisits(operation.data)
    for(const ref of Object.values(refs)) {
      const size=Array.isArray(ref)?sharedReader.measure(ref[0],ref[1]):sharedReader.measure(ref)
      chars+=size.chars-4;visits+=size.visits-1
      if(chars>TEMPLATE_INPUT_MAX_CHARS || visits>8*1024*1024) throw new Error('模板重放操作超过展开容量')
    }
    return Object.fromEntries(Object.entries(operation.data).map(([key,value])=> {
      if(!Object.hasOwn(refs,key)) return [key,value]
      const ref=refs[key]!
      if(!Array.isArray(ref)) return [key,sharedReader.expand(ref)]
      const item=shared[ref[0]]!
      return [key,'array' in item ? item.array.slice(0,ref[1]) : text(ref[0]).slice(0,ref[1])]
    }))
  }
  const checkedParts=new WeakSet<object>(),checkedBatches=new WeakSet<object>()
  for(const operation of replay.operations) {
    if(operation.kind!=='regexSources' && operation.kind!=='regexSourcesBatch') continue
    if(operation.namespace.length>4096) throw new Error('正则来源命名空间无效或超限')
    const data=expand(operation),key=operation.kind==='regexSources'?'parts':'items'
    if(Object.keys(data).length!==1 || !Object.hasOwn(data,key)) throw new Error('正则来源重放入参无效')
    if(operation.kind==='regexSources') parseTemplateReplayRegexParts(data.parts,checkedParts)
    else if(!Array.isArray(data.items) || !checkedBatches.has(data.items)) {
      parseTemplateReplayRegexBatch(data.items,checkedParts)
      checkedBatches.add(data.items as object)
    }
  }
  return expand
}
