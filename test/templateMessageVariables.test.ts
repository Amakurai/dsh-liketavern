/** 历史消息变量兼容：真实 QuickJS、稳定消息身份与临时文件/WAL，验证继承、恢复及分支隔离。 */
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createAssistantMessage,createUserMessage,type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'
import { parseTemplateMessageIdentities,parseTemplateMessageVariables,type TemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { isolated } from '../src/node/isolated.js'
import { buildTemplateMessageHistory } from '../src/node/templateMessageHistory.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart,onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState,saveTemplateState,TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { newStoryId,snapshotStory } from '../src/state/story.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'
import { normalizeTemplateLore } from '../src/core/templateLore.js'
import { DEFAULT_WI_SETTINGS } from '../src/core/types.js'
import { withEditedAssistantMessage } from '../src/node/floors.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
const frame=(values:Record<string,import('../src/core/template.js').TemplateValue>,initialized=true)=>({values,initialized})
const state=(snapshots:TemplateMessageVariables['snapshots']):TemplateMessageVariables=>({version:1,snapshots})
const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],
  history:[{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'system',content:'note'},{role:'user',content:'last'}],
  historyIdentities:[0,1,2,3].map(index=>({messageId:`m${index}`,hostMessageId:index*11+9,swipeId:0})),
  messageVariables:state({m0:frame({hp:0,nested:{left:1,right:2}}),m1:frame({hp:null}),m2:frame({hp:2})}),now:1000,seed:42,phase:'generate',...patch})
const render=(text:string,patch:Partial<TemplateContext>={})=>isolated('template',{texts:[text],context:context(patch)})

describe('历史变量选择和继承',()=> {
  it('findVariables 返回整树，边界排除自身、支持负值并跳过 null 而接受零',async()=> {
    const result=await render(`<%- JSON.stringify([findVariables('hp',1),findVariables('hp',2),findVariables('hp',-1),findVariables('missing',4)]) %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual([{hp:0,nested:{left:1,right:2}},{hp:0,nested:{left:1,right:2}},{hp:2},{}])
  })
  it('id 优先于 role，精确角色选择、默认 cache 与显式 message 作用域分开',async()=> {
    const result=await render(`<%- JSON.stringify([
      getMessageVar('hp',{withMsg:{id:0,role:'assistant'}}),getMessageVar('hp',{withMsg:{role:'assistant'}}),
      getMessageVar('hp',{withMsg:{role:'system'}}),getMessageVar('hp',{withMsg:{id:-1}}),
      getvar('hp',{withMsg:{id:0}}),getMessageVar('hp')]) %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual([0,null,2,2,2,2])
  })
  it('显式 id 读取未初始化快照不回溯，空筛选回溯已有快照',async()=> {
    const result=await render(`<%- JSON.stringify([getMessageVar('hp',{withMsg:{id:1},defaults:'missing'}),getMessageVar('hp',{withMsg:{},defaults:'missing'})]) %>`,
      {messageVariables:state({m0:frame({hp:7}),m3:frame({})})})
    expect(JSON.parse(result.texts[0]!)).toEqual(['missing','missing'])
    const reply=await isolated('template',{texts:[`<%- getMessageVar('hp',{withMsg:{},defaults:'missing'}) %>`],
      context:context({phase:'render',messageVariables:state({m0:frame({hp:7}),m3:frame({})}),renderMessages:[{index:1,role:'assistant',swipeId:0}]})})
    expect(reply.texts).toEqual(['7'])
  })
  it('写历史目标不污染当前快照；旧快照改动不重新传播到已初始化后代',async()=> {
    const result=await render(`<% setMessageVar('hp',9,{withMsg:{id:0}}); incvar('hp',1,{inscope:'message',outscope:'message',withMsg:{id:0}}); %><%- getMessageVar('hp') %>`)
    expect(result.texts).toEqual(['2'])
    expect(result.messageVariables.snapshots.m0?.values.hp).toBe(10)
    expect(result.messageVariables.snapshots.m3?.values.hp).toBe(2)
    expect(result.variables.message.hp).toBe(2)
  })
  it('只继承一次且按顶层覆盖；findVariables 默认返回引用，clone 读取不改原树',async()=> {
    const result=await render(`<% findVariables('hp',1).hp=8; const copied=getMessageVar(null,{withMsg:{id:0},clone:true}); copied.hp=99; %>ok`,
      {messageVariables:state({m0:frame({hp:1,nested:{left:1,right:2}}),m3:frame({nested:{left:5}},false)})})
    expect(result.messageVariables.snapshots.m0?.values.hp).toBe(8)
    expect(result.messageVariables.snapshots.m3?.values).toEqual({hp:1,nested:{left:5}})
  })
  it('不可见 swipe 的读返回 defaults，写拒绝；-1 表示当前唯一版本',async()=> {
    expect((await render(`<%- getMessageVar('hp',{withMsg:{id:0,swipe_id:1},defaults:'missing'}) %>/<%- getMessageVar('hp',{withMsg:{id:0,swipe_id:-1}}) %>`)).texts).toEqual(['missing/0'])
    await expect(render(`<% setMessageVar('hp',9,{withMsg:{id:0,swipe_id:1}}) %>`)).rejects.toThrow(/当前剧情/)
    await expect(render(`<%- getMessageVar('hp',{withMsg:{id:0.1}}) %>`)).rejects.toThrow(/筛选无效/)
  })
  it('preload 中通过历史引用修改只影响临时副本，不能进入导出快照',async()=> {
    const {parseLorebook}=await import('../src/state/lorebook.js')
    const entries=parseLorebook({entries:[{uid:1,comment:'preload',content:`@@preload\n<% findVariables('hp',1).hp=99; %>`}]},{source:'character',sourceRef:'card'})
    const result=await render(`<%- getMessageVar('hp',{withMsg:{id:0}}) %>`,{entries})
    expect(result.texts).toEqual(['0'])
    expect(result.messageVariables.snapshots.m0?.values.hp).toBe(0)
  })
  it('schema 校验保留当前树身份，普通 set/inc 后立即历史读取和引用修改一致',async()=> {
    const result=await render(`<% setVariableSchema({hp:z.number()}); setvar('hp',3); const first=getMessageVar('hp',{withMsg:{id:-1}});
      incvar('hp'); const second=getMessageVar('hp',{withMsg:{id:-1}}); findVariables().hp=8;
      const third=getMessageVar('hp',{withMsg:{id:-1}}); %><%- JSON.stringify([first,second,third]) %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual([3,4,8])
    expect(result.variables.message.hp).toBe(8)
    expect(result.messageVariables.snapshots.m3?.values.hp).toBe(8)
  })
  it('历史引用不能绕过 schema 或 @@if 的只读规则，循环引用拒绝整次导出',async()=> {
    await expect(render(`<% setVariableSchema({hp:z.number()}); findVariables('hp',1).hp='bad'; %>`)).rejects.toThrow()
    await expect(render(`<% findVariables('hp',1).cycle=findVariables('hp',1); %>`)).rejects.toThrow(/JSON|循环/)
    const {parseLorebook}=await import('../src/state/lorebook.js')
    const entries=parseLorebook({entries:[{uid:1,comment:'conditional',constant:true,content:`@@if (findVariables('hp',1).hp=99)\nbody`}]},{source:'character',sourceRef:'card'}).map(normalizeTemplateLore)
    await expect(isolated('wi',{entries,timerState:{stickyLeft:{},cooldownLeft:{}},settings:DEFAULT_WI_SETTINGS,
      messages:context().history,contextWindow:4096,seed:1,templates:context({entries})})).rejects.toThrow(/条件必须只读/)
  })
  it('inc/dec、insert/del、flags/merge 和 clone 均保留同一历史目标',async()=> {
    const result=await render(`<% const target={scope:'message',withMsg:{id:0}};
      setvar('count',10,target); incvar('count',3,{...target,inscope:'message'}); decvar('count',2,{...target,inscope:'message'});
      insvar('items','b',1,target); delvar('items',0,target); setvar('count',99,{...target,flags:'nx'});
      setvar('missing',99,{...target,flags:'xx'}); setvar('options',{next:2},{...target,merge:true});
      const old=setvar('count',12,{...target,results:'old'}); const copy=getvar(null,{...target,clone:true});copy.count=100;
      %><%- JSON.stringify([old,getvar(null,target),getMessageVar('count')]) %>`,
      {messageVariables:state({m0:frame({count:1,items:['a','c'],options:{before:1}}),m3:frame({count:2})})})
    expect(JSON.parse(result.texts[0]!)).toEqual([11,{count:12,items:['b','c'],options:{before:1,next:2}},2])
    expect(result.variables.message).toEqual({count:2})
  })
  it('无效身份、不可见快照和非法 swipe 在隔离入口拒绝',async()=> {
    await expect(render('text',{historyIdentities:[{messageId:'same',swipeId:0}]})).rejects.toThrow(/历史不一致/)
    await expect(render('text',{messageVariables:state({sibling:frame({secret:1})})})).rejects.toThrow(/不可见/)
    expect(()=>parseTemplateMessageIdentities([{messageId:'valid',swipeId:1}],1)).toThrow(/身份无效/)
    expect(()=>parseTemplateMessageIdentities([{messageId:'valid',swipeId:0,hostMessageId:-1}],1)).toThrow(/身份无效/)
  })
  it('delvar 和 delMessageVar 接受选项对象并保留 withMsg，index 删除不二次应用',async()=> {
    const result=await render(`<% delMessageVar('gone',{withMsg:{id:0}});delvar('other',{scope:'message',withMsg:{id:0}});
      delMessageVar('items',{index:1,withMsg:{id:0}}); %><%- JSON.stringify(getMessageVar(null,{withMsg:{id:0}})) %>`,
      {messageVariables:state({m0:frame({gone:1,other:2,items:[0,1,2]}),m3:frame({current:true})})})
    expect(JSON.parse(result.texts[0]!)).toEqual({items:[0,2]})
    expect(result.variables.message).toEqual({current:true})
  })
  it('null 或省略 key 删除整树，历史目标清空不影响当前缓存',async()=> {
    const result=await render(`<% const historical=delMessageVar(null,{withMsg:{id:0},results:'old'});
      const current=getMessageVar('hp'); const previous=delvar(null,{results:'old'}); %><%- JSON.stringify([historical.hp,current,previous,getMessageVar(null)]) %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual([0,2,{hp:2},{}])
    expect(result.messageVariables.snapshots.m0?.values).toEqual({})
    expect(result.messageVariables.snapshots.m3?.values).toEqual({})
    expect((await render('<% delvar() %>')).variables.message).toEqual({})
  })
})

function user(text:string) {return createUserMessage({content:[{type:'text',text}]})}
function assistant(text:string) {return createAssistantMessage({content:[{type:'text',text}]})}
function event(type:string,data:unknown,seq:number):SessionEvent {return {type,data,seq,time:0,surfaceOp:type.endsWith('/message')?'append':undefined} as unknown as SessionEvent}
async function fixture(description='<% setvar("hp",5) %>role') {
  const root=await mkdtemp(join(tmpdir(),'tavern-message-vars-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh=async()=>{const value=new TavernState(paths,()=>resolveConfig({}));await value.init();return value}
  const runtime=await fresh(),card=parseJsonCard({name:'Alice',description}),{cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:'Alice',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await runtime.loadBinding('s1'))!,ws=await runtime.storyWorkspace(cardId,binding.storyId)
  const messages:Message[]=[],events:SessionEvent[]=[]
  const agent=(id='s1')=>({options:{},session:{id,snapshotEvents:()=>events,deriveMessages:()=>messages}} as unknown as Agent)
  const run=(r=runtime,id='s1')=>runTavernPipeline({state:r,sessionId:id,agent:agent(id),mode:'live'})
  const begin=async(turn:number,text:string,r=runtime,id='s1')=>{
    events.push(event('turn/start',{turn},events.length));await onTurnStart(r,id,turn)
    const message=user(text);messages.push(message);events.push(event('user/message',message,events.length));return message
  }
  const end=async(turn:number,text:string,r=runtime,id='s1')=>{
    events.push(event('assistant/chunk',{turn,step:1,chunk:{type:'finish',reason:{kind:'stop'}}},events.length))
    const message=assistant(text);messages.push(message);events.push(event('assistant/message',{turn,step:1,message},events.length))
    events.push(event('turn/end',{turn,reason:{kind:'completed'}},events.length))
    const session={id:id as Session['id'],snapshotEvents:()=>events}
    await onTurnEnd(r,id,session);return {message,session}
  }
  return {root,paths,runtime,fresh,cardId,binding,ws,messages,events,agent,run,begin,end}
}

describe('消息身份和剧情事务',()=> {
  it('同文本输入按 stable id 去重，seq 与文本索引无关，压缩隐藏的消息不回流',()=> {
    const first=user('same'),second=user('same'),hidden=user('secret'),empty=assistant('')
    const projection=buildTemplateMessageHistory([first,empty],[{id:first.id,text:'same'},{id:second.id,text:'same'}],'Alice','Bob',
      [event('user/message',hidden,1),event('user/message',first,31),event('assistant/message',{message:empty},55)])
    expect(projection.history.map(value=>value.content)).toEqual(['same','same'])
    expect(projection.identities).toEqual([{messageId:first.id,hostMessageId:31,swipeId:0},{messageId:second.id,swipeId:0}])
    expect(projection.identities.some(value=>value.messageId===hidden.id)).toBe(false)
  })
  it('普通 stop 也继承快照；历史写入属于当前楼层，回滚不改旧正文和祖先快照',async()=> {
    const f=await fixture(),first=await f.begin(1,'one');await f.run();const reply=await f.end(1,'plain')
    let stored=await loadTemplateState(f.ws.fs)
    expect(stored.messageVariables?.snapshots[first.id]?.values.hp).toBe(5)
    expect(stored.messageVariables?.snapshots[reply.message.id]?.values.hp).toBe(5)
    await f.runtime.saveCharacter(f.cardId,{description:`<% incvar('hp',1,{inscope:'message',outscope:'message',withMsg:{id:0}}); setvar('current',true) %>role`})
    const second=await f.begin(2,'two');await f.run();await f.end(2,'plain again')
    stored=await loadTemplateState(f.ws.fs)
    expect(stored.messageVariables?.snapshots[first.id]?.values.hp).toBe(6)
    expect(stored.messageVariables?.snapshots[reply.message.id]?.values.hp).toBe(5)
    expect(stored.messageVariables?.snapshots[second.id]?.values).toEqual({hp:5,current:true})
    await f.ws.wal.rollbackFloor('s1#t2',f.ws.fs.root)
    stored=await loadTemplateState(f.ws.fs)
    expect(stored.messageVariables?.snapshots[first.id]?.values.hp).toBe(5)
    expect(stored.messageVariables?.snapshots[second.id]).toBeUndefined()
    expect(reply.message.content).toEqual([{type:'text',text:'plain'}])
  })
  it('inbox 未落日志的 stable id 与后续真实用户消息保持同一快照，同文本新消息独立继承',async()=> {
    const f=await fixture('<% incvar("count") %>role'),first=await f.begin(1,'same')
    f.messages.pop();f.events.pop()
    f.runtime.pendingInputs.set('s1',['same']);f.runtime.pendingTemplateInputs.set('s1',[{id:first.id,text:'same'}])
    const plan=await f.run()
    expect(plan?.templateContext?.historyIdentities?.map(identity=>identity.messageId)).toEqual([first.id])
    f.messages.push(first);f.events.push(event('user/message',first,f.events.length))
    await f.end(1,'plain')
    const second=await f.begin(2,'same');await f.run();await f.end(2,'plain')
    const saved=await loadTemplateState(f.ws.fs)
    expect(saved.messageVariables?.snapshots[first.id]?.values.count).toBe(1)
    expect(saved.messageVariables?.snapshots[second.id]?.values.count).toBe(2)
  })
  it('原子保存后缓存发布失败，重建运行时重放历史自增只提交一次',async()=> {
    const f=await fixture(),first=await f.begin(1,'one');await f.run();await f.end(1,'plain')
    await f.runtime.saveCharacter(f.cardId,{description:`<% incvar('hp',1,{inscope:'message',outscope:'message',withMsg:{id:0}}); let n=0;define('next',()=>++n) %>frozen`})
    await f.begin(2,'two')
    vi.spyOn(f.runtime,'recordTriggerLog').mockImplementationOnce(()=>{throw Error('publish failed')})
    await expect(f.run()).rejects.toThrow(/publish failed/)
    const saved=await loadTemplateState(f.ws.fs)
    expect(saved.messageVariables?.snapshots[first.id]?.values.hp).toBe(6)
    await f.runtime.saveCharacter(f.cardId,{description:'<% throw Error("new asset") %>'})
    const restarted=await f.fresh();const restored=await f.run(restarted)
    expect(restored?.turnContext).toContain('frozen')
    const ended=await f.end(2,'<%- next() %>',restarted)
    expect((await loadTemplateState(f.ws.fs)).messageVariables?.snapshots[first.id]?.values.hp).toBe(6)
    await onTurnEnd(await f.fresh(),'s1',ended.session)
    expect((await loadTemplateState(f.ws.fs)).messageVariables?.snapshots[first.id]?.values.hp).toBe(6)
  })
  it('回复持久化失败重试保持旧历史快照，成功后变量和输出同次提交',async()=> {
    const f=await fixture(),first=await f.begin(1,'one');await f.run()
    const before=await f.ws.fs.readText(TEMPLATE_STATE_PATH),original=WorkspaceFs.prototype.writeText
    vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementationOnce(async function(path,text){if(path===TEMPLATE_STATE_PATH) throw Error('write failed');return original.call(this,path,text)})
    await expect(f.end(1,`<% incvar('hp',2,{inscope:'message',outscope:'message',withMsg:{id:0}}) %>reply`)).rejects.toThrow(/write failed/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    await onTurnEnd(await f.fresh(),'s1',{id:'s1' as Session['id'],snapshotEvents:()=>f.events})
    const saved=await loadTemplateState(f.ws.fs)
    expect(saved.messageVariables?.snapshots[first.id]?.values.hp).toBe(7)
    expect(Object.values(saved.outputs).map(output=>output.text)).toEqual(['reply'])
  })
  it('当前剧情分支继承稳定 id，子剧情修改和回滚不影响来源',async()=> {
    const f=await fixture(),first=await f.begin(1,'one');await f.run();await f.end(1,'plain')
    const childId=newStoryId();await snapshotStory({cardRoot:join(f.paths.characters,f.cardId),sourceRoot:f.ws.fs.root,id:childId,sessionId:'child',includeWal:true})
    await saveBinding(f.paths,{...f.binding,sessionId:'child',storyId:childId})
    await f.runtime.saveCharacter(f.cardId,{description:`<% setMessageVar('hp',90,{withMsg:{id:0}}) %>child`})
    await f.begin(2,'new',f.runtime,'child');await f.run(f.runtime,'child');await f.end(2,'plain',f.runtime,'child')
    const child=await f.runtime.storyWorkspace(f.cardId,childId)
    expect((await loadTemplateState(child.fs)).messageVariables?.snapshots[first.id]?.values.hp).toBe(90)
    expect((await loadTemplateState(f.ws.fs)).messageVariables?.snapshots[first.id]?.values.hp).toBe(5)
    await child.wal.rollbackFloor('child#t2',child.fs.root)
    expect((await loadTemplateState(child.fs)).messageVariables?.snapshots[first.id]?.values.hp).toBe(5)
  })
  it('编辑 assistant 创建新 id 即使 seq 不变也不继承被撤销的旧快照',async()=> {
    const f=await fixture();await f.begin(1,'one');await f.run();await f.end(1,'first')
    await f.runtime.saveCharacter(f.cardId,{description:'<% setvar("hp",9) %>role'})
    await f.begin(2,'two');await f.run();const previous=await f.end(2,'old answer')
    const childId=newStoryId();await snapshotStory({cardRoot:join(f.paths.characters,f.cardId),sourceRoot:f.ws.fs.root,id:childId,sessionId:'child',includeWal:true})
    const child=await f.runtime.storyWorkspace(f.cardId,childId);await child.wal.rollbackFloor('s1#t2',child.fs.root)
    await saveBinding(f.paths,{...f.binding,sessionId:'child',storyId:childId})
    const edited=withEditedAssistantMessage(f.events,previous.message.id,'edited answer')!
    const changed=edited.find(value=>value.type==='assistant/message' && value.data.turn===2)!
    if(changed.type!=='assistant/message') throw Error('missing edited assistant')
    const source=f.events.find(value=>value.type==='assistant/message' && value.data.turn===2)!
    expect(changed.seq).toBe(source.seq);expect(changed.data.message.id).not.toBe(previous.message.id)
    f.events.splice(0,f.events.length,...edited)
    f.messages.splice(f.messages.findIndex(message=>message.id===previous.message.id),1,changed.data.message)
    await f.runtime.saveCharacter(f.cardId,{description:`<%- getMessageVar('hp',{withMsg:{id:3}}) %>`})
    await f.begin(3,'three',f.runtime,'child');await f.run(f.runtime,'child')
    const saved=await loadTemplateState(child.fs)
    expect(saved.messageVariables?.snapshots[previous.message.id]).toBeUndefined()
    expect(saved.messageVariables?.snapshots[changed.data.message.id]?.values.hp).toBe(5)
    expect((await loadTemplateState(f.ws.fs)).messageVariables?.snapshots[previous.message.id]?.values.hp).toBe(9)
  },10000)
  it('重启恢复核验历史快照摘要，损坏指纹不能执行回复或覆盖正文状态',async()=> {
    const f=await fixture();await f.begin(1,'one');await f.run()
    const saved=await loadTemplateState(f.ws.fs)
    if(saved.generation?.status!=='prepared') throw Error('missing prepared generation')
    saved.generation.replay.messageVariablesHash='0'.repeat(64)
    await f.ws.fs.writeText(TEMPLATE_STATE_PATH,JSON.stringify(saved))
    const before=await f.ws.fs.readText(TEMPLATE_STATE_PATH)
    await expect(f.end(1,'<% setvar("executed",true) %>',await f.fresh())).rejects.toThrow(/历史消息变量/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
  })
  it('旧单树只锚到当前目标，预览不迁移落盘，JSON及旧 replay 边界明确拒绝',async()=> {
    const f=await fixture('plain');await f.begin(1,'one')
    await saveTemplateState(f.ws.fs.withFloor('s1#t1'),{version:1,variables:{global:{},local:{},message:{legacy:7}},outputs:{}})
    const before=await f.ws.fs.readText(TEMPLATE_STATE_PATH)
    await runTavernPipeline({state:f.runtime,sessionId:'s1',agent:f.agent(),mode:'preview'})
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    await f.run()
    const saved=await loadTemplateState(f.ws.fs)
    expect(Object.values(saved.messageVariables!.snapshots)).toEqual([frame({legacy:7})])
    expect(()=>parseTemplateMessageIdentities([{messageId:'x',swipeId:0},{messageId:'x',swipeId:0}],2)).toThrow(/重复/)
    expect(()=>parseTemplateMessageVariables(JSON.parse('{"version":1,"snapshots":{"__proto__":{"values":{},"initialized":true}}}'))).toThrow(/原型/)
    expect(()=>parseTemplateMessageVariables(state({x:frame({x:'x'.repeat(1024*1024)})}))).toThrow(/上限/)
    expect(()=>parseTemplateReplay({version:1})).toThrow(/版本不兼容/)
  })
})
