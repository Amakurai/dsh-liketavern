/** 生成恢复正文的独立存放：真实剧情/WAL 与隔离 worker，验证不进分块历史与楼层日志、重启恢复、收口清理、回滚、分支继承与损坏拒绝。 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateGeneration, loadTemplateGenerationIdentity, loadTemplateMetadata, loadTemplateState, loadTemplateTimers, selectTemplateOutputs,
  saveTemplateMetadata, saveTemplateState, saveTemplateTimers, templateTextHash, TEMPLATE_GENERATION_PATH, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import * as templateStorage from '../src/state/templateStorage.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { openLedger } from '../src/state/writeLedger.js'
import { newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
/** 等同于进程重启：丢弃内存里关于磁盘内容的全部结论。 */
const forget=(root:string)=>{openLedger(root).epoch++}
const MARKER='冻结计划专用标记'
// 冻结计划远大于内联上限：闭包供回复阶段调用，标记只出现在本轮的计划与重放里。
const script=`<% const prefix='frozen'; let n=0; define('next',()=>prefix+(++n)); incvar('runs') %>${MARKER}`+'设定正文'.repeat(30000)
function ending(text='<%- next() %>/<%- next() %>',reason='completed',finish='stop'):Pick<Session,'id'|'snapshotEvents'> {
  return {id:'s1' as Session['id'],snapshotEvents:()=>[
    {type:'turn/start',seq:0,time:0,data:{turn:1}},
    {type:'assistant/message',seq:5,time:0,data:{stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:finish}}}],turn:1,step:1,message:createAssistantMessage({source:{provider:'factory',model:'factory'},content:[{type:'text',text}]})}},
    {type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:reason}}},
  ] as unknown as SessionEvent[]}
}
async function setup(description=script) {
  const root=await mkdtemp(join(tmpdir(),'tavern-generation-body-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh=async()=>{const next=new TavernState(paths,()=>resolveConfig({}));await next.init();return next}
  const state=await fresh()
  const card=parseJsonCard({name:'Alice',description})
  const {cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  await onTurnStart(state,'s1',1)
  const run=(runtime=state)=>runTavernPipeline({state:runtime,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'hello'}]})
  const bodies=()=>readdir(join(ws.fs.root,TEMPLATE_GENERATION_PATH)).catch(()=>[] as string[])
  return {paths,state,cardId,binding,ws,run,fresh,bodies}
}
async function diskText(fs:WorkspaceFs,directory:string):Promise<string> {
  let text=''
  for(const file of await fs.list(directory)) text+=await fs.readText(`${directory}/${file}`)
  return text
}

/** 第一楼产生分块回复，第二楼挂上同样的恢复计划；计量只关注根引用清理，不再调用模型或宿主。 */
async function nextPrepared() {
  const fixture=await setup(),{state,ws,run}=fixture
  await run()
  const original=(await loadTemplateState(ws.fs)).generation
  if(original?.status!=='prepared') throw new Error('缺少工厂生成计划')
  await onTurnEnd(state,'s1',ending('第一楼正文'.repeat(12000)))
  const previousRoot=(await ws.fs.readText(TEMPLATE_STATE_PATH))!
  const completed=await loadTemplateState(ws.fs),floor=ws.fs.withFloor('s1#t2')
  await ws.wal.beginFloor('s1#t2')
  await saveTemplateState(floor,{...completed,generation:{...original,turn:2,floor:'s1#t2'}})
  return {...fixture,previousRoot,floor,close:()=>saveTemplateState(floor,{...completed,
    generation:{version:1,status:'completed',sessionId:original.sessionId,cardId:original.cardId,storyId:original.storyId,turn:2,floor:'s1#t2'}})}
}

describe('生成恢复正文',()=> {
  it('大型冻结计划只写一份正文，不进入数据块与楼层日志；重启后凭它恢复闭包，收口即清理',async()=> {
    const {ws,run,fresh,bodies}=await setup()
    await run()
    const [body]=await bodies()
    expect(await bodies()).toHaveLength(1)
    expect(body).toMatch(/^s1_t1\.[a-f0-9]{64}\.json$/)
    const bodyText=(await ws.fs.readText(`${TEMPLATE_GENERATION_PATH}/${body}`))!
    expect(bodyText).toContain(MARKER)
    expect(bodyText.length).toBeGreaterThan(200_000)
    // 根只留归属与摘要；计划正文既不在分块历史里，也没有被写进本层日志。
    expect((await ws.fs.stat(TEMPLATE_STATE_PATH))!.size).toBeLessThan(4096)
    expect(await diskText(ws.fs,TEMPLATE_DATA_PATH)).not.toContain(MARKER)
    const log=(await ws.fs.readText('state/wal/s1_t1/records.jsonl'))!
    expect(log).not.toContain(MARKER)
    expect(log.length).toBeLessThan(bodyText.length/10)
    for(const path of [`${TEMPLATE_GENERATION_PATH}/${body}`,'STATE/./TEMPLATE-GENERATION/x.json']) expect(resolveReadableAssetPath(path).ok).toBe(false)
    forget(ws.fs.root)
    const stored=await loadTemplateState(ws.fs)
    if(stored.generation?.status!=='prepared') throw new Error('缺少工厂生成计划')
    expect(stored.generation.plan.standing+stored.generation.plan.turnContext).toContain(MARKER)
    expect(stored.generation.floor).toBe('s1#t1')
    await onTurnEnd(await fresh(),'s1',ending())
    const closed=await loadTemplateState(ws.fs)
    expect(closed.outputs['5']?.text).toBe('frozen1/frozen2')
    const selected=await selectTemplateOutputs(ws.fs,outputs=>outputs['5'])
    expect(selected).toEqual(closed.outputs['5'])
    selected!.text='只改变调用方副本'
    expect((await selectTemplateOutputs(ws.fs,outputs=>outputs['5']?.text))).toBe('frozen1/frozen2')
    expect(closed.generation?.status).toBe('completed')
    expect(closed.variables.message.runs).toBe(1)
    expect(await bodies()).toEqual([])
    expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(true)
  },30000)

  it('小状态仍整份内联，不创建正文目录',async()=> {
    const {ws,run,bodies}=await setup(`<% define('next',()=>'small') %>短设定`)
    await run()
    expect(await bodies()).toEqual([])
    const raw=JSON.parse((await ws.fs.readText(TEMPLATE_STATE_PATH))!) as {generation:{status:string;replay?:unknown;payload?:unknown}}
    expect(raw.generation.status).toBe('prepared')
    expect(raw.generation.replay).toBeDefined()
    expect(raw.generation.payload).toBeUndefined()
  })

  it('楼层外维护留下的 prepared 根可由回滚保留，收口不删除它仍引用的恢复正文',async()=> {
    const {state,ws,run,bodies}=await setup()
    await run()
    const initial=await loadTemplateState(ws.fs)
    expect(initial.wiTimers).toHaveProperty('s1')
    const timers={stickyLeft:{manuallyPinned:7},cooldownLeft:{}}
    await saveTemplateTimers(ws.fs.withFloor(null),'s1',timers)
    const maintained=await loadTemplateState(ws.fs)
    expect((await bodies()).length).toBeGreaterThanOrEqual(1)
    await onTurnEnd(state,'s1',ending())
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('completed')
    expect(await bodies()).toHaveLength(1)
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    forget(ws.fs.root)
    expect(await loadTemplateState(ws.fs)).toEqual(maintained)
    expect(await loadTemplateTimers(ws.fs,'s1')).toEqual(timers)
  },30000)

  it('元数据与定时器独立读取，不复制历史回复；归属判断不依赖生成正文，完整恢复仍核对正文',async()=> {
    const {ws,run,bodies}=await setup()
    await run()
    const full=await loadTemplateState(ws.fs),metadata=await loadTemplateMetadata(ws.fs)
    const {outputs:_outputs,...expected}=full
    expect(metadata).toEqual(expected)
    expect(metadata).not.toHaveProperty('outputs')
    metadata.variables.message.changed=true
    expect((await loadTemplateState(ws.fs)).variables.message).not.toHaveProperty('changed')
    expect(await loadTemplateGeneration(ws.fs)).toEqual(full.generation)
    const identity=await loadTemplateGenerationIdentity(ws.fs)
    expect(identity).toMatchObject({floor:'s1#t1',status:'prepared'})
    expect(identity).not.toHaveProperty('replay')
    expect(identity).not.toHaveProperty('plan')
    const timers=await loadTemplateTimers(ws.fs,'s1')
    timers.stickyLeft.extra=4
    expect((await loadTemplateTimers(ws.fs,'s1')).stickyLeft).not.toHaveProperty('extra')
    await ws.fs.withFloor(null).delete(`${TEMPLATE_GENERATION_PATH}/${(await bodies())[0]}`)
    forget(ws.fs.root)
    expect(await loadTemplateGenerationIdentity(ws.fs)).toEqual(identity)
    expect(await loadTemplateTimers(ws.fs,'s1')).toEqual(full.wiTimers?.s1)
    await expect(loadTemplateGeneration(ws.fs)).rejects.toThrow(/恢复数据缺失/)
    await expect(loadTemplateMetadata(ws.fs)).rejects.toThrow(/恢复数据缺失/)
  },30000)

  it('只写元数据时合并锁内最新回复，读取元数据后发布的新快照不会被旧视图覆盖',async()=> {
    const {ws,run}=await setup()
    await run()
    const metadata=await loadTemplateMetadata(ws.fs),floor=ws.fs.withFloor('s1#t1')
    const latest=await loadTemplateState(ws.fs),text='元数据读取以后提交的回复'
    latest.outputs['70']={hash:templateTextHash(text),text}
    await saveTemplateState(floor,latest)
    const wiTimers={s1:{stickyLeft:{fresh:3},cooldownLeft:{}}}
    await saveTemplateMetadata(floor,{...metadata,wiTimers})
    forget(ws.fs.root)
    const after=await loadTemplateState(ws.fs)
    expect(after.outputs['70']).toEqual(latest.outputs['70'])
    expect(after.wiTimers).toEqual(wiTimers)
    expect(after.generation).toEqual(metadata.generation)
    await expect(saveTemplateMetadata(ws.fs.withFloor(null),metadata)).rejects.toThrow(/需要已开启/)
  },30000)

  it('已验证根只缓存正文身份，正常收口无需重新展开整份旧回复',async()=> {
    const {ws,close,bodies}=await nextPrepared()
    const read=vi.spyOn(templateStorage,'readTemplateDocumentText')
    await close()
    expect(read).not.toHaveBeenCalled()
    expect(await bodies()).toEqual([])
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('completed')
  },30000)

  it.each(['epoch','root','block'] as const)('正文引用缓存遇到 %s 变更后重新验证历史根，不能沿用旧结论',async mode=> {
    const {ws,close,bodies,previousRoot}=await nextPrepared(),plain=ws.fs.withFloor(null)
    if(mode==='epoch') forget(ws.fs.root)
    if(mode==='root') await plain.writeText(TEMPLATE_STATE_PATH,(await plain.readText(TEMPLATE_STATE_PATH))!)
    if(mode==='block') {
      // 破坏第一楼的历史根块；它已不是当前根的可达块，不能靠保存当前状态顺手修复。
      const hash=(JSON.parse(previousRoot) as {root:string}).root
      await plain.writeText(`${TEMPLATE_DATA_PATH}/${hash.slice(0,2)}/${hash}.json`,'[]')
    }
    const read=vi.spyOn(templateStorage,'readTemplateDocumentText')
    await close()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[1]).toBe(previousRoot)
    // 历史根损坏时只停止清理，不能删除未经核对的正文或把已经完成的提交改报失败。
    expect(await bodies()).toHaveLength(mode==='block'?1:0)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('completed')
  },30000)

  it('正文被改写、截断或删除时读取明确失败，原样恢复后可继续',async()=> {
    const {ws,run,bodies}=await setup()
    await run()
    const path=`${TEMPLATE_GENERATION_PATH}/${(await bodies())[0]}`,plain=new WorkspaceFs(ws.fs.root,null),original=(await plain.readText(path))!
    // 等长改写：体积不变，只有内容摘要能发现。
    const tampered=original.replace(MARKER,'被改写的等长标记')
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original))
    await plain.writeText(path,tampered)
    await expect(loadTemplateState(ws.fs)).rejects.toThrow(/恢复数据校验失败/)
    await plain.writeText(path,original.slice(0,-1))
    await expect(loadTemplateState(ws.fs)).rejects.toThrow(/恢复数据校验失败/)
    await plain.delete(path)
    await expect(loadTemplateState(ws.fs)).rejects.toThrow(/恢复数据缺失/)
    await plain.writeText(path,original)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')
  },30000)

  it('回滚未结束的楼层后状态可读；同一楼层重新生成时清掉上次留下的正文',async()=> {
    const {state,ws,run,bodies}=await setup()
    await run()
    const [first]=await bodies()
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect((await loadTemplateState(ws.fs)).generation).toBeUndefined()
    // 回滚只恢复根；不再被引用的正文留到这一层下次写入时清理。
    expect(await bodies()).toEqual([first])
    state.openFloors.delete('s1');state.turnPlans.delete('s1');state.pendingTurnPlans.delete('s1');state.currentTurns.delete('s1')
    await onTurnStart(state,'s1',1)
    await run()
    const again=await bodies()
    expect(again).toHaveLength(1)
    expect(again[0]).not.toBe(first)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
  },30000)

  it('分支继承未结束记录的正文；子剧情自己的楼层不清理它，回退后仍能读回继承的状态',async()=> {
    const {paths,ws,run,cardId}=await setup()
    await run()
    const id=newStoryId(),cardRoot=join(paths.characters,cardId)
    await snapshotStory({cardRoot,sourceRoot:ws.fs.root,id,sessionId:'child',includeWal:true})
    const childRoot=storyRoot(cardRoot,id),wal=new Wal(join(childRoot,'state/wal')),child=new WorkspaceFs(childRoot,wal)
    const inherited=await loadTemplateState(child)
    if(inherited.generation?.status!=='prepared') throw new Error('子剧情缺少继承的生成计划')
    expect(inherited.generation.sessionId).toBe('s1')
    const files=await readdir(join(childRoot,TEMPLATE_GENERATION_PATH))
    expect(files).toHaveLength(1)
    // 子剧情在自己的楼层用回执替换掉继承的记录。
    await wal.beginFloor('child#t2')
    await saveTemplateState(child.withFloor('child#t2'),{...inherited,generation:{version:1,status:'terminated',sessionId:'child',cardId:inherited.generation.cardId,
      storyId:inherited.generation.storyId,turn:2,floor:'child#t2'}})
    await wal.commitFloor('child#t2')
    expect(await readdir(join(childRoot,TEMPLATE_GENERATION_PATH))).toEqual(files)
    await wal.rollbackFloor('child#t2',childRoot)
    forget(childRoot)
    expect(await loadTemplateState(child)).toEqual(inherited)
    // 来源剧情不受子剧情影响。
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')
  },30000)
})
