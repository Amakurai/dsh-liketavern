/** EJS 在 QuickJS/WASM 中执行；不向脚本提供 Node、网络、DOM、宿主函数或模块加载器。 */
import type { QuickJSContext } from 'quickjs-emscripten'
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

let templateLibrarySource: string | undefined
let templateFakerSource: string | undefined
let templateRuntimeHash: string | undefined
/** 仅供 worker 编排计时，不暴露给 QuickJS 脚本。 */
let computationPhase: ((phase: 'loading' | 'computing') => void) | undefined

export class TemplateSandbox {
  private readonly renderedSources = new Map<string, string>()
  private readonly vm: QuickJSContext
  private readonly owner:Awaited<ReturnType<typeof createTemplateCheckpointVm>>
  private readonly runtimeIdentity:TemplateRuntimeIdentity
  private deadline: number
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
  private constructor(owner:Awaited<ReturnType<typeof createTemplateCheckpointVm>>, deadline: number, resourceChars:number,outputInputChars:number,runtimeIdentity:TemplateRuntimeIdentity) {
    this.owner=owner;this.vm = owner.vm;this.deadline=deadline;this.resourceChars=resourceChars;this.outputInputChars=outputInputChars
    this.runtimeIdentity=runtimeIdentity
  }
  /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
  static async prepare(onPhase?: (phase: 'loading' | 'computing') => void): Promise<void> {
    computationPhase = onPhase
    const [,runtime]=await Promise.all([prepareTemplateCheckpointVm(),loadTemplateRuntime()])
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
    vm.runtime.setInterruptHandler(() => Date.now() > sandbox.deadline)
    try {
      if (!templateLibrarySource) throw new Error('模板依赖产物缺失，请先运行 npm run build')
      if (!templateFakerSource) throw new Error('Faker 模板依赖产物缺失，请先运行 npm run build')
      const fakerSourceHandle=vm.newString(templateFakerSource)
      try { vm.setProp(vm.global,'__tavernFakerSource',fakerSourceHandle) } finally { fakerSourceHandle.dispose() }
      // 大历史作为字符串值传入，避免把 JSON 再转义成源码后交给 QuickJS 解析一次。
      const inputHandle=vm.newString(JSON.stringify(input))
      try { vm.setProp(vm.global,'__input',inputHandle) } finally { inputHandle.dispose() }
      const limitHandle=vm.newNumber(contextChars+1024*1024)
      try {vm.setProp(vm.global,'__tavernOutputLimit',limitHandle)} finally {limitHandle.dispose()}
      sandbox.evaluate(BOOTSTRAP.replace('/* TEMPLATE_VENDOR */',()=>templateLibrarySource!))
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
        if(operation.kind==='render') result=sandbox.render(operation.text,data(operation),operation.source)
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
      owner.vm.runtime.setInterruptHandler(()=>Date.now()>sandbox.deadline)
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
    return JSON.parse(JSON.stringify(replay)) as TemplateReplay
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

  /** readonly 仅用于不改变沙箱状态的固定查询；其余求值都可能运行第三方代码并改动规则表。 */
  private evaluate(code: string, readonly = false): unknown {
    if (!readonly) this.regexStageEmpty.clear()
    const result = this.vm.evalCode(code)
    if (result.error) {
      const error: unknown = this.vm.dump(result.error)
      result.error.dispose()
      throw new Error(`EJS 模板失败：${JSON.stringify(error)}`)
    }
    try { return this.vm.dump(result.value) } finally { result.value.dispose() }
  }

  /** 纯 JSON 作为 QuickJS 字符串值传输，固定源码不再重复解析转义后的大历史。 */
  private evaluateInput(code:string,input:unknown,readonly=false):unknown {
    const json=JSON.stringify(input)
    if(json.length>TEMPLATE_INPUT_MAX_CHARS) throw new Error('模板调用输入超过安全资源容量')
    this.growResources(json.length)
    const handle=this.vm.newString(json)
    try {
      this.vm.setProp(this.vm.global,'__tavernCallInput',handle)
      return this.evaluate(code,readonly)
    } finally {
      this.vm.setProp(this.vm.global,'__tavernCallInput',this.vm.undefined)
      handle.dispose()
    }
  }
  private growResources(inputChars:number):void {
    if(inputChars>this.outputInputChars) {
      this.outputInputChars=inputChars
      const limitHandle=this.vm.newNumber(inputChars+1024*1024)
      try {this.vm.setProp(this.vm.global,'__tavernOutputLimit',limitHandle)} finally {limitHandle.dispose()}
      this.evaluate('templateOutputLimit=__tavernOutputLimit',true)
    }
    if(inputChars>this.resourceChars) {
      this.resourceChars=inputChars
      const budget=templateExecutionBudget(inputChars)
      this.vm.runtime.setMemoryLimit(budget.quickJsMemoryBytes)
      // 扩大输入只调整从本阶段起点算的期限，不能靠反复调用重新获得完整执行时长。
      if(this.computationStarted) this.deadline=this.computationStarted+budget.sandboxMs
    }
  }

  /** 受信装载结束后收紧到第三方计算预算；后续阶段（resume/继续轮）重置同一预算。 */
  private beginComputation(): void {
    computationPhase?.('computing')
    this.computationStarted=Date.now()
    this.deadline = this.computationStarted+templateExecutionBudget(this.resourceChars).sandboxMs
  }

  /** 精确日志命中后开始新的隔离任务；只重置执行预算，保留已验证日志所对应的词法环境。 */
  restartBudget(resourceChars:number):void {
    this.resourceChars=resourceChars
    this.vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes)
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
      this.evaluateInput('__continueTemplateGeneration(parseTemplateInput(__tavernCallInput))',normalized)
      this.renderedSources.clear()
      if(refreshPreload) this.preload(normalized)
    } else this.evaluateInput('__resumeTemplateReply(parseTemplateInput(__tavernCallInput))',normalized)
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
    return parseTemplateStickyState(JSON.parse(raw))
  }

  sticky(action:'begin'|'finish'|'restore',state?:TemplateStickyState):TemplateStickyState {
    if(action==='restore') {
      if(!state) throw new Error('sticky 恢复缺少状态')
      this.evaluate(`__restoreTemplateStickyState(${JSON.stringify(parseTemplateStickyState(state))})`)
    } else this.evaluate(action==='begin'?'__beginTemplateGeneration()':'__finishTemplateGeneration()')
    const result=this.stickyState()
    this.record({kind:'sticky',action,...(state ? {state} : {})},result)
    return result
  }

  render(text: string, data: Record<string,unknown> = {}, source?:string): string {
    this.evaluateInput(`globalThis.__done=false; globalThis.__error=null; globalThis.__result=null;
      {const call=parseTemplateInput(__tavernCallInput);
      __render(call.text,__sourceData(call.source,call.data)).then(v=>{globalThis.__result=v;globalThis.__done=true},e=>{globalThis.__error=String(e);globalThis.__done=true});} undefined;`,{text,data,source})
    while (this.vm.runtime.hasPendingJob()) {
      if (Date.now() > this.deadline) throw new Error('EJS 模板计算超时')
      const result = this.vm.runtime.executePendingJobs(1)
      if (result.error) {
        const error: unknown = this.vm.dump(result.error)
        result.error.dispose()
        throw new Error(`EJS 异步任务失败：${JSON.stringify(error)}`)
      }
    }
    if (Date.now() > this.deadline) throw new Error('EJS 模板计算超时')
    if (!this.evaluate('__done')) throw new Error('EJS 异步任务未完成（不允许外部 I/O）')
    const error = this.evaluate('__error')
    if (error) throw new Error(`EJS 模板失败：${String(error)}`)
    const value = this.evaluate('__result')
    if (typeof value !== 'string' || value.length > this.outputInputChars+1024*1024) throw new Error('EJS 输出无效或净增超过 1 MiB 上限')
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
    return JSON.parse(raw) as Array<{key:string;force:boolean}>
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
    const result = this.evaluate(`__applyTemporaryRegex(${JSON.stringify(text)},${JSON.stringify(stage)},${JSON.stringify(meta)})`)
    if (typeof result !== 'string') throw new Error('临时正则返回值无效')
    this.record({kind:'regex',text,stage,meta},result)
    return result
  }
  transformRegexSources(parts:TemplateRegexSource[],stage:'basic'|'generate'|'message'|'after',meta:{role:string;worldinfo:boolean;depth:number},cacheNamespace:string):TemplateRegexSource[] {
    if(typeof cacheNamespace!=='string' || cacheNamespace.length>4096) throw new Error('正则来源命名空间无效或超限')
    parseTemplateReplayRegexParts(parts)
    if(!this.hasRegexStage(stage)) return parts.map(part=>({...part}))
    const raw=this.evaluateInput('(()=>{const call=parseTemplateInput(__tavernCallInput);return __runTemporaryRegexSources(call.parts,call.stage,call.meta,call.namespace)})()',
      {parts,stage,meta,namespace:cacheNamespace})
    if(typeof raw!=='string') throw new Error('正则来源结果无效')
    const value:unknown=JSON.parse(raw)
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
    const raw=this.evaluateInput('(()=>{const call=parseTemplateInput(__tavernCallInput);return __runBasicRegexSourcesBatch(call.items,call.namespace)})()',{items,namespace:cacheNamespace})
    if(typeof raw!=='string') throw new Error('basic 正则批次结果无效')
    const value:unknown=JSON.parse(raw)
    if(!value || typeof value!=='object' || !('applied' in value) || typeof value.applied!=='boolean' || !('parts' in value)
      || !Array.isArray(value.parts) || value.parts.length!==items.length) throw new Error('basic 正则批次结果无效')
    const result=value.parts.map(parts=>parseTemplateReplayRegexParts(parts))
    if(value.applied) this.record({kind:'regexSourcesBatch',namespace:cacheNamespace,data:{items}},result)
    return result
  }
  regexDescriptors(): TemplateRegexDescriptor[] {
    const raw = this.evaluate('__regexDescriptors()')
    if (typeof raw !== 'string') throw new Error('临时正则描述无效')
    return JSON.parse(raw) as TemplateRegexDescriptor[]
  }
  hasMessageRegex(): boolean { return this.evaluate('__hasMessageRegex()') === true }

  formatMessage(text:string):string {
    const result=this.evaluateInput('__formatTemplateMessage(parseTemplateInput(__tavernCallInput))',text)
    if(typeof result!=='string' || result.length>Math.min(TEMPLATE_OUTPUT_MAX_CHARS,text.length*16+1024*1024)) throw new Error('模板消息格式化输出超过安全资源容量')
    this.record({kind:'format',text},result)
    return result
  }

  setMessageContext(metadata:TemplateMessageMetadata|null):{role:string;worldinfo:boolean;depth:number} {
    const result=this.evaluate(`__setTemplateMessageContext(${JSON.stringify(metadata)})`) as {role:string;worldinfo:boolean;depth:number}
    this.record({kind:'message',metadata},result)
    return result
  }

  setOutletsDeferred(value:boolean):void {
    this.evaluate(`__setTemplateOutletsDeferred(${JSON.stringify(value)})`)
    this.record({kind:'deferOutlets',value},null)
  }
  resolveOutlets(text:string):string {
    const result=this.evaluate(`__resolveTemplateOutlets(${JSON.stringify(text)})`)
    if(typeof result!=='string') throw new Error('模板注入出口返回无效')
    this.record({kind:'outlets',text},result)
    return result
  }

  variables(): TemplateScopes {
    const raw = this.evaluate('__export()')
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw new Error('模板变量超过 1 MiB 上限')
    const result=parseTemplateScopes(JSON.parse(raw))
    this.record({kind:'variables'},result)
    return result
  }
  messageVariables():TemplateMessageVariables {
    const raw=this.evaluate('__exportMessageVariables()')
    if(typeof raw!=='string') throw new Error('消息变量导出无效')
    const result=parseTemplateMessageVariables(JSON.parse(raw))
    this.record({kind:'messageVariables'},result)
    return result
  }
  /** 条件在 WI 预算和分组前求值；拒绝写变量，避免预选阶段产生未提交或重复副作用。 */
  condition(expression: string): boolean {
    const before = this.evaluate('__conditionState()')
    const result = this.render(`<%- Boolean(${expression}) %>`)
    if (this.evaluate('__conditionState()') !== before) throw new Error('@@if 条件必须只读，不能修改变量')
    return result === 'true'
  }
  dispose(): void { this.vm.dispose() }
}
