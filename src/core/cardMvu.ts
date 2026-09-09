/** MVU 沙箱适配：同步读取本地剧情快照，按顺序等待变量事件，显式保存沿用 CAS/WAL 回执。 */
import type {HelperMvuCommandCodec} from './helperMvuCommands.js'

/** 自包含函数注入 opaque iframe；不加载原版主窗口脚本，不自动改写正文或发起模型请求。 */
export function installCardMvu(codec:HelperMvuCommandCodec,json:(value:unknown,maxBytes?:number)=>unknown):()=>void{
  type Table=Record<string,unknown>
  const root=window as unknown as Record<string,unknown>
  let active=true,parsing=0
  const events=Object.freeze({
    VARIABLE_INITIALIZED:'mag_variable_initialized',VARIABLE_UPDATE_STARTED:'mag_variable_update_started',
    COMMAND_PARSED:'mag_command_parsed',VARIABLE_UPDATE_ENDED:'mag_variable_update_ended',
    BEFORE_MESSAGE_UPDATE:'mag_before_message_update',
  })
  const check=()=>{if(!active)throw new Error('MVU 卡面已关闭或重写')}
  function table(value:unknown):Table{
    const result=json(value)
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('MVU 数据必须是普通 JSON 对象')
    return result as Table
  }
  function data(value:unknown):Table{
    const result=table(value)
    if(!result.stat_data||typeof result.stat_data!=='object'||Array.isArray(result.stat_data))throw new Error('MVU 数据缺少 stat_data 对象')
    if(Object.hasOwn(result.stat_data,'$internal'))throw new Error('MVU 临时 $internal 数据不能保存或返回')
    return result
  }
  function supported(value:Table):void{
    if(value.schema!==undefined&&value.schema!=='没有用别管这个')throw new Error('当前 MVU 适配尚不支持 classic schema 或未知 schema；请使用 Zod 命令处理或普通变量数据')
    function walk(item:unknown):void{
      if(item==='$__META_EXTENSIBLE__$')throw new Error('当前 MVU 适配尚不支持 classic schema 元数据')
      if(!item||typeof item!=='object')return
      for(const [key,child] of Object.entries(item)){
        if(['$internal','$meta','$arrayMeta'].includes(key))throw new Error('当前 MVU 适配尚不支持 classic schema 元数据或临时字段')
        walk(child)
      }
    }
    walk(value.stat_data)
  }
  function getMvuData(option?:unknown):Table{
    check()
    return (root.getVariables as (option?:unknown)=>Table)(option)
  }
  async function replaceMvuData(value:unknown,option?:unknown):Promise<void>{
    check()
    const next=data(value)
    ;(root.replaceVariables as (value:Table,option?:unknown)=>unknown)(next,option)
    const flush=root.flushHelperVariables
    if(typeof flush==='function')await flush()
    check()
  }
  async function emit(name:string,...args:unknown[]):Promise<void>{
    check();json(args,256*1024)
    await (root.eventEmit as (name:string,...args:unknown[])=>Promise<void>)(name,...args)
    check();json(args,256*1024)
  }
  async function parseMessage(message:string,oldData:unknown):Promise<Table>{
    check()
    if(parsing>=8)throw new Error('MVU 解析超过并发预算')
    const before=data(oldData),next=data(before),commands=codec.parse(message)
    parsing++
    try{
      // Zod 扩展可在命令阶段处理并移除命令；每个异步事件的原对象修改都在下一阶段可见。
      next.display_data=table(next.stat_data);next.delta_data={}
      await emit(events.VARIABLE_UPDATE_STARTED,next)
      await emit(events.COMMAND_PARSED,next,commands,message)
      await emit('mag_command_parsed_for_zod',next,commands,message)
      await emit('mag_command_parsed_ended_for_zod',next,commands,message)
      if(commands.length){
        supported(next)
        const applied=codec.apply(table(data(next).stat_data),commands,table(next.display_data))
        Object.assign(next,applied)
      }
      await emit(events.VARIABLE_UPDATE_ENDED,next,before)
      await emit('mag_variable_update_ended_for_zod',next,before)
      // 与当前 MVU 实现一致，无命令也返回独立副本；解析本身不落盘。
      const result=data(next);supported(result)
      return result
    }finally{parsing--}
  }
  async function initialize(value:unknown,swipeId:number):Promise<Table>{
    const next=data(value)
    await emit(events.VARIABLE_INITIALIZED,next,swipeId)
    const result=data(next);supported(result)
    return result
  }
  root.__dshTavernMvuInitialize=initialize
  const mvu=Object.freeze({events,getMvuData,replaceMvuData,parseMessage,isDuringExtraAnalysis:()=>{check();return false}})
  root.Mvu=mvu
  // 原版依赖 parent.Mvu 的发布方式不适用于不透明源；内置对象在每个沙箱独立安装。
  async function waitGlobalInitialized(name:unknown):Promise<unknown>{
    check()
    if(name!=='Mvu')throw new Error('跨沙箱全局接口尚未适配：'+String(name).slice(0,128))
    return mvu
  }
  root.waitGlobalInitialized=waitGlobalInitialized
  root.TavernHelper=Object.assign(root.TavernHelper??{},{waitGlobalInitialized})
  return()=>{
    active=false
    if(root.Mvu===mvu)delete root.Mvu
    if(root.__dshTavernMvuInitialize===initialize)delete root.__dshTavernMvuInitialize
    if(root.waitGlobalInitialized===waitGlobalInitialized)delete root.waitGlobalInitialized
    const helper=root.TavernHelper as Table|undefined
    if(helper?.waitGlobalInitialized===waitGlobalInitialized)delete helper.waitGlobalInitialized
  }
}
