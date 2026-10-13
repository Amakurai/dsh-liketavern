/** 第三方正则/WI/提示词在有内存和时间上限的 worker 内执行；最多保留两个空闲 worker，活沙箱仅供精确日志的单次续接。 */
import { Worker } from 'node:worker_threads'
import type { ComputeJobs } from './computeWorker.js'
import { measureTemplateJson, templateExecutionBudget, type TemplateExecutionBudget } from '../core/templateBudget.js'
import { measureTemplateReplayWork } from '../core/templateReplay.js'
import { templateWorkerCacheKey } from './templateWorkerCache.js'

let active = 0, requestSerial = 0, workersStarted = 0, cacheHits = 0
const waiting: Array<() => void> = []
const IDLE_MS = 60_000
const CACHED_IDLE_MS = 5 * 60_000
interface WorkerSlot {
  worker:Worker
  memoryMb:number
  busy:boolean
  retired:boolean
  lastUsed:number
  cacheKey?:string
  idleTimer?:ReturnType<typeof setTimeout>
}
const pool = new Set<WorkerSlot>()

/** 只报告缓存数量，不暴露剧情内容；也供隔离与故障回归确认是否走过冷恢复。 */
export function isolatedWorkerStats():{workersStarted:number;cacheHits:number;idle:number;active:number} {
  return {workersStarted,cacheHits,idle:[...pool].filter(slot=>!slot.busy).length,active}
}

async function retire(slot:WorkerSlot):Promise<void> {
  if(slot.retired)return
  slot.retired=true
  clearTimeout(slot.idleTimer)
  pool.delete(slot)
  await slot.worker.terminate()
}

/** 可显式释放空闲计算资源；正在运行的任务仍由各自期限管理。 */
export async function disposeIdleComputeWorkers():Promise<void> {
  await Promise.all([...pool].filter(slot=>!slot.busy).map(retire))
}

function startWorker(memoryMb:number):WorkerSlot {
  const sourceMode = import.meta.url.endsWith('.ts')
  const entry = new URL(sourceMode ? './computeWorker.ts' : './computeWorker.js', import.meta.url).href
  // 源码测试仅映射本源码树相对导入；交付 worker 只加载 lib。
  const bootstrap = sourceMode ? `
    const { registerHooks } = require('node:module');
    const { workerData } = require('node:worker_threads');
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(workerData.sourceRoot)) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      return next(specifier, context);
    }});
    import(workerData.entry);
  ` : `import(require('node:worker_threads').workerData.entry);`
  const worker=new Worker(bootstrap,{eval:true,workerData:{entry,sourceRoot:new URL('../',import.meta.url).href},
    resourceLimits:{maxOldGenerationSizeMb:memoryMb,stackSizeMb:4}})
  const slot:WorkerSlot={worker,memoryMb,busy:true,retired:false,lastUsed:performance.now()}
  // 空闲期间意外退出也要失效；任务期间的监听器负责向调用者返回错误。
  const invalid=()=>{slot.retired=true;clearTimeout(slot.idleTimer);pool.delete(slot)}
  worker.on('error',invalid)
  worker.on('exit',invalid)
  pool.add(slot)
  workersStarted++
  return slot
}

async function acquireWorker(memoryMb:number,key?:string):Promise<WorkerSlot> {
  const idle=[...pool].filter(slot=>!slot.busy&&!slot.retired).sort((a,b)=>a.lastUsed-b.lastUsed)
  let slot=idle.find(item=>item.memoryMb>=memoryMb&&key!==undefined&&item.cacheKey===key)
    ?? idle.find(item=>item.memoryMb>=memoryMb)
  if(!slot) {
    if(idle[0])await retire(idle[0])
    // V8 配额采用固定档位，避免历史每增长几个字节就丢掉缓存；单任务 QuickJS/输入/时间预算保持原值。
    slot=startWorker([128,256,512,1024,1536].find(value=>value>=memoryMb) ?? memoryMb)
  }
  clearTimeout(slot.idleTimer)
  slot.busy=true
  slot.worker.ref()
  return slot
}

function releaseWorker(slot:WorkerSlot):void {
  if(slot.retired)return
  slot.busy=false
  slot.lastUsed=performance.now()
  // 长思考回复通常超过一分钟；仅有可续接 VM 的 worker 保留五分钟，仍受两个实例的总数限制。
  slot.idleTimer=setTimeout(()=>{void retire(slot)},slot.cacheKey ? CACHED_IDLE_MS : IDLE_MS)
  slot.idleTimer.unref()
  slot.worker.unref()
}

function compute<K extends keyof ComputeJobs>(slot:WorkerSlot,kind:K,input:ComputeJobs[K]['input'],budget:TemplateExecutionBudget):Promise<ComputeJobs[K]['output']> {
  const id=++requestSerial
  return new Promise((resolve,reject)=> {
    const worker=slot.worker
    let settled=false
    const remaining={loading:10_000,computing:budget.computingMs}
    let phase:'loading'|'computing'='loading',phaseStarted=performance.now()
    let timer:ReturnType<typeof setTimeout>
    const finish=(error?:Error,value?:ComputeJobs[K]['output'])=> {
      if(settled)return
      settled=true
      clearTimeout(timer)
      worker.off('message',onMessage)
      worker.off('error',onError)
      worker.off('exit',onExit)
      if(error)void retire(slot).then(()=>reject(error),reject)
      else resolve(value!)
    }
    const expired=()=>finish(new Error(phase==='loading'?'提示词 worker 启动或装载超时':'第三方正则或提示词计算超时，已终止 worker'))
    const onError=(error:Error)=>finish(error)
    const onExit=(code:number)=>finish(new Error(`提示词 worker 提前退出：${code}`))
    const onMessage=(message:{id?:number;loading?:boolean;computing?:boolean;error?:string;value?:ComputeJobs[K]['output'];cacheKey?:string;cacheHit?:boolean})=> {
      if(settled||message.id!==id)return
      if(message.loading||message.computing) {
        const next=message.computing?'computing':'loading'
        if(next===phase)return
        const now=performance.now()
        remaining[phase]-=now-phaseStarted
        clearTimeout(timer)
        if(remaining[phase]<=0){expired();return}
        phase=next;phaseStarted=now
        timer=setTimeout(expired,remaining[phase])
      } else if(message.error)finish(new Error(message.error))
      else {
        slot.cacheKey=message.cacheKey
        if(message.cacheHit)cacheHits++
        finish(undefined,message.value)
      }
    }
    timer=setTimeout(expired,remaining.loading)
    worker.on('message',onMessage)
    worker.on('error',onError)
    worker.on('exit',onExit)
    try {worker.postMessage({id,kind,input,budget})} catch(error) {finish(error instanceof Error?error:new Error(String(error)))}
  })
}

export async function isolated<K extends keyof ComputeJobs>(kind: K, input: ComputeJobs[K]['input'], timeoutMs?: number): Promise<ComputeJobs[K]['output']> {
  const inputChars = measureTemplateJson(input)
  const replayWork = 'replay' in input && input.replay ? measureTemplateReplayWork(input.replay) : 0
  const continuationWork = 'templateContinuation' in input && input.templateContinuation?.replay
    ? measureTemplateReplayWork(input.templateContinuation.replay) : 0
  const budget = templateExecutionBudget(Math.max(inputChars, replayWork, continuationWork), timeoutMs)
  const replay='replay' in input ? input.replay : 'templateContinuation' in input ? input.templateContinuation?.replay : undefined
  const context='context' in input ? input.context : 'templates' in input ? input.templates : undefined
  const key=templateWorkerCacheKey(replay,context)
  if (active >= 2) {
    if (waiting.length >= 16) throw new Error('提示词计算队列已满，请稍后重试')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else active++
  let slot:WorkerSlot|undefined
  try {
    slot=await acquireWorker(budget.workerMemoryMb,key)
    return await compute(slot,kind,input,budget)
  } finally {
    if(slot)releaseWorker(slot)
    const next=waiting.shift()
    if(next)next()
    else active--
  }
}
