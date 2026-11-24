/** EJS 在 QuickJS/WASM 中执行；不向脚本提供 Node、网络、DOM、宿主函数或模块加载器。 */
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten'
import { parseDocument } from 'yaml'
import { createHash } from 'node:crypto'
import { parseTemplateHelperMvu } from '../core/templateHelperMvu.js'
import { measureTemplateJson, templateExecutionBudget, TEMPLATE_INPUT_MAX_CHARS, TEMPLATE_OUTPUT_MAX_CHARS } from '../core/templateBudget.js'
import { TemplateReplayArrayPrefixes } from '../core/templateReplayArrays.js'
import { TemplateReplayJsonWriter } from '../core/templateReplayShared.js'
import { prepareTemplateCheckpointVm,createTemplateCheckpointVm,dumpTemplateCheckpointVm } from './templateCheckpointVm.js'
import { BOOTSTRAP } from './templateBootstrap.js'
import { loadTemplateRuntime } from './templateRuntime.js'
import { resolveTemplateRuntimeIdentity,TEMPLATE_RUNTIME_ABI,type TemplateRuntimeIdentity } from '../core/templateRuntimeAbi.js'
import type { TemplateReplayBootstrap } from '../core/templateContinuation.js'
import { hasTemplateStickyClosures, parseTemplateStickyState, type TemplateStickyState } from '../core/templateSticky.js'
import type { TemplateRegexSource } from './templateRegexSources.js'
import { parseTemplateMessageIdentities, parseTemplateMessageVariables, type TemplateMessageVariables } from '../core/templateMessageVariables.js'
import { assertTemplateReplayFormatter, measureTemplateReplay, measureTemplateReplayWork, templateReplayData, parseTemplateReplayRegexParts, parseTemplateReplayRegexBatch, TEMPLATE_REPLAY_LIMIT, TEMPLATE_REPLAY_LIMIT_HINT, TEMPLATE_REPLAY_SHARE_MIN,
  type TemplateReplay, type TemplateReplayCheckpoint, type TemplateReplayOperation, type TemplateReplayInstruction, type TemplateReplayRef, type TemplateReplayShared,
  type TemplateReplayDataInstruction, type TemplateReplayRegexSources } from '../core/templateReplay.js'
import { normalizeTemplateLore } from '../core/templateLore.js'
import { parseTemplateScopes, validateTemplateJson, type TemplateContext, type TemplateScopes, type TemplateRegexDescriptor, type TemplateMessageMetadata } from '../core/template.js'

/** 只增文本按固定长度分段；同一段历史在后续轮次得到相同分段，存储层可以复用旧块。 */
const SHARED_TEXT_SEGMENT = 16 * 1024
function sharedTextSegments(text:string):string[] {
  const segments:string[]=[]
  for(let at=0;at<text.length;) {
    let end=Math.min(text.length,at+SHARED_TEXT_SEGMENT)
    // 不把代理对拆到两段；原文里本来孤立的代理项照常保存。
    if(end<text.length && (text.charCodeAt(end-1)&0xfc00)===0xd800 && (text.charCodeAt(end)&0xfc00)===0xdc00) end--
    segments.push(text.slice(at,end))
    at=end
  }
  return segments
}

/** 一次 FFI 调用最多执行的微任务数；期限仍由批间检查与中断处理器共同保证。 */
const PENDING_JOB_BATCH = 256

let templateLibrarySource: string | undefined
let templateBootstrapSource: string | undefined
let templateFakerSource: string | undefined
let templateFakerData: string | undefined
let templateRuntimeHash: string | undefined

const FAKER_DATA_MARKER = '\n/* __TAVERN_FAKER_DATA__\n'
const FAKER_DATA_TRAILER = '\n*/\n'
function splitTemplateFakerVendor(source: string): { coreSource: string; dataJson: string } {
  const normalized = source.replaceAll('\r\n', '\n')
  const markerAt = normalized.indexOf(FAKER_DATA_MARKER)
  if (markerAt < 0 || !normalized.endsWith(FAKER_DATA_TRAILER)) {
    throw new Error('Faker 模板依赖产物缺失，请先运行 npm run build')
  }
  return {
    coreSource: normalized.slice(0, markerAt),
    dataJson: normalized.slice(markerAt + FAKER_DATA_MARKER.length, -FAKER_DATA_TRAILER.length),
  }
}

/** 单次递归清理 undefined 字段并深拷贝普通 JSON，避免对数兆检查点与共享段做 JSON.stringify + JSON.parse。 */
function cleanPlainJson<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? (value === 0 ? 0 : value) : null) as T
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length)
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      out[i] = item === undefined ? null : cleanPlainJson(item)
    }
    return out as T
  }
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const keys = Object.keys(src)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!
    const v = src[k]
    if (v !== undefined) out[k] = cleanPlainJson(v)
  }
  return out as T
}
/** 仅供 worker 编排计时，不暴露给 QuickJS 脚本。 */
let computationPhase: ((phase: 'loading' | 'computing') => void) | undefined

/** 安全提取 QuickJS 对象/Error 异常文本，绝不调用 JSON.stringify 或 toJSON（避免触发 QTS_Dump 递归溢出泄漏 C 句柄或被原型 toJSON 劫持）。 */
const ERROR_FORMATTER = `(error)=>{
try{
if(error===null)return 'null';
const t=typeof error;
if(t!=='object'&&t!=='function')return ''+error;
let name='',message='';
try{if(typeof error.name==='string')name=error.name}catch{}
try{if(typeof error.message==='string')message=error.message}catch{}
if(name||message)return name&&message?name+': '+message:(message||name);
try{const text=''+error;if(text)return text}catch{}
return '[object Object]';
}catch{return '[Unformattable Error]'}
}`

/**
 * 渲染包装：完成状态、入参与结果均留在词法闭包内，不经可写 globalThis 中转；
 * 宿主经 callFunction 传入字符串句柄并直接持有返回句柄，模板无法通过重定义全局劫持入参或伪造结果。
 * 拒绝值即使为空串也保留可读原因，不能退化成“输出无效”。
 */
const RENDER_WRAPPER = `(__tavernRawInput)=>{
const state={done:false,error:null,result:null};
const call=parseTemplateInput(__tavernRawInput);
(async()=>{
try{state.result=await __render(call.text,__sourceData(call.source,call.data))}
catch(error){let message='';try{message=String(error)}catch{try{message=error&&typeof error==='object'&&'message' in error?String(error.message):Object.prototype.toString.call(error)}catch{message=''}}state.error=message||'EJS 模板以空值拒绝'}
finally{state.done=true}
})();
return state;
}`
/**
 * @@if 条件包装：新堆经 __evalTemplateCondition 按纯 JS 表达式求值（避免 %> 或 // 触发 EJS 语法错误并启用只读守卫）；
 * 旧检查点堆未内置该入口时保留换行包裹的 __render 兼容回退。
 */
const CONDITION_WRAPPER = `(__tavernRawInput)=>{
const state={done:false,error:null,result:null};
const call=parseTemplateInput(__tavernRawInput);
(async()=>{
try{state.result=typeof __evalTemplateCondition==='function'
  ? await __evalTemplateCondition(call.expression)
  : await __render('<%- Boolean(\\n'+call.expression+'\\n) %>',{})}
catch(error){let message='';try{message=String(error)}catch{try{message=error&&typeof error==='object'&&'message' in error?String(error.message):Object.prototype.toString.call(error)}catch{message=''}}state.error=message||'EJS 模板以空值拒绝'}
finally{state.done=true}
})();
return state;
}`
/**
 * 宿主命令入口的不可写化清单：这些全局只在 bootstrap 里赋值一次，冻结后模板无法用同名全局
 * 替换命令实现来伪造状态或结果。__resetTemplateFaker 在新堆由 templateFaker 自行只读定义，
 * 不在此列以兼容尚未惰性加载 Faker 的旧检查点堆。
 */
const PROTOCOL_ENTRIES = ['__conditionState','__evalTemplateCondition','__export','__exportMessageVariables','__exportTemplateStickyState','__restoreTemplateStickyState',
  '__render','__setTemplateMessageContext','__refreshTemplateContext','__resolveTemplateOutlets','__setTemplateOutletsDeferred',
  '__applyTemporaryRegex','__applyTemporaryRegexSources','__runTemporaryRegexSources','__runBasicRegexSourcesBatch','__regexDescriptors','__hasMessageRegex',
  '__templateRegexRuleCount','__templateRegexStageSize','__prepareTemplateBasicRegex','__clearTemplateBasicRegex','__activationRequests','__formatTemplateMessage',
  '__continueTemplateGeneration','__resumeTemplateReply','__beginTemplateGeneration','__finishTemplateGeneration','__hasLiveTemplateClosures',
  '__deactivateTemplateRegex','__deactivateTemplatePromptInjection','__sourceData','__bindTemplateDefinitions','__setPreparing'] as const
const HARDEN_PROTOCOL = `(()=>{for(const name of ${JSON.stringify(PROTOCOL_ENTRIES)}){try{
const value=globalThis[name];if(typeof value!=='function')continue;
Object.defineProperty(globalThis,name,{value,writable:false,configurable:false})}catch{}}return undefined})()`
/**
 * @@if 状态的单趟纯语法快照：每次新求值，只用 typeof、属性读取、for-in 与局部函数，
 * 不调用任何全局或原型方法（含 Object/JSON/Array/toJSON），并直接输出规范化字符串，
 * 避免“先检 toJSON 再 vm.dump 二次读取”的 TOCTOU 绕过。返回字符串表示快照，
 * 返回数字 1 过大、2 含自定义 toJSON、3 不可序列化或存在循环引用。
 */
const CONDITION_STATE_SNAPSHOT = `(state)=>{let nodes=200000;const seen=[];
const esc=(s)=>{let out='"';for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'||c==='\\\\')out+='\\\\'+c;else if(c==='\\n')out+='\\\\n';else if(c==='\\r')out+='\\\\r';else if(c==='\\t')out+='\\\\t';else out+=c}return out+'"'};
const visit=(value,depth)=>{
if(value===null)return 'null';
const t=typeof value;
if(t==='boolean')return value?'true':'false';
if(t==='number')return value===value&&value!==1/0&&value!==-1/0?(value===0?'0':''+value):3;
if(t==='string')return esc(value);
if(t!=='object')return 3;
if(--nodes<0||depth>256)return 1;
for(let i=0;i<seen.length;i++)if(seen[i]===value)return 3;
if(typeof value.toJSON==='function')return 2;
seen[seen.length]=value;
let out=typeof value.length==='number'?'L'+value.length+'{':'{';
let first=true;
for(const key in value){
const entry=visit(value[key],depth+1);
if(typeof entry!=='string'){seen.length--;return entry}
if(!first)out+=',';
first=false;
out+=esc(key)+':'+entry;
if(out.length>16*1024*1024){seen.length--;return 1}
}
seen.length--;
return out+'}'};
return visit(state,0)}`

export class TemplateSandbox {
  private static readonly PREPARE_BASIC_REGEX_OP = '<% __prepareTemplateBasicRegex() %>'
  private static readonly CLEAR_BASIC_REGEX_OP = '<% __clearTemplateBasicRegex() %>'
  private static readonly CONDITION_SOURCE = '__tavern:condition'
  private readonly renderedSources = new Map<string, string>()
  private readonly vm: QuickJSContext
  private readonly owner:Awaited<ReturnType<typeof createTemplateCheckpointVm>>
  private readonly runtimeIdentity:TemplateRuntimeIdentity
  private deadline: number
  /** 本次渲染中宿主是否实际要求 QuickJS 中断；错误文字可能在中断后的清理期间变化。 */
  private deadlineInterrupted=false
  private resourceChars: number
  private outputInputChars:number
  private computationStarted=0
  private initialContext!:TemplateContext
  private generationContext!:TemplateContext
  private currentContext!:TemplateContext
  private checkpoint?:TemplateReplayCheckpoint
  private checkpointEligible=false
  private bootstrap?:TemplateReplayBootstrap
  private recording=false
  private operations:TemplateReplayOperation[]=[]
  private operationChars=0
  private shared:TemplateReplayShared[]=[]
  private sharedJson?:TemplateReplayJsonWriter
  /** 入参键 → 当前只增文本；累积缓冲每次只追加新增后缀。 */
  private readonly sharedTexts=new Map<string,{index:number;text:string}>()
  private readonly sharedArrays=new TemplateReplayArrayPrefixes(value=>this.hash(value))
  private readonly prefixArrayKeys=new Set<string>()
  private readonly structuredArrayKeys=new Set<string>()
  /** 阶段 → 是否完全没有临时正则；任何非只读求值都会清空。 */
  private readonly regexStageEmpty=new Map<string,boolean>()
  /** 每次可能运行 VM 代码的求值都会递增；@@if 末态快照仅在其后没有任何求值时作为下一条条件的起点。 */
  private vmEpoch=0
  private conditionSnapshot?:{epoch:number;state:string}
  private constructor(owner:Awaited<ReturnType<typeof createTemplateCheckpointVm>>, deadline: number, resourceChars:number,outputInputChars:number,runtimeIdentity:TemplateRuntimeIdentity) {
    this.owner=owner;this.vm = owner.vm;this.deadline=deadline;this.resourceChars=resourceChars;this.outputInputChars=outputInputChars
    this.runtimeIdentity=runtimeIdentity
  }
  /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
  static async prepare(onPhase?: (phase: 'loading' | 'computing') => void): Promise<void> {
    computationPhase = onPhase
    const [,runtime]=await Promise.all([prepareTemplateCheckpointVm(),loadTemplateRuntime()])
    if (templateLibrarySource !== runtime.librarySource || templateFakerSource !== runtime.fakerSource || !templateBootstrapSource || !templateFakerData) {
      const { coreSource, dataJson } = splitTemplateFakerVendor(runtime.fakerSource)
      templateFakerData = dataJson
      templateBootstrapSource = BOOTSTRAP.replace('/* TEMPLATE_VENDOR */', () => `${runtime.librarySource}\n${coreSource}`)
    }
    templateLibrarySource=runtime.librarySource;templateFakerSource=runtime.fakerSource;templateRuntimeHash=runtime.hash
  }

  private static normalizeContext(input:TemplateContext):TemplateContext {
    if(input.historyIdentities) parseTemplateMessageIdentities(input.historyIdentities,input.history.length)
    if(input.helperMvu!==undefined) parseTemplateHelperMvu(input.helperMvu,input.historyIdentities ?? [])
    if(input.messageVariables) {
      parseTemplateMessageVariables(input.messageVariables)
      const visible=new Set(input.historyIdentities?.map(item=>item.messageId) ?? input.history.map((_,index)=>`preview:${index}`))
      if(Object.keys(input.messageVariables.snapshots).some(id=>!visible.has(id))) throw new Error('模板包含不可见消息变量')
    }
    // YAML 解析同样发生在可终止 worker；不注册自定义 tag，限制别名展开，拒绝循环与非 JSON。
    return { ...input, entries: input.entries.map(normalizeTemplateLore).map(entry => {
      if (!entry.enabled || !/^\[InitialVariables\]/i.test(entry.comment)) return entry
      const doc = parseDocument(entry.content, { uniqueKeys: true })
      if (doc.errors.length || doc.warnings.length) throw new Error(`InitialVariables 解析失败：${doc.errors[0]?.message ?? doc.warnings[0]?.message}`)
      const value: unknown = doc.toJS({ maxAliasCount: 50 })
      validateTemplateJson(value)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('InitialVariables 必须是对象')
      return { ...entry, content: JSON.stringify(value) }
    }) }
  }

  static async create(input: TemplateContext, record=false, bootstrap?:TemplateReplayBootstrap, resourceChars?:number): Promise<TemplateSandbox> {
    if(!templateRuntimeHash) throw new Error('模板检查点运行时尚未准备')
    const identity=resolveTemplateRuntimeIdentity({runtimeHash:templateRuntimeHash,runtimeAbi:TEMPLATE_RUNTIME_ABI},templateRuntimeHash)
    computationPhase?.('computing')
    const contextChars=measureTemplateJson(input)
    resourceChars=Math.max(resourceChars ?? 0,contextChars)
    const initialContext=structuredClone(input)
    input=TemplateSandbox.normalizeContext(input)
    computationPhase?.('loading')
    const owner = await createTemplateCheckpointVm()
    const vm = owner.vm
    vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes)
    vm.runtime.setMaxStackSize(512 * 1024)
    // 受信装载（vendor 库求值、上下文初始化）给宽裕期限；第三方执行前由 beginComputation 收紧。
    const sandbox = new TemplateSandbox(owner, Date.now() + 10_000,resourceChars,contextChars,identity)
    vm.runtime.setInterruptHandler(() => sandbox.interruptIfExpired())
    try {
      if (!templateLibrarySource) throw new Error('模板依赖产物缺失，请先运行 npm run build')
      if (!templateFakerData || !templateBootstrapSource) throw new Error('Faker 模板依赖产物缺失，请先运行 npm run build')
      const fakerDataHandle=vm.newString(templateFakerData)
      try { vm.setProp(vm.global,'__tavernFakerData',fakerDataHandle) } finally { fakerDataHandle.dispose() }
      // 大历史作为字符串值传入，避免把 JSON 再转义成源码后交给 QuickJS 解析一次。
      const inputHandle=vm.newString(JSON.stringify(input))
      try { vm.setProp(vm.global,'__input',inputHandle) } finally { inputHandle.dispose() }
      const limitHandle=vm.newNumber(contextChars+1024*1024)
      try {vm.setProp(vm.global,'__tavernOutputLimit',limitHandle)} finally {limitHandle.dispose()}
      sandbox.evaluate(templateBootstrapSource)
      // 任何第三方代码（含 preload）之前冻结宿主命令入口；模板不能替换命令实现来伪造状态或结果。
      sandbox.hardenProtocol()
      if(bootstrap?.preload==='refresh') sandbox.sticky('restore',bootstrap.state)
      sandbox.beginComputation()
      sandbox.preload(input)
      if(bootstrap?.preload==='preserve') sandbox.sticky('restore',bootstrap.state)
      sandbox.initialContext=initialContext
      sandbox.generationContext=initialContext
      sandbox.currentContext=initialContext
      sandbox.bootstrap=structuredClone(bootstrap)
      sandbox.recording=record
      return sandbox
    } catch (error) { vm.dispose(); throw error }
  }

  /** 重建同轮已执行的代码和词法环境；所有输入仍由 QuickJS 求值，每步校验确定性结果。 */
  static async restore(replay:TemplateReplay, context:TemplateContext):Promise<TemplateSandbox> {
    const sandbox=await TemplateSandbox.rebuild(replay)
    try {sandbox.resume(context);return sandbox}
    catch(error) {sandbox.dispose();throw error}
  }

  static async rebuild(replay:TemplateReplay):Promise<TemplateSandbox> {
    if(replay.version!==2) throw new Error('模板重放版本不兼容，需要完成或回滚旧版本楼层')
    // 外显操作哈希无法覆盖词法闭包内捕获的格式化结果；必须在任何第三方代码执行前拒绝旧引擎日志。
    assertTemplateReplayFormatter(replay)
    if(replay.context.phase!=='generate' || !Array.isArray(replay.operations)) throw new Error('模板重放记录无效')
    const replayChars=measureTemplateReplayWork(replay)
    // 引用在任何第三方代码执行前整批校验；展开后的入参与记录时逐字节一致。
    const data=templateReplayData(replay)
    const sandbox=replay.checkpoint ? await TemplateSandbox.fromCheckpoint(replay,replayChars)
      : await TemplateSandbox.create(replay.context,false,replay.bootstrap,replayChars)
    try {
      for(const operation of replay.operations) {
        let result:unknown
        if(operation.kind==='render') {
          const opData=data(operation)
          if(operation.source===TemplateSandbox.CONDITION_SOURCE) result=sandbox.evalCondition(operation.text)
          else if(operation.source===undefined && Object.keys(opData).length===0 && operation.text===TemplateSandbox.PREPARE_BASIC_REGEX_OP) {sandbox.prepareBasicRegex();result=''}
          else if(operation.source===undefined && Object.keys(opData).length===0 && operation.text===TemplateSandbox.CLEAR_BASIC_REGEX_OP) {sandbox.clearBasicRegex();result=''}
          else result=sandbox.render(operation.text,opData,operation.source)
        }
        else if(operation.kind==='regexSources') result=sandbox.transformRegexSources(parseTemplateReplayRegexParts(data(operation).parts),operation.stage,operation.meta,operation.namespace)
        else if(operation.kind==='regexSourcesBatch') result=sandbox.transformBasicRegexSources(parseTemplateReplayRegexBatch(data(operation).items),operation.namespace)
        else if(operation.kind==='regex') result=sandbox.transformRegex(operation.text,operation.stage,operation.meta)
        else if(operation.kind==='variables') result=sandbox.variables()
        else if(operation.kind==='outlets') result=sandbox.resolveOutlets(operation.text)
        else if(operation.kind==='deferOutlets') {sandbox.setOutletsDeferred(operation.value);result=null}
        else if(operation.kind==='phase') {sandbox.resume(operation.context,operation.refreshPreload);result=null}
        else if(operation.kind==='phaseData') {sandbox.resume(data(operation) as unknown as TemplateContext,operation.refreshPreload);result=null}
        else if(operation.kind==='message') result=sandbox.setMessageContext(operation.metadata)
        else if(operation.kind==='format') result=sandbox.formatMessage(operation.text)
        else if(operation.kind==='messageVariables') result=sandbox.messageVariables()
        else if(operation.kind==='sticky') result=sandbox.sticky(operation.action,operation.state)
        else throw new Error('未知模板重放操作')
        if(sandbox.hash(result)!==operation.hash) throw new Error('模板重放结果不一致，拒绝提交回复')
      }
      sandbox.operations=structuredClone(replay.operations)
      sandbox.adoptShared(replay)
      sandbox.operationChars=JSON.stringify(replay.operations).length+JSON.stringify(sandbox.shared).length
      sandbox.recording=true
      sandbox.verifyReplayState(replay)
      return sandbox
    } catch(error) {sandbox.dispose();throw error}
  }

  /** 只装载本插件固定 ABI 的完整隔离堆，不执行存档携带的宿主代码，也不重新运行检查点之前的脚本。 */
  private static async fromCheckpoint(replay:TemplateReplay,resourceChars:number):Promise<TemplateSandbox> {
    const checkpoint=replay.checkpoint!
    if(!templateRuntimeHash) throw new Error('模板检查点运行时尚未准备')
    const identity=resolveTemplateRuntimeIdentity(checkpoint,templateRuntimeHash)
    const owner=await createTemplateCheckpointVm(checkpoint.image)
    const sandbox=new TemplateSandbox(owner,Date.now()+10_000,resourceChars,checkpoint.outputInputChars,identity)
    try {
      owner.vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes)
      owner.vm.runtime.setMaxStackSize(512*1024)
      owner.vm.runtime.setInterruptHandler(()=>sandbox.interruptIfExpired())
      // 旧检查点可能来自未冻结的运行时；恢复后同样冻结入口（对已冻结属性是幂等的）。
      sandbox.hardenProtocol()
      sandbox.initialContext=structuredClone(replay.context)
      sandbox.generationContext=structuredClone(replay.context)
      sandbox.currentContext=structuredClone(checkpoint.context)
      sandbox.checkpoint=structuredClone(checkpoint)
      sandbox.checkpointEligible=true
      sandbox.beginComputation()
      return sandbox
    } catch(error) {owner.vm.dispose();throw error}
  }

  private hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
  private record(operation:TemplateReplayInstruction,result:unknown):void {
    if(!this.recording) return
    const stored={...('data' in operation ? this.shareData(operation) : structuredClone(operation)),hash:this.hash(result)} as TemplateReplayOperation
    this.operationChars+=JSON.stringify(stored).length
    if(this.operationChars>TEMPLATE_REPLAY_LIMIT) throw new Error(`模板重放记录超过上限：${TEMPLATE_REPLAY_LIMIT_HINT}`)
    this.operations.push(stored)
  }

  /**
   * 每个来源求值都会带上整份模拟序列和累积缓冲；逐条内联会让日志按「来源数 × 历史」增长。
   * 大型入参移入共享表，原位置留占位以保持键顺序，重放时展开成同样的字节。
   */
  private shareData(operation:TemplateReplayDataInstruction):TemplateReplayDataInstruction {
    const data:Record<string,unknown>={},refs:Record<string,TemplateReplayRef>={}
    for(const [key,value] of Object.entries(operation.data)) {
      const json=JSON.stringify(value)
      // JSON 不保存 undefined；求值时传入的入参同样不含该键。
      if(json===undefined) continue
      if(json.length<TEMPLATE_REPLAY_SHARE_MIN) {data[key]=JSON.parse(json);continue}
      data[key]=null
      // 只有历史序列适合追加前缀；逐消息 parts 等交替数组继续按内容哈希复用，避免 A/B/A 重复落盘。
      refs[key]=typeof value==='string' ? this.shareText(key,value,json)
        : Array.isArray(value) && ['history','historyIdentities','generateData'].includes(key) ? this.shareArray(key,value,json) : this.shareValue(json)
    }
    return {...operation,data,...(Object.keys(refs).length ? {refs} : {})}
  }
  private shareValue(json:string):number {
    this.sharedJson ??= new TemplateReplayJsonWriter(this.shared,text=>createHash('sha256').update(text).digest('hex'),chars=>{this.operationChars+=chars})
    return this.sharedJson.write(JSON.parse(json),json)
  }
  private shareText(key:string,value:string,json:string):TemplateReplayRef {
    const current=this.sharedTexts.get(key)
    if(current && current.text.length>=value.length && current.text.startsWith(value)) return [current.index,value.length]
    if(current && value.startsWith(current.text)) {
      const suffix=value.slice(current.text.length)
      ;(this.shared[current.index] as {text:string[]}).text.push(...sharedTextSegments(suffix))
      this.operationChars+=JSON.stringify(suffix).length
      current.text=value
      return [current.index,value.length]
    }
    this.operationChars+=json.length
    const index=this.shared.push({text:sharedTextSegments(value)})-1
    this.sharedTexts.set(key,{index,text:value})
    return [index,value.length]
  }
  private shareArray(key:string,value:unknown[],json:string):TemplateReplayRef {
    if(this.structuredArrayKeys.has(key)) return this.shareValue(json)
    const current=this.sharedArrays.match(key,value)
    if(current) {
      if(current.suffix.length) {
        const suffix=JSON.stringify(current.suffix)
        const target=(this.shared[current.index] as {array:unknown[]}).array
        for(const item of JSON.parse(suffix) as unknown[]) target.push(item)
        this.operationChars+=suffix.length
      }
      return [current.index,current.length]
    }
    // 历史裁剪或动态提示词使严格前缀失效时，转为内容共享页；只新增改动页和小根，不重存整段历史。
    if(this.prefixArrayKeys.has(key)) {this.structuredArrayKeys.add(key);return this.shareValue(json)}
    const values:unknown[]=JSON.parse(json)
    this.operationChars+=json.length
    const index=this.shared.push({array:values})-1
    this.sharedArrays.remember(key,index,values)
    this.prefixArrayKeys.add(key)
    return [index,value.length]
  }
  /** 续接已有日志时恢复去重索引，后续轮次的相同入参继续复用旧项。 */
  private adoptShared(replay:TemplateReplay):void {
    this.shared=structuredClone(replay.shared ?? [])
    this.sharedJson=undefined
    const adoptedArrays=new Map<string,number>()
    for(const operation of replay.operations) {
      if(!('data' in operation) || !operation.refs) continue
      for(const [key,ref] of Object.entries(operation.refs)) {
        if(typeof ref==='number' && ['history','historyIdentities','generateData'].includes(key)
          && ('jsonArray' in this.shared[ref]! || 'jsonArrayPages' in this.shared[ref]!)) this.structuredArrayKeys.add(key)
        if(Array.isArray(ref)) {
          const item=this.shared[ref[0]]!
          if('array' in item) {
            if(adoptedArrays.get(key)!==ref[0]) {
              this.sharedArrays.remember(key,ref[0],item.array)
              this.prefixArrayKeys.add(key)
              adoptedArrays.set(key,ref[0])
            }
          }
          else if(this.sharedTexts.get(key)?.index!==ref[0]) this.sharedTexts.set(key,{index:ref[0],text:(item as {text:string[]}).text.join('')})
        }
      }
    }
  }

  replay():TemplateReplay {
    const variables=this.variables()
    const messageVariablesHash=this.hash(this.messageVariables())
    // 普通单轮日志保持紧凑 JSON；只有跨轮存活环境需要检查点。一次成功导出后清掉全部已覆盖操作。
    if(this.checkpointEligible && (this.operations.length>=256 || this.operationChars>=1024*1024)) this.captureCheckpoint()
    const replay:TemplateReplay={version:2,formatterVersion:2,context:this.initialContext,operations:this.operations,
      ...(this.shared.length ? {shared:this.shared} : {}),variables,messageVariablesHash,
      ...(this.checkpoint ? {checkpoint:this.checkpoint} : {}),
      ...(this.bootstrap ? {bootstrap:this.bootstrap} : {})}
    measureTemplateReplay(replay)
    return cleanPlainJson(replay)
  }

  private captureCheckpoint():void {
    // 恢复旧兼容环境后仍使用它的真实身份，不能用当前安装包摘要冒充完成了运行时迁移。
    const next:TemplateReplayCheckpoint={version:1,...this.runtimeIdentity,image:dumpTemplateCheckpointVm(this.owner),
      context:structuredClone(this.currentContext),outputInputChars:this.outputInputChars,resourceChars:this.resourceChars}
    // 候选整体检查成功后才替换日志；落盘仍由工作区的原子根与 WAL 负责。
    measureTemplateReplay({version:2,formatterVersion:2,context:this.generationContext,checkpoint:next,operations:[]})
    this.checkpoint=next
    this.initialContext=structuredClone(this.generationContext)
    this.bootstrap=undefined
    this.operations=[];this.shared=[];this.operationChars=0;this.sharedJson=undefined
    this.sharedTexts.clear();this.sharedArrays.clear();this.prefixArrayKeys.clear();this.structuredArrayKeys.clear()
  }

  /** 直接经纯 C FFI 读取原始值并释放句柄，绝不走 QTS_Dump（避免调用 JS_JSONStringify / Object.prototype.toJSON）。 */
  private readPrimitiveAndDispose(handle: QuickJSHandle): string | number | boolean | null | undefined {
    try {
      const type = this.vm.typeof(handle)
      if (type === 'undefined') return undefined
      if (type === 'string') return this.vm.getString(handle)
      if (type === 'number') return this.vm.getNumber(handle)
      if (type === 'boolean') return this.vm.eq(handle, this.vm.true)
      if (type === 'object' && this.vm.eq(handle, this.vm.null)) return null
      return undefined
    } finally {
      if (handle.alive) handle.dispose()
    }
  }

  /** 安全格式化任意 QuickJS 异常句柄（含 Error、BigInt、Symbol、恶意 getter/toJSON 对象），绝不经 QTS_Dump 触发原型 toJSON 或泄漏 C 句柄。 */
  private formatErrorHandle(errorHandle: QuickJSHandle): string {
    try {
      const type = this.vm.typeof(errorHandle)
      if (type === 'string') return this.vm.getString(errorHandle)
      if (type === 'number') return String(this.vm.getNumber(errorHandle))
      if (type === 'bigint') return `${this.vm.getBigInt(errorHandle)}n`
      if (type === 'boolean') return this.vm.eq(errorHandle, this.vm.true) ? 'true' : 'false'
      if (type === 'undefined') return 'undefined'
      if (type === 'symbol') return this.vm.getSymbol(errorHandle).toString()
      if (type === 'object' && this.vm.eq(errorHandle, this.vm.null)) return 'null'
      // 访问对象属性可能触发第三方 getter；清空正则阶段缓存并施加严格临时期限与极小内存余量（兼容 OOM/超时后提取原始异常）。
      this.regexStageEmpty.clear()
      const prevDeadline = this.deadline
      const prevInterrupted = this.deadlineInterrupted
      const baseMemory = templateExecutionBudget(this.resourceChars).quickJsMemoryBytes
      this.deadline = Math.max(prevDeadline, Date.now() + 50)
      this.vm.runtime.setMemoryLimit(baseMemory + 256 * 1024)
      try {
        const fmt = this.vm.evalCode(ERROR_FORMATTER)
        if (fmt.error) {
          if (fmt.error.alive) fmt.error.dispose()
          return prevInterrupted ? 'InternalError: interrupted' : '[Unformattable Error]'
        }
        try {
          const out = this.vm.callFunction(fmt.value, this.vm.undefined, errorHandle)
          if (out.error) {
            if (out.error.alive) out.error.dispose()
            return prevInterrupted ? 'InternalError: interrupted' : '[Unformattable Error]'
          }
          try {
            return this.vm.typeof(out.value) === 'string' ? this.vm.getString(out.value) : '[Unformattable Error]'
          } finally {
            if (out.value.alive) out.value.dispose()
          }
        } finally {
          if (fmt.value.alive) fmt.value.dispose()
        }
      } finally {
        this.vm.runtime.setMemoryLimit(baseMemory)
        this.deadline = prevDeadline
        this.deadlineInterrupted = prevInterrupted
      }
    } finally {
      if (errorHandle.alive) errorHandle.dispose()
    }
  }

  /** 统一格式化同步 evalCode / callFunction 异常并识别超时中断，防止超时被误判为确定性脚本失败。 */
  private evalFailure(errorHandle: QuickJSHandle): Error {
    const message = this.formatErrorHandle(errorHandle)
    if (/interrupt/i.test(message) && (this.deadlineInterrupted || Date.now() > this.deadline)) {
      return new Error('EJS 模板计算超时')
    }
    return new Error(`EJS 模板失败：${message}${this.deadlineInterrupted ? '（执行期间触发计算超时中断）' : ''}`)
  }

  /** readonly 仅用于不改变沙箱状态的固定查询；其余求值都可能运行第三方代码并改动规则表。 */
  private evaluate(code: string, readonly = false): unknown {
    this.vmEpoch++
    if (!readonly) this.regexStageEmpty.clear()
    this.deadlineInterrupted = false
    const result = this.vm.evalCode(code)
    if (result.error) throw this.evalFailure(result.error)
    return this.readPrimitiveAndDispose(result.value)
  }

  /** 纯 JSON 经函数实参句柄直接传入，不经可写 globalThis 中转，也不把大文本编成 JS 源码。 */
  private evaluateInput(fnExpr:string,input:unknown,readonly=false):unknown {
    const json=JSON.stringify(input)
    if(json.length>TEMPLATE_INPUT_MAX_CHARS) throw new Error('模板调用输入超过安全资源容量')
    this.growResources(json.length)
    this.vmEpoch++
    if(!readonly) this.regexStageEmpty.clear()
    this.deadlineInterrupted=false
    const fnResult=this.vm.evalCode(fnExpr)
    if(fnResult.error) throw this.evalFailure(fnResult.error)
    const fn=fnResult.value
    try {
      const handle=this.vm.newString(json)
      try {
        const result=this.vm.callFunction(fn,this.vm.undefined,handle)
        if(result.error) throw this.evalFailure(result.error)
        return this.readPrimitiveAndDispose(result.value)
      } finally {
        if(handle.alive) handle.dispose()
      }
    } finally {
      if(fn.alive) fn.dispose()
    }
  }

  /** 同 evaluateInput，但把完成值句柄留给调用方（渲染状态必须由宿主持有，不能经全局中转）。 */
  private evaluateHandle(fnExpr:string,input:unknown):QuickJSHandle {
    const json=JSON.stringify(input)
    if(json.length>TEMPLATE_INPUT_MAX_CHARS) throw new Error('模板调用输入超过安全资源容量')
    this.growResources(json.length)
    // 与 evaluate(code,false) 同语义：包装里会执行第三方代码，可能改动临时正则表，必须失效阶段缓存。
    this.vmEpoch++
    this.regexStageEmpty.clear()
    this.deadlineInterrupted=false
    const fnResult=this.vm.evalCode(fnExpr)
    if(fnResult.error) throw this.evalFailure(fnResult.error)
    const fn=fnResult.value
    try {
      const handle=this.vm.newString(json)
      try {
        const result=this.vm.callFunction(fn,this.vm.undefined,handle)
        if(result.error) throw this.evalFailure(result.error)
        return result.value
      } finally {
        if(handle.alive) handle.dispose()
      }
    } finally {
      if(fn.alive) fn.dispose()
    }
  }

  /** 只读取闭包状态；不经过模板可命名的全局，也不调用任何模板可补丁的函数或 QTS_Dump。 */
  private readRenderState(state:QuickJSHandle):{done:boolean;error:string|null;result:unknown} {
    const read=(key:string):unknown=> {
      const prop=this.vm.getProp(state,key)
      try {
        const type=this.vm.typeof(prop)
        if(type==='undefined') return undefined
        if(type==='string') return this.vm.getString(prop)
        if(type==='number') return this.vm.getNumber(prop)
        if(type==='boolean') return this.vm.eq(prop,this.vm.true)
        if(type==='object' && this.vm.eq(prop,this.vm.null)) return null
        return null
      } finally {
        if(prop.alive) prop.dispose()
      }
    }
    const done=read('done'),error=read('error')
    return {done:done===true,error:typeof error==='string'&&error ? error : null,result:read('result')}
  }

  /** 只记录实际发出的中断，不把单纯超过墙钟期限等同于中断。 */
  private interruptIfExpired():boolean {
    if(Date.now()<=this.deadline) return false
    this.deadlineInterrupted=true
    return true
  }

  /** 保留真实错误；若执行时确实触发过中断，同时报告该事实，不猜测两者的因果关系。 */
  private renderFailure(message:string):Error {
    if(/interrupt/i.test(message) && (this.deadlineInterrupted || Date.now()>this.deadline)) return new Error('EJS 模板计算超时')
    if(!this.deadlineInterrupted && /^(?:Error:\s*)?@@if 条件/.test(message)) return new Error(message.replace(/^Error:\s*/,''))
    return new Error(`EJS 模板失败：${message}${this.deadlineInterrupted ? '（执行期间触发计算超时中断）' : ''}`)
  }

  /** 冻结宿主命令入口；对已冻结属性幂等，旧堆里的可写实现会被一并收紧。 */
  private hardenProtocol():void { this.evaluate(HARDEN_PROTOCOL) }

  /**
   * 宿主侧直接单趟序列化内部状态并在主线程比较：不再经过模板可命名的 __conditionState，
   * 也不调用 vm.dump / JSON.stringify / toJSON，彻底消除“先检后 dump”的二次读取窗口。
   */
  private conditionState():string {
    // 读取属性会触发 getter/Proxy 等模板代码；与 evaluate 一致失效阶段缓存。
    this.regexStageEmpty.clear()
    this.deadlineInterrupted=false
    const fail=(errorHandle:QuickJSHandle):Error=> {
      const message=this.formatErrorHandle(errorHandle)
      if(/interrupt/i.test(message) && (this.deadlineInterrupted || Date.now()>this.deadline)) return new Error('EJS 模板计算超时')
      return new Error(`@@if 条件状态读取失败：${message}${this.deadlineInterrupted ? '（执行期间触发计算超时中断）' : ''}`)
    }
    const object=this.vm.evalCode('({scopes,variables,initial,messageSnapshots})')
    if(object.error) throw fail(object.error)
    try {
      const snapshotFn=this.vm.evalCode(CONDITION_STATE_SNAPSHOT)
      if(snapshotFn.error) throw fail(snapshotFn.error)
      try {
        const result=this.vm.callFunction(snapshotFn.value,this.vm.undefined,object.value)
        if(result.error) throw fail(result.error)
        try {
          if(this.vm.typeof(result.value)==='string') return this.vm.getString(result.value)
          const code=this.vm.getNumber(result.value)
          if(code===1) throw new Error('@@if 条件状态过大，拒绝求值')
          if(code===3) throw new Error('@@if 条件状态不可序列化，拒绝求值')
          throw new Error('@@if 条件状态含自定义 toJSON，拒绝求值')
        } finally { if (result.value.alive) result.value.dispose() }
      } finally { if (snapshotFn.value.alive) snapshotFn.value.dispose() }
    } finally { if (object.value.alive) object.value.dispose() }
  }

  private growResources(inputChars:number):void {
    if(inputChars>this.resourceChars) {
      this.resourceChars=inputChars
      const budget=templateExecutionBudget(inputChars)
      this.vm.runtime.setMemoryLimit(budget.quickJsMemoryBytes)
      // 扩大输入只调整从本阶段起点算的期限，不能靠反复调用重新获得完整执行时长。
      if(this.computationStarted) this.deadline=this.computationStarted+budget.sandboxMs
    }
    if(inputChars>this.outputInputChars) {
      this.outputInputChars=inputChars
      const limit=inputChars+1024*1024
      // 通过实参直接更新词法变量 templateOutputLimit，不借可写 globalThis 中转。
      this.evaluate(`(limit=>{templateOutputLimit=limit})(${limit})`,true)
    }
  }

  /** 受信装载结束后收紧到第三方计算预算；后续阶段（resume/继续轮）重置同一预算。 */
  private beginComputation(): void {
    computationPhase?.('computing')
    this.computationStarted=Date.now()
    this.deadlineInterrupted=false
    this.deadline = this.computationStarted+templateExecutionBudget(this.resourceChars).sandboxMs
  }

  /** 精确日志命中后开始新的隔离任务；只重置执行预算，保留已验证日志所对应的词法环境。 */
  restartBudget(resourceChars:number):void {
    this.resourceChars=Math.max(this.resourceChars,resourceChars)
    this.vm.runtime.setMemoryLimit(templateExecutionBudget(this.resourceChars).quickJsMemoryBytes)
    this.beginComputation()
  }

  /** 冷暖恢复都执行相同末态校验；变量 schema 与帧同步可运行脚本，不能把这些查询当成无副作用跳过。 */
  verifyReplayState(replay:TemplateReplay):void {
    const recording=this.recording
    let variables:TemplateScopes,messageVariables:TemplateMessageVariables
    this.recording=false
    try {
      variables=this.variables()
      if(JSON.stringify(variables)!==JSON.stringify(replay.variables)) throw new Error('模板重放最终变量不一致')
      messageVariables=this.messageVariables()
      if(this.hash(messageVariables)!==replay.messageVariablesHash) throw new Error('模板重放历史消息变量不一致')
    } finally {this.recording=recording}
    // 只登记刚刚真实执行的两次查询，不再次求值；否则后续冷恢复会漏掉历史 schema 校验的闭包副作用。
    if(this.recording) {
      // 这两条固定记录先作为校验尾部保留：下一轮可能立即释放最后到期闭包。
      // 在确认仍需日志的正常 record/replay 处统一限长，避免清理尚未运行就再次卡在旧容量边缘。
      for(const [kind,result] of [['variables',variables],['messageVariables',messageVariables]] as const) {
        const operation={kind,hash:this.hash(result)}
        this.operationChars+=JSON.stringify(operation).length
        this.operations.push(operation)
      }
    }
  }

  private preload(context:TemplateContext):void {
    const recording=this.recording;this.recording=false
    try {
      this.evaluate('__setPreparing(true)')
      for(const entry of context.entries.filter(e=>e.enabled && e.templatePreload).sort((a,b)=>a.order-b.order)) {
        if(!entry.templateCondition || this.condition(entry.templateCondition)) this.render(entry.content,{},entry.key)
      }
      this.evaluate('__setPreparing(false)')
    } finally {this.recording=recording}
  }

  resume(context:TemplateContext,refreshPreload=false):void {
    this.beginComputation()
    const normalized=TemplateSandbox.normalizeContext(context)
    if(context.phase==='generate') {
      if(normalized.messageVariables) {
        const known=new Set([
          ...(this.currentContext.historyIdentities?.map(item=>item.messageId) ?? this.currentContext.history.map((_,index)=>`preview:${index}`)),
          ...Object.keys(this.currentContext.messageVariables?.snapshots ?? {}),
        ])
        if(Object.keys(normalized.messageVariables.snapshots).some(id=>!known.has(id))) {
          throw new Error('模板跨轮历史变量与已提交状态不一致')
        }
      }
      this.evaluateInput('raw=>__continueTemplateGeneration(parseTemplateInput(raw))',normalized)
      this.renderedSources.clear()
      if(refreshPreload) this.preload(normalized)
    } else this.evaluateInput('raw=>__resumeTemplateReply(parseTemplateInput(raw))',normalized)
    this.currentContext=structuredClone(context)
    if(context.phase==='generate') {this.generationContext=this.currentContext;this.checkpointEligible=true}
    this.record({kind:'phaseData',data:{...context},refreshPreload},null)
  }

  /** 先判定旧闭包是否全部到期；可释放日志时不能让用于清理的两条记录撞上旧预算。 */
  advanceGeneration(context:TemplateContext,refreshPreload:boolean):TemplateStickyState {
    const recording=this.recording
    this.recording=false
    try {
      this.resume(context,refreshPreload)
      const remaining=this.sticky('begin')
      this.recording=recording
      if(hasTemplateStickyClosures(remaining)) {
        this.record({kind:'phaseData',data:{...context},refreshPreload},null)
        this.record({kind:'sticky',action:'begin'},remaining)
      }
      return remaining
    } finally {this.recording=recording}
  }

  stickyState():TemplateStickyState {
    const raw=this.evaluate('__exportTemplateStickyState()')
    if(typeof raw!=='string') throw new Error('sticky 导出无效')
    let parsed:unknown
    try { parsed=JSON.parse(raw) } catch { throw new Error('sticky 导出无效') }
    return parseTemplateStickyState(parsed)
  }

  sticky(action:'begin'|'finish'|'restore',state?:TemplateStickyState):TemplateStickyState {
    if(action==='restore') {
      if(!state) throw new Error('sticky 恢复缺少状态')
      this.evaluateInput('raw=>__restoreTemplateStickyState(parseTemplateInput(raw))',parseTemplateStickyState(state))
    } else this.evaluate(action==='begin'?'__beginTemplateGeneration()':'__finishTemplateGeneration()')
    const result=this.stickyState()
    this.record({kind:'sticky',action,...(state ? {state} : {})},result)
    return result
  }

  /** 直接调用冻结的 globalThis 协议入口，避免经 EJS with (locals) 被 define 同名属性遮蔽。 */
  prepareBasicRegex():void {
    this.evaluate('__prepareTemplateBasicRegex()')
    this.record({kind:'render',text:TemplateSandbox.PREPARE_BASIC_REGEX_OP,data:{}},'')
  }

  clearBasicRegex():void {
    this.evaluate('__clearTemplateBasicRegex()')
    this.record({kind:'render',text:TemplateSandbox.CLEAR_BASIC_REGEX_OP,data:{}},'')
  }

  private drainRenderHandle(state:QuickJSHandle):string {
    try {
      while (this.vm.runtime.hasPendingJob()) {
        if (Date.now() > this.deadline) {
          const pending=this.readRenderState(state)
          if (pending.error) throw this.renderFailure(pending.error)
          throw new Error('EJS 模板计算超时')
        }
        // 成批执行微任务，批间复查期限；批内超期由中断处理器终止当前任务，不必逐个往返 FFI。
        const result = this.vm.runtime.executePendingJobs(PENDING_JOB_BATCH)
        if (result.error) {
          const message = this.formatErrorHandle(result.error)
          if (/interrupt/i.test(message) && (this.deadlineInterrupted || Date.now() > this.deadline)) throw new Error('EJS 模板计算超时')
          throw new Error(`EJS 异步任务失败：${message}${this.deadlineInterrupted ? '（执行期间触发计算超时中断）' : ''}`)
        }
      }
      // 先读真实结果：期限已过但脚本已明确失败时必须报真实原因（OOM/内部错误），不能一律报超时。
      const outcome = this.readRenderState(state)
      if (outcome.error) throw this.renderFailure(outcome.error)
      if (Date.now() > this.deadline) throw new Error('EJS 模板计算超时')
      if (!outcome.done) throw new Error('EJS 异步任务未完成（不允许外部 I/O）')
      const value = outcome.result
      if (typeof value !== 'string' || value.length > this.outputInputChars+1024*1024) throw new Error('EJS 输出无效或净增超过 1 MiB 上限')
      return value
    } finally { state.dispose() }
  }

  render(text: string, data: Record<string,unknown> = {}, source?:string): string {
    // 完成状态只存在于包装闭包内；模板写 globalThis.__done/__result 一类同名全局不再有任何作用。
    const state=this.evaluateHandle(RENDER_WRAPPER,{text,data,source})
    const value=this.drainRenderHandle(state)
    this.record({kind:'render',text,data,source},value)
    return value
  }

  /** 重组同轮计划时只重放已求值的来源，避免 activewi 引起脚本重复写变量。 */
  renderSource(text: string, source: string, data: Record<string,unknown> = {}): string {
    if (this.renderedSources.has(source)) return this.renderedSources.get(source)!
    const value = this.render(text,data,source)
    this.renderedSources.set(source,value)
    return value
  }
  activationRequests(): Array<{key:string;force:boolean}> {
    const raw = this.evaluate('__activationRequests()', true)
    if (typeof raw !== 'string') throw new Error('模板激活请求无效')
    try { return JSON.parse(raw) as Array<{key:string;force:boolean}> } catch { throw new Error('模板激活请求无效') }
  }
  /**
   * 这条消息在该阶段是否有临时正则。没有规则时变换恒等且不执行任何第三方代码，
   * 调用方直接沿用原文：不进入 EJS，也不留下随消息数增长的重放记录。只读查询本身不入日志。
   */
  private hasRegexStage(stage:'basic'|'generate'|'message'|'after'):boolean {
    // 整个阶段没有规则是最常见的情况：结论沿用到下一次可能改动规则的求值，逐条消息不再询问沙箱。
    let empty=this.regexStageEmpty.get(stage)
    if(empty===undefined) {
      const count=this.evaluate(`__templateRegexStageSize(${JSON.stringify(stage)})`,true)
      if(typeof count!=='number' || !Number.isSafeInteger(count) || count<0) throw new Error('临时正则规则计数无效')
      empty=count===0
      this.regexStageEmpty.set(stage,empty)
    }
    return !empty
  }
  private hasRegexRules(stage:'basic'|'generate'|'message'|'after',meta:{role:string;worldinfo:boolean;depth:number}):boolean {
    if(!this.hasRegexStage(stage)) return false
    const count=this.evaluate(`__templateRegexRuleCount(${JSON.stringify(stage)},${JSON.stringify(meta)})`,true)
    if(typeof count!=='number' || !Number.isSafeInteger(count) || count<0) throw new Error('临时正则规则计数无效')
    return count>0
  }
  transformRegex(text: string, stage: 'generate'|'message'|'after', meta: {role:string;worldinfo:boolean;depth:number}): string {
    if(!this.hasRegexRules(stage,meta)) return text
    // 经实参句柄传入并触发 growResources，避免大回复文本拼进 evalCode 导致 QuickJS 32 MiB 初始堆 OOM。
    const result = this.evaluateInput('raw=>{const call=parseTemplateInput(raw);return __applyTemporaryRegex(call.text,call.stage,call.meta)}',{text,stage,meta})
    if (typeof result !== 'string') throw new Error('临时正则返回值无效')
    this.record({kind:'regex',text,stage,meta},result)
    return result
  }
  transformRegexSources(parts:TemplateRegexSource[],stage:'basic'|'generate'|'message'|'after',meta:{role:string;worldinfo:boolean;depth:number},cacheNamespace:string):TemplateRegexSource[] {
    if(typeof cacheNamespace!=='string' || cacheNamespace.length>4096) throw new Error('正则来源命名空间无效或超限')
    parseTemplateReplayRegexParts(parts)
    if(!this.hasRegexStage(stage)) return parts.map(part=>({...part}))
    const raw=this.evaluateInput('raw=>{const call=parseTemplateInput(raw);return __runTemporaryRegexSources(call.parts,call.stage,call.meta,call.namespace)}',
      {parts,stage,meta,namespace:cacheNamespace})
    if(typeof raw!=='string') throw new Error('正则来源结果无效')
    let value:unknown
    try { value=JSON.parse(raw) } catch { throw new Error('正则来源结果无效') }
    if(!value || typeof value!=='object' || !('applied' in value) || typeof value.applied!=='boolean' || !('parts' in value)) throw new Error('正则来源结果无效')
    const result=parseTemplateReplayRegexParts(value.parts)
    if(value.applied) this.record({kind:'regexSources',stage,meta,namespace:cacheNamespace,data:{parts}},result)
    return result
  }
  /** basic 全包在任何消息来源求值之前完成，且只允许文本替换；一次调用保持原先逐消息的来源映射。 */
  transformBasicRegexSources(items:TemplateReplayRegexSources[],cacheNamespace:string):TemplateRegexSource[][] {
    if(typeof cacheNamespace!=='string' || cacheNamespace.length>4096) throw new Error('正则来源命名空间无效或超限')
    parseTemplateReplayRegexBatch(items)
    if(!this.hasRegexStage('basic')) return items.map(item=>item.parts.map(part=>({...part})))
    const raw=this.evaluateInput('raw=>{const call=parseTemplateInput(raw);return __runBasicRegexSourcesBatch(call.items,call.namespace)}',{items,namespace:cacheNamespace})
    if(typeof raw!=='string') throw new Error('basic 正则批次结果无效')
    let value:unknown
    try { value=JSON.parse(raw) } catch { throw new Error('basic 正则批次结果无效') }
    if(!value || typeof value!=='object' || !('applied' in value) || typeof value.applied!=='boolean' || !('parts' in value)
      || !Array.isArray(value.parts) || value.parts.length!==items.length) throw new Error('basic 正则批次结果无效')
    const result=value.parts.map(parts=>parseTemplateReplayRegexParts(parts))
    if(value.applied) this.record({kind:'regexSourcesBatch',namespace:cacheNamespace,data:{items}},result)
    return result
  }
  regexDescriptors(): TemplateRegexDescriptor[] {
    const raw = this.evaluate('__regexDescriptors()')
    if (typeof raw !== 'string') throw new Error('临时正则描述无效')
    try { return JSON.parse(raw) as TemplateRegexDescriptor[] } catch { throw new Error('临时正则描述无效') }
  }
  hasMessageRegex(): boolean { return this.evaluate('__hasMessageRegex()') === true }

  formatMessage(text:string):string {
    const result=this.evaluateInput('raw=>__formatTemplateMessage(parseTemplateInput(raw))',text)
    if(typeof result!=='string' || result.length>Math.min(TEMPLATE_OUTPUT_MAX_CHARS,text.length*16+1024*1024)) throw new Error('模板消息格式化输出超过安全资源容量')
    this.record({kind:'format',text},result)
    return result
  }

  setMessageContext(metadata:TemplateMessageMetadata|null):{role:string;worldinfo:boolean;depth:number} {
    // 经句柄逐个读取自有原始属性，避免 QTS_Dump 触发原型 toJSON 劫持或递归栈溢出泄漏。
    const handle=this.evaluateHandle('raw=>__setTemplateMessageContext(parseTemplateInput(raw))',metadata)
    try {
      const role=this.readPrimitiveAndDispose(this.vm.getProp(handle,'role'))
      const worldinfo=this.readPrimitiveAndDispose(this.vm.getProp(handle,'worldinfo'))
      const depth=this.readPrimitiveAndDispose(this.vm.getProp(handle,'depth'))
      if(typeof role!=='string' || typeof worldinfo!=='boolean' || typeof depth!=='number') {
        throw new Error('模板消息上下文返回无效')
      }
      const result={role,worldinfo,depth}
      this.record({kind:'message',metadata},result)
      return result
    } finally {
      if(handle.alive) handle.dispose()
    }
  }

  setOutletsDeferred(value:boolean):void {
    this.evaluate(`__setTemplateOutletsDeferred(${JSON.stringify(value)})`)
    this.record({kind:'deferOutlets',value},null)
  }
  resolveOutlets(text:string):string {
    const result=this.evaluateInput('raw=>__resolveTemplateOutlets(parseTemplateInput(raw))',text)
    if(typeof result!=='string') throw new Error('模板注入出口返回无效')
    this.record({kind:'outlets',text},result)
    return result
  }

  variables(): TemplateScopes {
    const raw = this.evaluate('__export()')
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw new Error('模板变量超过 1 MiB 上限')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('模板变量状态损坏') }
    const result=parseTemplateScopes(parsed)
    this.record({kind:'variables'},result)
    return result
  }
  messageVariables():TemplateMessageVariables {
    const raw=this.evaluate('__exportMessageVariables()')
    if(typeof raw!=='string') throw new Error('消息变量导出无效')
    let parsed:unknown
    try { parsed=JSON.parse(raw) } catch { throw new Error('消息变量导出无效') }
    const result=parseTemplateMessageVariables(parsed)
    this.record({kind:'messageVariables'},result)
    return result
  }
  private evalCondition(expression: string): string {
    // 整个条件求值与微任务排空期间维持只读深度，防止未 await 的链式微任务在条件返回后绕过只读守卫。
    this.evaluate('try{if(typeof __evalTemplateCondition==="function")conditionReadonlyDepth++}catch{}', true)
    try {
      const state = this.evaluateHandle(CONDITION_WRAPPER, { expression })
      const value = this.drainRenderHandle(state)
      this.record({ kind: 'render', text: expression, data: {}, source: TemplateSandbox.CONDITION_SOURCE }, value)
      return value
    } finally {
      try { this.evaluate('try{if(typeof __evalTemplateCondition==="function"&&conditionReadonlyDepth>0)conditionReadonlyDepth--}catch{}', true) } catch {}
    }
  }
  /** 条件在 WI 预算和分组前求值；拒绝写变量与注册表副作用，避免预选阶段产生未提交或重复副作用。 */
  condition(expression: string): boolean {
    // 上一条条件之后没有任何求值时，VM 状态未变，其末态快照即本条起点；连续的 WI 条件每条只取一次快照。
    const cached = this.conditionSnapshot
    const before = cached && cached.epoch === this.vmEpoch ? cached.state : this.conditionState()
    const result = this.evalCondition(expression)
    const after = this.conditionState()
    if (after !== before) throw new Error('@@if 条件必须只读，不能修改变量')
    this.conditionSnapshot = { epoch: this.vmEpoch, state: after }
    return result === 'true'
  }
  dispose(): void { this.vm.dispose() }
}
