/** 实时消息读屏障集成：工厂宿主日志与真实剧情文件验证编号、收口失败、WAL 和绑定隔离。 */
import {mkdtemp,rm,appendFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest'
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import type {Context} from '@deepseek-ai/cordis'
import {TavernState} from '../src/node/state.js'
import {TavernService} from '../src/node/service.js'
import {resolveConfig} from '../src/node/config.js'
import {onTurnStart,onTurnEnd} from '../src/node/sessionLifecycle.js'
import * as templateOutput from '../src/node/templateOutput.js'
import {getHelperEventState} from '../src/node/helperEventState.js'
import {getHelperSnapshot} from '../src/node/helperRuntime.js'
import {HELPER_STATE_PATH} from '../src/state/helper.js'

let root:string,state:TavernState,ctx:Context,cardId:string,storyId:string,events:SessionEvent[]
function factory():SessionEvent[]{return [
  {type:'turn/start',seq:0,time:0,data:{turn:1}},
  {type:'user/message',seq:1,time:0,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'走进房间'}],source:{kind:'user'}})},
  {type:'user/message',seq:2,time:0,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'Current runtime context. private'}],source:{kind:'user'}})},
  {type:'assistant/message',seq:3,time:0,surfaceOp:'append',data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'房间里亮着灯'}]})}},
  {type:'turn/end',seq:4,time:0,data:{turn:1,reason:{kind:'completed'}}},
] as SessionEvent[]}
const session=()=>({id:'a' as Session['id'],snapshotEvents:()=>events})
const workspace=()=>state.storyWorkspace(cardId,storyId)
const read=(closedSeq?:number)=>getHelperEventState(ctx,state,{sessionId:'a',storyId,...(closedSeq===undefined?{}:{closedSeq})})
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'tavern-event-state-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init();cardId=(await state.createCharacter('工厂事件角色')).cardId
  await state.saveBinding({sessionId:'a',cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:true,greetingIndex:0,createdAt:new Date(0).toISOString()})
  storyId=(await state.loadBinding('a'))!.storyId!
  events=factory()
  ctx={sessions:{get:(id:string)=>id==='a'?session():undefined},get:()=>undefined} as unknown as Context
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})

describe('实时助手事件的剧情收口屏障',()=>{
  it('无宿主结束帧的原有清理不额外读取绑定或依赖事件回执',async()=>{
    state.currentTurns.set('a',1);state.currentSteps.set('a',2)
    const lookup=vi.spyOn(state,'loadBinding').mockRejectedValue(new Error('工厂不可用绑定'))
    await onTurnEnd(state,'a')
    expect(state.currentTurns.has('a')).toBe(false);expect(state.currentSteps.has('a')).toBe(false)
    expect(lookup).not.toHaveBeenCalled();expect(state.helperTurnClosures.size).toBe(0)
  })
  it('初始元数据与卡片快照使用同一编号和修订，过滤合成消息且不写状态',async()=>{
    const value=await getHelperEventState(ctx,state,{sessionId:'a'})
    expect(value).toMatchObject({storyId,writable:true,closedThrough:4,messages:[{seq:1,message_id:0,role:'user'},{seq:3,message_id:1,role:'assistant'}]})
    expect(value.historyRevision).toBe((await getHelperSnapshot(ctx,state,'a',3)).historyRevision)
    expect(await (await workspace()).fs.readText(HELPER_STATE_PATH)).toBeNull()
    events=[]
    expect(await read()).toMatchObject({messages:[],closedThrough:-1,writable:true})
  })
  it('缺少事件、收口回执或真实 WAL 时不把轮次当作可通知的完成',async()=>{
    await expect(read(3)).rejects.toThrow(/不是已结束/)
    await expect(read(4)).rejects.toThrow(/收口回执/)
    await onTurnStart(state,'a',1)
    expect((await read()).writable).toBe(false)
    await expect(read(4)).rejects.toThrow(/收口回执/)
    await onTurnEnd(state,'a',session())
    expect(await read(4)).toMatchObject({writable:true,closedThrough:4})
    await onTurnStart(state,'a',2)
    events.push({type:'turn/start',seq:5,time:0,data:{turn:2}} as SessionEvent)
    expect(await read(4)).toMatchObject({writable:false,closedThrough:4})
  })
  it('WAL 提交失败即使队列已经结束也明确拒绝通知',async()=>{
    await onTurnStart(state,'a',1)
    vi.spyOn((await workspace()).wal,'commitFloor').mockRejectedValueOnce(new Error('工厂提交失败'))
    await expect(state.enqueueSessionTask('a',()=>onTurnEnd(state,'a',session()))).rejects.toThrow('工厂提交失败')
    await state.waitForSessionTasks('a')
    expect(state.openFloors.has('a')).toBe(false)
    await expect(read(4)).rejects.toThrow('剧情收口失败：工厂提交失败')
  })
  it('模板失败但 WAL 已提交时仍拒绝，允许显式成功重试后恢复',async()=>{
    await onTurnStart(state,'a',1)
    const fail=vi.spyOn(templateOutput,'completeTemplateOutput').mockRejectedValueOnce(new Error('工厂模板失败'))
    await expect(onTurnEnd(state,'a',session())).rejects.toThrow('工厂模板失败')
    expect((await (await workspace()).wal.validateFloor('a#t1')).committed).toBe(true)
    await expect(read(4)).rejects.toThrow('剧情收口失败：工厂模板失败')
    fail.mockRestore();await onTurnEnd(state,'a',session())
    expect((await read(4)).closedThrough).toBe(4)
  })
  it('服务等待已入队的收口任务，再返回有提交证明的结果',async()=>{
    await onTurnStart(state,'a',1)
    let release!:()=>void
    const ready=new Promise<void>(resolve=>{release=resolve})
    const task=state.enqueueSessionTask('a',async()=>{await ready;await onTurnEnd(state,'a',session())})
    let settled=false
    const result=TavernService.prototype.getHelperEventState.call({ctx,state} as TavernService,{sessionId:'a',storyId,closedSeq:4}).then(value=>{settled=true;return value})
    await new Promise(resolve=>setTimeout(resolve,20));expect(settled).toBe(false)
    release();await task;expect(await result).toMatchObject({storyId,writable:true,closedThrough:4})
  })
  it('绑定变更和禁用交互卡使旧剧情来源失效',async()=>{
    await expect(getHelperEventState(ctx,state,{sessionId:'a',storyId:'other'})).rejects.toThrow(/绑定已经改变/)
    await state.saveBinding({... (await state.loadBinding('a'))!,interactiveCards:false})
    await expect(read()).rejects.toThrow(/未启用交互卡/)
  })
  it('慢 WAL 校验与换绑串行，已换绑后旧剧情不能取得事件许可',async()=>{
    await onTurnStart(state,'a',1);await onTurnEnd(state,'a',session())
    const replacement=(await state.createCharacter('另一个工厂角色')).cardId,binding=(await state.loadBinding('a'))!,wal=(await workspace()).wal
    const original=wal.validateFloor.bind(wal)
    let release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
    vi.spyOn(wal,'validateFloor').mockImplementationOnce(async floor=>{entered();await gate;return original(floor)})
    const reading=read(4);await started
    let changed=false
    const switching=state.saveBinding({...binding,cardId:replacement,storyId:undefined}).then(()=>{changed=true})
    await new Promise(resolve=>setTimeout(resolve,20));expect(changed).toBe(false)
    release();expect((await reading).storyId).toBe(storyId)
    await switching;expect((await state.loadBinding('a'))?.storyId).not.toBe(storyId)
    await expect(read(4)).rejects.toThrow(/绑定已经改变/)
  })
  it('已收口楼层的日志损坏不能靠旧内存回执绕过',async()=>{
    await onTurnStart(state,'a',1);await onTurnEnd(state,'a',session())
    await appendFile(join((await workspace()).fs.root,'state/wal/a_t1/records.jsonl'),'{broken}\n')
    await expect(read(4)).rejects.toThrow(/WAL/)
  })
})
