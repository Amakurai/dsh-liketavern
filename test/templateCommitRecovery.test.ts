/** 模板计划提交故障回归：真实剧情文件/WAL 和原子替换故障，验证变量、定时器、缓存及同层工具写入。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '../src/core/types.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { rollbackToFloor } from '../src/node/floors.js'
import { copyTemplateTimers, loadTemplateState, loadTemplateTimers, saveTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'
import { importCard } from '../src/state/workspace.js'

const fault = vi.hoisted(() => ({ target: '', afterRename: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.target && String(args[1]).replace(/\\/g, '/').endsWith(fault.target)) {
      fault.target = ''
      if (fault.afterRename) await actual.rename(...args)
      throw new Error('测试：模板状态原子替换失败')
    }
    return actual.rename(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  fault.target = ''; fault.afterRename = false
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-template-commit-'))
  roots.push(root)
  const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  const card: CharacterCard = { spec:'chara_card_v2', name:'提交测试', description:'<% incvar("runs") %>运行=<%- getvar("runs") %>',
    personality:'', scenario:'', firstMes:'', alternateGreetings:[], mesExample:'', systemPrompt:'', postHistoryInstructions:'',
    creatorNotes:'', creator:'', characterVersion:'1', tags:[], characterBook:null, regexScripts:[], extensions:{}, pngBytes:null, raw:{}, depthPrompt:null }
  const { cardId } = await importCard(paths.characters, card)
  await saveBinding(paths, { sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],
    characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString() })
  const binding = (await state.loadBinding('s1'))!
  const ws = await state.storyWorkspace(cardId,binding.storyId)
  await state.saveTimers(cardId,'s1',{stickyLeft:{},cooldownLeft:{waiting:5}},null,binding.storyId)
  await onTurnStart(state,'s1',1)
  const run = () => runTavernPipeline({state,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'你好'}]})
  return {state,ws,run,cardId,binding,paths}
}

describe('模板计划持久化', () => {
  it('变量正文替换前失败后，重试只推进一次定时器并保留同层工具写入',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    await ws.fs.withFloor('s1#t1').writeText('journal.md','工具已记下的事实')
    fault.target = TEMPLATE_STATE_PATH
    await expect(run()).rejects.toThrow(/原子替换失败/)
    expect(state.turnPlans.has('s1')).toBe(false)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBeUndefined()
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
    expect(state.pendingTurnPlans.has('s1')).toBe(true)
    await run()
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect(await ws.fs.readText('journal.md')).toBe('工具已记下的事实')
    expect(state.pendingTurnPlans.has('s1')).toBe(false)
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBeUndefined()
  })

  it('提交失败后的资产编辑不重评已冻结计划，预览仍读当前资产',async()=> {
    const {state,ws,run,cardId} = await setup()
    fault.target = TEMPLATE_STATE_PATH
    await expect(run()).rejects.toThrow(/原子替换失败/)
    await state.saveCharacter(cardId,{description:'<% incvar("runs",100) %>新版=<%- getvar("runs") %>'})
    const preview = await runTavernPipeline({state,sessionId:'s1',agent:null,mode:'preview',historyOverride:[]})
    expect(preview!.turnContext).toContain('新版=100')
    const restored = await run()
    expect(restored!.turnContext).toContain('运行=1')
    expect(restored!.turnContext).not.toContain('新版')
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect(await run()).toBe(restored)
  })

  it('WAL 替换失败不改正文，正文替换后报错读回确认并一次发布缓存',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    fault.target = 'records.jsonl'
    await expect(run()).rejects.toThrow(/原子替换失败/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
    fault.target = TEMPLATE_STATE_PATH; fault.afterRename = true
    const result = await run()
    expect(await run()).toBe(result)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
  })

  it('已替换正文但读回也暂时失败时，重试仍提交原绝对快照',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    const write = WorkspaceFs.prototype.writeText, read = WorkspaceFs.prototype.readText
    let failWrite = true, failRead = false
    vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,content) {
      await write.call(this,path,content)
      if (path === TEMPLATE_STATE_PATH && failWrite) { failWrite = false; failRead = true; throw new Error('写后故障') }
    })
    vi.spyOn(WorkspaceFs.prototype,'readText').mockImplementation(async function(path) {
      if (path === TEMPLATE_STATE_PATH && failRead) { failRead = false; throw new Error('读回故障') }
      return read.call(this,path)
    })
    await expect(run()).rejects.toThrow(/读回故障/)
    expect(state.turnPlans.has('s1')).toBe(false)
    await run()
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
  })

  it('旧版模板文件缺少定时字段时先读旧文件，迁移后显式保存更新统一状态',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    await ws.fs.writeText(TEMPLATE_STATE_PATH,JSON.stringify({version:1,variables:{global:{},local:{},message:{runs:7}},outputs:{}}))
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
    await run()
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(8)
    await state.saveTimers(cardId,'s1',{stickyLeft:{sticky:3},cooldownLeft:{}},'s1#t1',binding.storyId)
    expect(await state.loadTimers(cardId,'s1',binding.storyId)).toEqual({stickyLeft:{sticky:3},cooldownLeft:{}})
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(7)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(5)
  })

  it('失败后结束楼层清理待提交计划，下一轮只从未改变的剧情状态计算',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    fault.target = TEMPLATE_STATE_PATH
    await expect(run()).rejects.toThrow(/原子替换失败/)
    await onTurnEnd(state,'s1')
    expect(state.pendingTurnPlans.has('s1')).toBe(false)
    await onTurnStart(state,'s1',2)
    await run()
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
  })

  it('进程内待提交记录丢失后，正文替换前故障仍可从同一原始状态重试',async()=> {
    const {state,ws,run,cardId,binding,paths} = await setup()
    fault.target = TEMPLATE_STATE_PATH
    await expect(run()).rejects.toThrow(/原子替换失败/)
    const restarted = new TavernState(paths,()=>resolveConfig({}))
    await restarted.init()
    restarted.currentTurns.set('s1',1)
    restarted.openFloors.set('s1',state.openFloors.get('s1')!)
    await runTavernPipeline({state:restarted,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'你好'}]})
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    expect((await restarted.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
  })

  it('分支定时器映射不改祖先模板镜像，撤销子层再撤祖先恢复两份状态而不影响来源',async()=> {
    const {state,ws,run,cardId,binding,paths} = await setup()
    await run(); await onTurnEnd(state,'s1')
    const sourceTemplate = await ws.fs.readText(TEMPLATE_STATE_PATH)
    const id = newStoryId(), cardRoot = join(paths.characters,cardId)
    await snapshotStory({cardRoot,sourceRoot:ws.fs.root,id,sessionId:'child',includeWal:true,
      prepare:async fs => copyTemplateTimers(fs,'s1','child')})
    const childRoot = storyRoot(cardRoot,id)
    const wal = new Wal(join(childRoot,'state/wal'))
    const child = new WorkspaceFs(childRoot,wal)
    expect(await child.readText(TEMPLATE_STATE_PATH)).toBe(sourceTemplate)
    expect((await loadTemplateTimers(child,'child')).cooldownLeft.waiting).toBe(4)
    await wal.beginFloor('child#t2')
    const childState = await loadTemplateState(child)
    await saveTemplateState(child.withFloor('child#t2'),{...childState,variables:{...childState.variables,message:{runs:2}},
      wiTimers:{...childState.wiTimers,child:{stickyLeft:{},cooldownLeft:{waiting:3}}}})
    await wal.commitFloor('child#t2')
    await wal.rollbackAfter(['s1#t1','child#t2'],childRoot)
    expect((await loadTemplateState(child)).variables.message.runs).toBeUndefined()
    expect((await loadTemplateTimers(child,'s1')).cooldownLeft.waiting).toBe(5)
    await copyTemplateTimers(child,'s1','grandchild')
    expect((await loadTemplateTimers(child,'grandchild')).cooldownLeft.waiting).toBe(5)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(sourceTemplate)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(4)
  })

  it('损坏的新定时字段明确失败，不静默回退到旧定时文件',async()=> {
    const {ws,run} = await setup()
    await ws.fs.writeText(TEMPLATE_STATE_PATH,JSON.stringify({version:1,variables:{global:{},local:{},message:{}},outputs:{},
      wiTimers:{s1:{stickyLeft:{},cooldownLeft:{waiting:'oops'}}}}))
    await expect(loadTemplateTimers(ws.fs,'s1')).rejects.toThrow(/定时状态损坏/)
    await expect(run()).rejects.toThrow(/定时状态损坏/)
  })

  it.each(['{broken', '{"stickyLeft":{},"cooldownLeft":{"waiting":"oops"}}'])('损坏旧计时文件阻止生成与分支发布，保留迁移来源：%s', async (raw) => {
    const {ws, run} = await setup()
    const path = 'state/wi-timers/s1.json'
    await ws.fs.writeText(path, raw)
    await expect(loadTemplateTimers(ws.fs, 's1')).rejects.toThrow(/定时状态损坏/)
    await expect(run()).rejects.toThrow(/定时状态损坏/)
    await expect(copyTemplateTimers(ws.fs, 's1', 'child')).rejects.toThrow(/定时状态损坏/)
    expect(await ws.fs.readText(path)).toBe(raw)
    expect(await ws.fs.readText('state/wi-timers/child.json')).toBeNull()
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })

  it('真实分支入口在草稿回滚后继承边界定时器，宿主子会话的新轮独立推进',async()=> {
    const {state,ws,run,cardId,binding} = await setup()
    await run(); await onTurnEnd(state,'s1')
    await onTurnStart(state,'s1',2); await run(); await onTurnEnd(state,'s1')
    const messages = [1,2].map(turn=>createAssistantMessage({content:[{type:'text',text:`第${turn}层`}]}))
    const events = messages.flatMap((message,index)=>[
      {type:'turn/start',data:{turn:index+1}},
      {type:'user/message',data:createUserMessage({content:[{type:'text',text:'你好'}],source:{kind:'user'}})},
      {type:'assistant/message',data:{turn:index+1,step:1,message}},
      {type:'turn/end',data:{turn:index+1,reason:{kind:'completed'}}},
    ]).map((event,seq)=>({...event,seq,time:seq})) as SessionEvent[]
    const sessions = new Map<string,Session>()
    const session = (id:string,seed:readonly SessionEvent[]) => ({id,header:{agentPreset:'tavern'},inheritedEventCount:0,
      snapshotEvents:()=>seed,requestHeader:()=>({config:{provider:'test',model:'test'}})}) as unknown as Session
    sessions.set('s1',session('s1',events))
    const presets = {composedPreset:()=> 'tavern',resolve:async()=>({id:'tavern'}),mount:vi.fn()}
    const agent = {ctx:{},options:{provider:'test',model:'test'},followup:vi.fn(),dispose:vi.fn()}
    const ctx = {get:(key:string)=>key==='agentPresets'?presets:undefined,logger:{warn:vi.fn()},
      sessions:{get:(id:string)=>sessions.get(id)},
      agents:{get:()=>agent,withoutInitiator:(fn:()=>unknown)=>fn(),
        create:async(options:{sessionId:string;seed:SessionEvent[]})=>{sessions.set(options.sessionId,session(options.sessionId,options.seed));return {dispose:vi.fn()}}},
    } as unknown as Context
    const child = await rollbackToFloor({ctx,state},'s1',messages[0]!.id)
    const childBinding = (await state.loadBinding(child.childSessionId))!
    const childWs = await state.storyWorkspace(cardId,childBinding.storyId)
    expect((await loadTemplateState(childWs.fs)).variables.message.runs).toBe(1)
    expect((await state.loadTimers(cardId,child.childSessionId,childBinding.storyId)).cooldownLeft.waiting).toBe(4)
    await onTurnStart(state,child.childSessionId,2)
    await runTavernPipeline({state,sessionId:child.childSessionId,agent:null,mode:'live',historyOverride:[{role:'user',content:'你好'}]})
    expect((await loadTemplateState(childWs.fs)).variables.message.runs).toBe(2)
    expect((await state.loadTimers(cardId,child.childSessionId,childBinding.storyId)).cooldownLeft.waiting).toBe(3)
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(2)
    expect((await state.loadTimers(cardId,'s1',binding.storyId)).cooldownLeft.waiting).toBe(3)
  })
})
