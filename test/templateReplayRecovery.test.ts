/** 跨阶段恢复集成：真实临时剧情/WAL、重建宿主运行时、落盘故障与分支边界，不调用模型或读取用户数据。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { completeTemplateOutput } from '../src/node/templateOutput.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState, saveTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'

const roots:string[] = []
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
function ending(text='word/<%- next() %>',sessionId='s1',finish='stop',reason='completed'):Pick<Session,'id'|'snapshotEvents'> {
  return {id:sessionId as Session['id'],snapshotEvents:()=>[
    {type:'turn/start',seq:0,time:0,data:{turn:1}},
    {type:'assistant/chunk',seq:4,time:0,data:{turn:1,step:1,chunk:{type:'finish',reason:{kind:finish}}}},
    {type:'assistant/message',seq:5,time:0,data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text}]})}},
    {type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:reason}}},
  ] as unknown as SessionEvent[]}
}
const script = `<% const prefix='frozen'; let n=0; define('next',()=>prefix+(++n)); incvar('runs'); activateRegex(/word/g,()=>next(),{message:true}) %>original`
async function setup(description=script) {
  const root = await mkdtemp(join(tmpdir(),'tavern-replay-recovery-')); roots.push(root)
  const paths = {root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh = async()=>{const next=new TavernState(paths,()=>resolveConfig({}));await next.init();return next}
  const state = await fresh()
  const card = parseJsonCard({name:'Alice',description})
  const {cardId} = await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding = (await state.loadBinding('s1'))!, ws = await state.storyWorkspace(cardId,binding.storyId)
  await state.saveTimers(cardId,'s1',{stickyLeft:{},cooldownLeft:{waiting:5}},null,binding.storyId)
  await onTurnStart(state,'s1',1)
  const run=(runtime=state)=>runTavernPipeline({state:runtime,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'hello'}]})
  return {root,paths,state,cardId,binding,ws,run,fresh}
}

describe('模板冻结计划恢复',()=> {
  it('没有变量写入的定义也持久化，重建运行时后恢复闭包并原子收口回复和 WAL',async()=> {
    const {state,ws,run,fresh,cardId} = await setup(`<% let n=0; const prefix='saved'; define('next',()=>prefix+(++n)) %>definition`)
    await run()
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')
    await state.saveCharacter(cardId,{description:'<% throw Error("new asset must not run") %>'})
    const restarted = await fresh()
    await onTurnEnd(restarted,'s1',ending('<%- next() %>/<%- next() %>'))
    const stored = await loadTemplateState(ws.fs)
    expect(stored.outputs['5']?.text).toBe('saved1/saved2')
    expect(stored.outputs['5']?.parts).toEqual([{kind:'markdown',text:'saved1/saved2'}])
    expect(stored.generation?.status).toBe('completed')
    expect(JSON.stringify(stored.generation)).not.toContain('replay')
    expect((await ws.wal.listFloors()).find(floor=>floor.floor==='s1#t1')?.committed).toBe(true)
    await onTurnEnd(await fresh(),'s1',ending('<%- next() %>/<%- next() %>'))
    expect(await loadTemplateState(ws.fs)).toEqual(stored)
  })

  it('原子提交后缓存发布失败，进程重建的后续 step 返回原字节而不读新资产重新自增',async()=> {
    const {state,ws,run,fresh,cardId,binding} = await setup()
    vi.spyOn(state,'recordTriggerLog').mockImplementationOnce(()=>{throw new Error('缓存发布前退出')})
    await expect(run()).rejects.toThrow(/缓存发布前退出/)
    const stored = await loadTemplateState(ws.fs)
    expect(stored.variables.message.runs).toBe(1)
    expect(stored.generation?.status).toBe('prepared')
    await state.saveCharacter(cardId,{description:'<% incvar("runs",100) %>new'})
    const restarted = await fresh()
    const agent = {options:{},session:{snapshotEvents:()=>[{type:'turn/start',seq:0,time:0,data:{turn:1}}],deriveMessages:()=>[]}} as unknown as Agent
    const restored = await runTavernPipeline({state:restarted,sessionId:'s1',agent,mode:'live'})
    expect(restored!.turnContext).toContain('original')
    expect(restored!.turnContext).not.toContain('new')
    expect(await run(restarted)).toBe(restored)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await restarted.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
    await onTurnEnd(restarted,'s1',ending())
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('frozen1/frozen2')
  })

  it('重复收到同 turn/start 只恢复原 WAL，不抹掉生成状态或同层工具事实',async()=> {
    const {ws,run,fresh} = await setup()
    await run()
    await ws.fs.withFloor('s1#t1').writeText('journal.md','工具事实')
    const before = await ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const restarted = await fresh()
    await onTurnStart(restarted,'s1',1)
    await run(restarted)
    expect(await ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(before)
    expect(await ws.fs.readText('journal.md')).toBe('工具事实')
  })

  it('保存回复前故障保留 prepared，重启重试不会重复提交生成增量或丢失闭包',async()=> {
    const {ws,run,fresh} = await setup()
    await run()
    const write = WorkspaceFs.prototype.writeText
    let fault = true
    vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text) {
      if (path===TEMPLATE_STATE_PATH && fault) {fault=false;throw new Error('回复持久化失败')}
      return write.call(this,path,text)
    })
    await expect(onTurnEnd(await fresh(),'s1',ending())).rejects.toThrow(/回复持久化失败/)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
    await onTurnEnd(await fresh(),'s1',ending())
    const stored = await loadTemplateState(ws.fs)
    expect(stored.outputs['5']?.text).toBe('frozen1/frozen2')
    expect(stored.variables.message.runs).toBe(1)
  })

  it('回复已替换但读回也失败时，完成回执保证重启不再执行闭包且仍提交原 WAL',async()=> {
    const {ws,run,fresh} = await setup()
    await run()
    const write = WorkspaceFs.prototype.writeText, read = WorkspaceFs.prototype.readText
    let failWrite = true, failRead = false
    vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text) {
      await write.call(this,path,text)
      if (path===TEMPLATE_STATE_PATH && failWrite) {failWrite=false;failRead=true;throw new Error('替换后故障')}
    })
    vi.spyOn(WorkspaceFs.prototype,'readText').mockImplementation(async function(path) {
      if (path===TEMPLATE_STATE_PATH && failRead) {failRead=false;throw new Error('确认读取失败')}
      return read.call(this,path)
    })
    await expect(onTurnEnd(await fresh(),'s1',ending())).rejects.toThrow(/确认读取失败/)
    const stored = await loadTemplateState(ws.fs)
    expect(stored.generation?.status).toBe('completed')
    expect(stored.outputs['5']?.text).toBe('frozen1/frozen2')
    await onTurnEnd(await fresh(),'s1',ending())
    expect(await loadTemplateState(ws.fs)).toEqual(stored)
    expect((await ws.wal.listFloors()).find(floor=>floor.floor==='s1#t1')?.committed).toBe(true)
  })

  it('模板回复失败后新宿主轮次终止旧重放，旧生成变量保留并由新层继续计算',async()=> {
    const {ws,run,fresh,cardId,binding} = await setup()
    await run()
    await expect(onTurnEnd(await fresh(),'s1',ending('<% throw Error("bad output") %>'))).rejects.toThrow(/bad output/)
    const restarted = await fresh()
    await onTurnStart(restarted,'s1',2)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('terminated')
    await run(restarted)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(2)
    expect((await restarted.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(3)
    await ws.wal.rollbackFloor('s1#t2',ws.fs.root)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('terminated')
  })

  it('目标会话与宿主结束帧不一致时不处理另一剧情',async()=> {
    const {ws,run,fresh} = await setup()
    await run()
    await expect(onTurnEnd(await fresh(),'other',ending())).rejects.toThrow(/目标会话不一致/)
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
  })

  it.each([['length','completed'],['stop','error']])('终止帧 %s/%s 不执行模板，回执阻止迟到事件再次处理',async(finish,reason)=> {
    const {ws,run,fresh} = await setup()
    await run()
    await onTurnEnd(await fresh(),'s1',ending('<% incvar("bad") %>','s1',finish,reason))
    expect((await loadTemplateState(ws.fs)).variables.message.bad).toBeUndefined()
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('terminated')
    await completeTemplateOutput(await fresh(),ending('<% incvar("bad") %>'))
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
  })

  it('已处理的回复和恢复记录都随原楼层回滚，源剧情之外的会话不能重放祖先描述',async()=> {
    const {ws,run,fresh,state,paths,cardId,binding} = await setup()
    await run()
    const id = newStoryId()
    await snapshotStory({cardRoot:join(paths.characters,cardId),sourceRoot:ws.fs.root,id,sessionId:'child',includeWal:true})
    await saveBinding(paths,{...binding,sessionId:'child',storyId:id})
    await onTurnEnd(await fresh(),'child',ending('word','child'))
    const child = await state.storyWorkspace(cardId,id)
    expect((await loadTemplateState(child.fs)).outputs).toEqual({})
    await onTurnEnd(await fresh(),'s1',ending())
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
    expect((await loadTemplateState(child.fs)).generation?.status).toBe('prepared')
  })

  it('缺少原 WAL 的恢复明确失败，不接受同会话同轮的游离描述',async()=> {
    const {ws,run,fresh} = await setup()
    await run()
    const saved = await ws.fs.readText(TEMPLATE_STATE_PATH)
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    await ws.fs.writeText(TEMPLATE_STATE_PATH,saved!)
    await expect(onTurnEnd(await fresh(),'s1',ending())).rejects.toThrow(/WAL/)
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
  })

  it('恢复前完整验证 WAL，损坏记录先于闭包重放报错且不改剧情状态',async()=> {
    const {ws,run,fresh,state} = await setup()
    await run()
    const saved = JSON.parse((await ws.fs.readText(TEMPLATE_STATE_PATH))!) as {generation:{replay:{operations:Array<{hash:string}>}}}
    saved.generation.replay.operations[0]!.hash='0'.repeat(64)
    const raw = JSON.stringify(saved)
    await ws.fs.writeText(TEMPLATE_STATE_PATH,raw)
    const walPath='state/wal/s1_t1/records.jsonl'
    await ws.fs.writeText(walPath,(await ws.fs.readText(walPath))+'{broken\n')
    await expect(completeTemplateOutput(await fresh(),ending())).rejects.toThrow(/WAL 记录损坏/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(raw)
    const restarted = await fresh()
    restarted.currentTurns.set('s1',1)
    await expect(run(restarted)).rejects.toThrow(/WAL 记录损坏/)
    expect(restarted.turnPlans.size).toBe(0)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(raw)
    await expect(onTurnEnd(state,'s1',ending())).rejects.toThrow(/WAL 记录损坏/)
    expect((await ws.wal.listFloors()).find(floor=>floor.floor==='s1#t1')?.committed).toBe(false)
  })

  it('版本、操作哈希、元数据、原型键与总状态超限在存储边界拒绝',async()=> {
    const {ws,run} = await setup()
    await run()
    const raw = (await ws.fs.readText(TEMPLATE_STATE_PATH))!
    const bad:Array<(value:Record<string,unknown>)=>void> = [
      value=>{value.version=2},
      value=>{(value.replay as {operations:Array<{hash:string}>}).operations[0]!.hash='bad'},
      value=>{(value.replay as {context:{history:unknown[]}}).context.history=[{role:'tool',content:'bad'}]},
      value=>{value.floor='sibling#t1'},
      value=>{Object.defineProperty(value,'__proto__',{value:{polluted:true},enumerable:true})},
    ]
    for (const change of bad) {
      const value = JSON.parse(raw) as {generation:Record<string,unknown>}
      change(value.generation)
      await ws.fs.writeText(TEMPLATE_STATE_PATH,JSON.stringify(value))
      await expect(loadTemplateState(ws.fs)).rejects.toThrow()
    }
    await ws.fs.writeText(TEMPLATE_STATE_PATH,raw)
    const stored = await loadTemplateState(ws.fs)
    stored.outputs['100']={hash:'0'.repeat(64),text:'x'.repeat(4*1024*1024)}
    await expect(saveTemplateState(ws.fs.withFloor('s1#t1'),stored)).rejects.toThrow(/4 MiB/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(raw)
  })
})
