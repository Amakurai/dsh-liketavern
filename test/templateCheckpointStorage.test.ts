/** 持久检查点跨真实文件系统与 WAL 恢复：真实 QuickJS 闭包映像在冷启动、楼层回退和独立分支中保持计数，损坏恢复不能写进度。 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { templateReplayLatestContext, type TemplateReplayCheckpoint } from '../src/core/templateReplay.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { disposeIdleComputeWorkers, isolated } from '../src/node/isolated.js'
import { loadTemplateState, saveTemplateState, TEMPLATE_STATE_PATH, type TemplateState } from '../src/state/template.js'
import { TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import { openLedger } from '../src/state/writeLedger.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const roots:string[]=[]
const QUERIES=96
let factory:TemplateState

/** define 与长期正则共享同一个 let；检查点必须保存真实词法环境，变量 JSON 没有这份计数。 */
function request():ComputeJobs['assemble']['input'] {
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>['main','chatHistory'].includes(entry.identifier))
  preset.entries.find(entry=>entry.identifier==='main')!.content=`<%
    if(!getGlobalVar('registered')) {
      setGlobalVar('registered',true);let count=0;
      define('next',()=>String(++count));
      activateRegex(/T[O]KEN/g,()=>String(++count),{uuid:'shared-counter',message:true,sticky:10000});
    }
  %>ROOT`
  const history=[{role:'user' as const,content:'工厂消息'}]
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries:[],presets:preset.entries,
    history,historyIdentities:[{messageId:'user',swipeId:0}],messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,phase:'generate',
    sessionId:'checkpoint-storage',cardId:'factory-card'}
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},templates}
}

function checkpoint(state:TemplateState):TemplateReplayCheckpoint {
  const result=state.continuation?.replay?.checkpoint
  if(!result)throw new Error('工厂没有产生真实检查点')
  return result
}

/** 每次真实求值留下 message/render/outlets 等操作，96 次足以跨越 256 操作的检查点间隔。 */
async function advance(state:TemplateState,count=QUERIES,sessionId?:string) {
  const replay=state.continuation?.replay
  if(!replay)throw new Error('工厂缺少跨轮执行日志')
  const {replay:_replay,...continuation}=state.continuation!
  const context:TemplateContext={...templateReplayLatestContext(replay),phase:'generate',variables:state.variables,messageVariables:state.messageVariables,
    ...(sessionId===undefined ? {} : {sessionId})}
  const result=await isolated('template',{texts:Array.from({length:count},()=>'<%- next() %>'),context,replay,templateContinuation:continuation})
  const next:TemplateState={version:1,variables:result.variables,messageVariables:result.messageVariables,continuation:result.templateContinuation,outputs:{}}
  return {state:next,texts:result.texts}
}

async function probe(state:TemplateState):Promise<string[]> {
  const replay=state.continuation?.replay
  if(!replay)throw new Error('工厂缺少跨轮执行日志')
  const {replay:_replay,...continuation}=state.continuation!
  const previous=templateReplayLatestContext(replay),index=previous.history.length,text='TOKEN TOKEN'
  const context:TemplateContext={...previous,phase:'render',variables:state.variables,messageVariables:state.messageVariables,
    history:[...previous.history,{role:'assistant',content:text}],historyIdentities:[...previous.historyIdentities!,{messageId:'probe',swipeId:0}],
    renderMessages:[{index,role:'assistant',swipeId:0}]}
  return (await isolated('template',{texts:[text],context,replay,templateContinuation:continuation,decorateOutput:true})).texts
}

/** 冷恢复后直接询问 VM 的公开 chatId；不能只凭 TypeScript 外层的上下文元数据判断分支已接管。 */
async function session(state:TemplateState):Promise<string[]> {
  const replay=state.continuation?.replay
  if(!replay)throw new Error('工厂缺少跨轮执行日志')
  const {replay:_replay,...continuation}=state.continuation!
  const context:TemplateContext={...templateReplayLatestContext(replay),phase:'generate',variables:state.variables,messageVariables:state.messageVariables}
  return (await isolated('template',{texts:['<%- chatId %>'],context,replay,templateContinuation:continuation})).texts
}

beforeAll(async()=> {
  await disposeIdleComputeWorkers()
  const input=request(),first=await isolated('assemble',input)
  const state:TemplateState={version:1,variables:first.templateVariables!,messageVariables:first.templateMessageVariables,outputs:{},
    continuation:{...first.templateContinuation!,replay:first.templateReplay!}}
  const generated=await advance(state)
  expect(generated.texts).toEqual(Array.from({length:QUERIES},(_,index)=>String(index+1)))
  expect(JSON.stringify(checkpoint(generated.state).image.payload).length).toBeGreaterThan(1000)
  expect(generated.state.continuation!.replay!.operations.length).toBeLessThan(256)
  factory=generated.state
  await disposeIdleComputeWorkers()
},60000)

afterEach(async()=> {
  await disposeIdleComputeWorkers()
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})
})

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-checkpoint-storage-'));roots.push(root)
  const wal=new Wal(join(root,'state/wal')),fs=new WorkspaceFs(root,wal)
  return {root,wal,fs}
}

async function commit(fs:WorkspaceFs,wal:Wal,floor:string,state:TemplateState):Promise<void> {
  await wal.beginFloor(floor)
  await saveTemplateState(fs.withFloor(floor),state)
  await wal.commitFloor(floor)
}

async function cold(fs:WorkspaceFs):Promise<TemplateState> {
  openLedger(fs.root).epoch++
  await disposeIdleComputeWorkers()
  return loadTemplateState(new WorkspaceFs(fs.root,null))
}

/** 比较真实文件字节而非内存变量，包括 WAL 清单、楼层元数据、日志和正文块。 */
async function disk(fs:WorkspaceFs):Promise<Record<string,string>> {
  const entries=await Promise.all((await fs.list()).map(async path=>[path,createHash('sha256').update((await fs.readText(path))!).digest('hex')] as const))
  return Object.fromEntries(entries.sort(([left],[right])=>left.localeCompare(right)))
}

it('检查点保存后可冷恢复，更新楼层回滚后恢复旧堆，copyFrom 分支推进不改变来源剧情',async()=> {
  const source=await fixture()
  await commit(source.fs,source.wal,'story#t1',factory)
  const firstRoot=await source.fs.readText(TEMPLATE_STATE_PATH),first=await cold(source.fs)
  const initialBlocks=new Set(await source.fs.list(TEMPLATE_DATA_PATH))
  expect(checkpoint(first).image.memoryHash).toBe(checkpoint(factory).image.memoryHash)
  expect(await probe(first)).toEqual(['97 98'])

  const updated=await advance(await cold(source.fs))
  expect(updated.texts[0]).toBe('97');expect(updated.texts.at(-1)).toBe('192')
  expect(checkpoint(updated.state).image.memoryHash).not.toBe(checkpoint(first).image.memoryHash)
  await commit(source.fs,source.wal,'story#t2',updated.state)
  const nextBlocks=new Set(await source.fs.list(TEMPLATE_DATA_PATH))
  const oldPages=checkpoint(first).image.payload,newPages=checkpoint(updated.state).image.payload
  const reused=new Set(oldPages.flatMap((page,index)=> {
    if(page!==newPages[index] || Buffer.byteLength(JSON.stringify(page))<=2048)return []
    const hash=createHash('sha256').update(JSON.stringify(['json',JSON.stringify(page)])).digest('hex')
    return [`${hash.slice(0,2)}/${hash}.json`]
  }))
  expect(reused.size).toBeGreaterThan(0)
  const secondWal=(await source.fs.readText('state/wal/story_t2/records.jsonl'))!
  for(const page of reused) {
    expect(initialBlocks.has(page)).toBe(true);expect(nextBlocks.has(page)).toBe(true)
    expect(secondWal).not.toContain(`${TEMPLATE_DATA_PATH}/${page}`)
  }
  expect(await probe(await cold(source.fs))).toEqual(['193 194'])

  await source.wal.rollbackFloor('story#t2',source.root)
  expect(await source.fs.readText(TEMPLATE_STATE_PATH)).toBe(firstRoot)
  expect(await probe(await cold(source.fs))).toEqual(['97 98'])

  const branch=await fixture()
  await branch.fs.copyFrom(source.fs,await source.fs.list(),path=>new Error(`工厂分支不能复制 ${path}`))
  const original=await disk(source.fs),branchSession='checkpoint-storage-branch'
  const continued=await advance(await cold(branch.fs),QUERIES,branchSession)
  expect(continued.texts[0]).toBe('97');expect(continued.texts.at(-1)).toBe('192')
  expect(continued.state.continuation!.replay!.context.sessionId).toBe(branchSession)
  expect(checkpoint(continued.state).context.sessionId).toBe(branchSession)
  await commit(branch.fs,branch.wal,'branch#t2',continued.state)
  expect(await disk(source.fs)).toEqual(original)
  expect(await session(await cold(branch.fs))).toEqual([branchSession])
  expect(await probe(await cold(branch.fs))).toEqual(['193 194'])
  expect(await session(await cold(source.fs))).toEqual(['checkpoint-storage'])
  expect(await probe(await cold(source.fs))).toEqual(['97 98'])
},60000)

it('损坏的检查点头、运行时指纹、内存摘要、压缩正文或句柄明确拒绝，根与 WAL 不推进',async()=> {
  const {fs,wal}=await fixture()
  await commit(fs,wal,'story#t1',factory)
  await wal.beginFloor('story#t2')
  const cases:Array<{name:string;mutate:(value:TemplateReplayCheckpoint)=>void;error:RegExp}>=[
    {name:'header',mutate:value=>{Object.assign(value.image,{version:99})},error:/检查点引擎版本不兼容/},
    {name:'runtime',mutate:value=>{value.runtimeHash='0'.repeat(64)},error:/检查点运行时不兼容/},
    {name:'memory',mutate:value=>{value.image.memoryHash='0'.repeat(64)},error:/检查点内存正文与摘要不一致/},
    {name:'payload',mutate:value=>{
      const corrupt=Buffer.from('corrupt heap payload').toString('base64')
      if(Array.isArray(value.image.payload))value.image.payload[0]=corrupt
      else Object.assign(value.image,{payload:corrupt})
    },error:/检查点.*解压失败/},
    {name:'handles',mutate:value=>{value.image.handles.runtime+=4},error:/检查点句柄与当前引擎不兼容/},
  ]
  for(const item of cases) {
    const broken=structuredClone(factory);item.mutate(checkpoint(broken))
    // 明确模拟磁盘损坏：只有测试工厂绕过保存校验，业务恢复本身始终只走公开加载和隔离器。
    await fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(broken))
    const before=await disk(fs)
    const resume=async()=> {
      const restored=await cold(fs),result=await advance(restored,1)
      await saveTemplateState(fs.withFloor('story#t2'),result.state)
    }
    await expect(resume(),item.name).rejects.toThrow(item.error)
    expect(await disk(fs),item.name).toEqual(before)
  }
  // 修复被模拟损坏的根后原检查点仍可恢复，没有哪一次失败偷偷消耗共享计数。
  await fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(factory))
  expect(await probe(await cold(fs))).toEqual(['97 98'])
},60000)
