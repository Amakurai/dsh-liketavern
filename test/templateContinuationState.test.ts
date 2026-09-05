/** sticky 的真实剧情事务：跨轮闭包与回复共同提交，重启和分支恢复，失败及回滚不重复推进。 */
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {createAssistantMessage,createUserMessage,type Message} from '@deepseek-ai/dsh-llm'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {saveBinding} from '../src/node/bindings.js'
import {onTurnStart,onTurnEnd} from '../src/node/sessionLifecycle.js'
import {runTavernPipeline} from '../src/node/pipeline.js'
import {parseJsonCard} from '../src/state/card.js'
import {importCard} from '../src/state/workspace.js'
import {loadTemplateState,TEMPLATE_STATE_PATH} from '../src/state/template.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {newStoryId,snapshotStory} from '../src/state/story.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
function event(type:string,data:unknown,seq:number):SessionEvent{return {type,data,seq,time:0} as unknown as SessionEvent}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-sticky-state-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh=async()=>{const value=new TavernState(paths,()=>resolveConfig({}));await value.init();return value}
  const state=await fresh(),card=parseJsonCard({name:'Alice',description:`<% if(!getvar('registered')) {let n=0;
    activateRegex(/word/g,()=>String(++n),{message:true,sticky:4,uuid:'shared'});setvar('registered',true)} incvar('rounds'); %>`})
  const {cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:'Alice',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  const messages:Message[]=[],events:SessionEvent[]=[]
  const agent=(id='s1')=>({options:{},session:{id,snapshotEvents:()=>events,deriveMessages:()=>messages}} as unknown as Agent)
  const begin=async(turn:number,runtime=state,id='s1')=>{
    events.push(event('turn/start',{turn},events.length));await onTurnStart(runtime,id,turn)
    const message=createUserMessage({content:[{type:'text',text:'next '+turn}]});messages.push(message);events.push(event('user/message',message,events.length))
  }
  const run=(runtime=state,id='s1',mode:'live'|'preview'='live')=>runTavernPipeline({state:runtime,sessionId:id,agent:agent(id),mode})
  const end=async(turn:number,runtime=state,id='s1',finish='stop')=>{
    events.push(event('assistant/chunk',{turn,step:1,chunk:{type:'finish',reason:{kind:finish}}},events.length))
    const message=createAssistantMessage({content:[{type:'text',text:'word'}]});messages.push(message)
    const seq=events.length;events.push(event('assistant/message',{turn,step:1,message},seq))
    events.push(event('turn/end',{turn,reason:{kind:'completed'}},events.length))
    const session={id:id as Session['id'],snapshotEvents:()=>events}
    await onTurnEnd(runtime,id,session);return {seq,session}
  }
  return {state,paths,fresh,cardId,binding,ws,events,messages,begin,run,end}
}

describe('跨轮 sticky 剧情持久化',()=> {
  it('新 worker 和新运行时接续回复闭包；预览、多步及重复结束均不递减或重复写入',async()=> {
    const f=await fixture();await f.begin(1);const plan=await f.run();expect(await f.run()).toBe(plan)
    const first=await f.end(1);let stored=await loadTemplateState(f.ws.fs)
    expect(stored.outputs[String(first.seq)]?.text).toBe('1')
    expect(stored.continuation?.state.regex.message[0]?.sticky).toBe(4)
    const before=await f.ws.fs.readText(TEMPLATE_STATE_PATH)
    await f.run(await f.fresh(),'s1','preview')
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    const restarted=await f.fresh();await f.begin(2,restarted);await f.run(restarted)
    const second=await f.end(2,restarted);stored=await loadTemplateState(f.ws.fs)
    expect(stored.outputs[String(second.seq)]?.text).toBe('2')
    expect(stored.variables.message.rounds).toBe(2)
    expect(stored.continuation?.state.regex.message[0]?.sticky).toBe(3)
    await onTurnEnd(await f.fresh(),'s1',second.session)
    expect(await loadTemplateState(f.ws.fs)).toEqual(stored)
  })
  it('正常到期释放跨轮日志；截断回复不会调用闭包，但已提交的生成计数保持',async()=> {
    const f=await fixture();await f.begin(1);await f.run();const cut=await f.end(1,f.state,'s1','length')
    expect((await loadTemplateState(f.ws.fs)).outputs[String(cut.seq)]).toBeUndefined()
    for(let turn=2;turn<=5;turn++) {
      const runtime=await f.fresh();await f.begin(turn,runtime);await f.run(runtime);const reply=await f.end(turn,runtime)
      const stored=await loadTemplateState(f.ws.fs)
      expect(stored.outputs[String(reply.seq)]?.text).toBe(turn===5?'word':String(turn-1))
      if(turn===5) {expect(stored.continuation?.state.regex.message).toEqual([]);expect(stored.continuation?.replay).toBeUndefined()}
    }
  },20000)
  it('提交后缓存发布失败从 prepared 单份日志恢复；历史 WAL 回滚恢复计数和闭包',async()=> {
    const f=await fixture();await f.begin(1);await f.run();await f.end(1)
    const before=await loadTemplateState(f.ws.fs)
    const runtime=await f.fresh();await f.begin(2,runtime)
    vi.spyOn(runtime,'recordTriggerLog').mockImplementationOnce(()=>{throw Error('publish failed')})
    await expect(f.run(runtime)).rejects.toThrow('publish failed')
    const staged=await loadTemplateState(f.ws.fs)
    expect(staged.generation?.status).toBe('prepared');expect(staged.continuation?.replay).toBeUndefined()
    const recovery=await f.fresh();await f.run(recovery);const reply=await f.end(2,recovery)
    expect((await loadTemplateState(f.ws.fs)).outputs[String(reply.seq)]?.text).toBe('2')
    await f.ws.wal.rollbackFloor('s1#t2',f.ws.fs.root)
    expect(await loadTemplateState(f.ws.fs)).toEqual(before)
  })
  it('回复写入失败保留生成checkpoint，重试只调用并提交一次回复结果',async()=> {
    const f=await fixture();await f.begin(1);await f.run()
    const original=WorkspaceFs.prototype.writeText
    const failure=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementationOnce(async function(path,text){
      if(path===TEMPLATE_STATE_PATH) throw Error('reply save failed')
      return original.call(this,path,text)
    })
    await expect(f.end(1)).rejects.toThrow('reply save failed');failure.mockRestore()
    expect((await loadTemplateState(f.ws.fs)).generation?.status).toBe('prepared')
    const session={id:'s1' as Session['id'],snapshotEvents:()=>f.events}
    await onTurnEnd(await f.fresh(),'s1',session)
    const stored=await loadTemplateState(f.ws.fs)
    expect(Object.values(stored.outputs).map(output=>output.text)).toEqual(['1'])
    expect(stored.variables.message.rounds).toBe(1)
  })
  it('分支保留继承的闭包状态，子剧情推进和回滚不改变原剧情文件',async()=> {
    const f=await fixture();await f.begin(1);await f.run();await f.end(1)
    const before=await f.ws.fs.readText(TEMPLATE_STATE_PATH),childStory=newStoryId()
    await snapshotStory({cardRoot:join(f.paths.characters,f.cardId),sourceRoot:f.ws.fs.root,id:childStory,sessionId:'child',includeWal:true})
    await saveBinding(f.paths,{...f.binding,sessionId:'child',storyId:childStory})
    const runtime=await f.fresh();await f.begin(2,runtime,'child');await f.run(runtime,'child');const result=await f.end(2,runtime,'child')
    const child=await runtime.storyWorkspace(f.cardId,childStory)
    expect((await loadTemplateState(child.fs)).outputs[String(result.seq)]?.text).toBe('2')
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    await child.wal.rollbackFloor('child#t2',child.fs.root)
    expect(await child.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
  })
})
