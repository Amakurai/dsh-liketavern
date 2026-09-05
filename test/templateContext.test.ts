/** 消息上下文兼容：冻结文本索引与宿主 seq 分离，真实文件/WAL 验证多 step 回复、深度及只提交一次。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyTemplateScopes, type TemplateContext, type TemplateMessageMetadata } from '../src/core/template.js'
import type { CharacterCard, ChatMessage } from '../src/core/types.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { isolated } from '../src/node/isolated.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { completeTemplateOutput } from '../src/node/templateOutput.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { loadTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { importCard } from '../src/state/workspace.js'

const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({
  variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],now:1000,seed:42,phase:'generate',...patch,
})
const facts=`JSON.stringify({name,message_id,swipe_id,is_last,is_user,is_system,hostMessageId,
  lastUserMessageId,lastCharMessageId,lastMessageId,assistantName,model,current:getChatMessage(message_id),user:lastUserMessage})`

describe('默认及逐条消息上下文',()=> {
  it('默认名字、模型和历史索引一致，生成期间不伪造当前消息元数据',async()=> {
    const history:ChatMessage[]=[{role:'user',content:'first'},{role:'system',content:'system'},{role:'assistant',content:'answer'},{role:'user',content:'last'}]
    const result=await isolated('template',{context:context({history,model:'selected-model'}),texts:[`<%- JSON.stringify([
      assistantName,charName,userName,model,groupId,groups,lastUserMessageId,lastCharMessageId,lastMessageId,
      getChatMessage(lastUserMessageId),getChatMessage(lastCharMessageId),lastUserMessage,lastCharMessage,
      typeof name,typeof message_id,typeof swipe_id,typeof is_last,typeof is_user,typeof is_system,typeof hostMessageId,isDryRun
    ]) %>`]})
    expect(JSON.parse(result.texts[0]!)).toEqual(['Alice','Alice','Bob','selected-model',null,[],3,2,3,'last','answer','last','answer',
      'undefined','undefined','undefined','undefined','undefined','undefined','undefined',false])
  })
  it('空历史的最后索引为 -1，独立预览没有捏造模型或宿主序号',async()=> {
    const result=await isolated('template',{context:context(),texts:['<%- JSON.stringify([lastUserMessageId,lastCharMessageId,lastMessageId,lastUserMessage,lastCharMessage,model]) %>']})
    expect(JSON.parse(result.texts[0]!)).toEqual([-1,-1,-1,'','',''])
  })
  it('RENDER BEFORE/AFTER 和正文共享当前消息角色、姓名、索引与最后标记',async()=> {
    const history:ChatMessage[]=[{role:'user',content:'input',name:'Persona'},{role:'system',content:'notice'},{role:'assistant',content:'reply'}]
    const renderMessages:TemplateMessageMetadata[]=[
      {index:0,role:'user',swipeId:0,hostMessageId:91},
      {index:1,role:'system',swipeId:0,name:'Narrator',hostMessageId:97},
      {index:2,role:'assistant',swipeId:0,hostMessageId:103},
    ]
    const entries=parseLorebook({entries:[
      {uid:1,comment:'[RENDER:BEFORE]',content:'<%- name %>:<%- message_id %>'},
      {uid:2,comment:'[RENDER:AFTER]',content:'<%- is_last %>'},
    ]},{source:'character',sourceRef:'card'})
    const result=await isolated('template',{context:context({history,renderMessages,entries,phase:'render'}),decorateOutput:true,texts:history.map(()=>`<%- ${facts} %>`)})
    expect(result.texts.map(text=>text.split('\n')[0])).toEqual(['Persona:0','Narrator:1','Alice:2'])
    const values=result.texts.map(text=>JSON.parse(text.split('\n')[1]!))
    expect(values).toMatchObject([
      {name:'Persona',message_id:0,swipe_id:0,is_last:false,is_user:true,is_system:false,hostMessageId:91,current:'input'},
      {name:'Narrator',message_id:1,swipe_id:0,is_last:false,is_user:false,is_system:true,hostMessageId:97,current:'notice'},
      {name:'Alice',message_id:2,swipe_id:0,is_last:true,is_user:false,is_system:false,hostMessageId:103,current:'reply'},
    ])
  })
  it('上下文越界或角色不一致明确拒绝，不退回最后一条冒充成功',async()=> {
    for(const metadata of [{index:4,role:'assistant' as const,swipeId:0},{index:0,role:'user' as const,swipeId:0},{index:0,role:'assistant' as const,swipeId:-1}]) {
      await expect(isolated('template',{context:context({phase:'render',history:[{role:'assistant',content:'text'}],renderMessages:[metadata]}),decorateOutput:true,texts:['text']})).rejects.toThrow(/消息上下文/)
    }
  })
})

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
async function setup() {
  const root=await mkdtemp(join(tmpdir(),'tavern-template-context-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const state=new TavernState(paths,()=>resolveConfig({}));await state.init()
  const card:CharacterCard={spec:'chara_card_v2',name:'Alice',description:'<%- model %>',personality:'',scenario:'',firstMes:'',alternateGreetings:[],mesExample:'',
    systemPrompt:'',postHistoryInstructions:'',creatorNotes:'',creator:'',characterVersion:'1',tags:[],characterBook:null,regexScripts:[],extensions:{},pngBytes:null,raw:{},depthPrompt:null}
  const {cardId}=await importCard(paths.characters,card)
  for(const sessionId of ['s1','s2']) await saveBinding(paths,{sessionId,cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  return {state,cardId,ws}
}
function messageEvents(step:number,seq:number,text:string,finish:'stop'|'tool-calls'='stop',interrupted=false):SessionEvent[] {
  return [
    {type:'assistant/chunk',seq:seq-1,time:0,data:{turn:1,step,chunk:{type:'finish',reason:{kind:finish}}}},
    {type:'assistant/message',seq,time:0,data:{turn:1,step,message:createAssistantMessage({content:[{type:'text',text}]}),...(interrupted?{interrupted:true}:{})}},
  ] as SessionEvent[]
}

describe('多 step 宿主回复上下文',()=> {
  it('普通文本与工具前言占文本索引，两个 stop 回复得到独立深度并只提交一次',async()=> {
    const {state,cardId,ws}=await setup()
    // preload 先于轮首 message 清理，sticky=2 才保留到本轮回复；这里专测深度与消息元数据。
    await state.saveCharacter(cardId,{characterBook:{entries:[{uid:1,comment:'depth',content:'@@only_preload\n<% activateRegex(/DEPTH/g,"older",{message:true,sticky:2,minDepth:1,maxDepth:1}); %>'}]}})
    await onTurnStart(state,'s1',1)
    await runTavernPipeline({state,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'hello'},{role:'assistant',content:'old'},{role:'user',content:'new'}]})
    const body=`<% incvar('renders') %><%- ${facts} %>|DEPTH`
    const events:SessionEvent[]=[
      ...messageEvents(1,41,'tool preface','tool-calls'),
      ...messageEvents(2,51,'plain reply'),
      ...messageEvents(3,61,body),
      ...messageEvents(4,71,body),
      ...messageEvents(5,81,'interrupted','stop',true),
      {type:'turn/end',seq:90,time:0,data:{turn:1,reason:{kind:'completed'}}},
    ]
    const session:Pick<Session,'id'|'snapshotEvents'>={id:'s1' as Session['id'],snapshotEvents:()=>events}
    await completeTemplateOutput(state,session)
    const saved=await loadTemplateState(ws.fs)
    const firstText=saved.outputs['61']!.text,lastText=saved.outputs['71']!.text
    const first=JSON.parse(firstText.slice(0,firstText.lastIndexOf('|'))),last=JSON.parse(lastText.slice(0,lastText.lastIndexOf('|')))
    expect(first).toMatchObject({name:'Alice',message_id:5,swipe_id:0,hostMessageId:61,is_last:false,lastUserMessageId:2,lastCharMessageId:6,lastMessageId:6,current:body,user:'new'})
    expect(last).toMatchObject({message_id:6,hostMessageId:71,is_last:true,current:body})
    expect(saved.outputs['61']!.text.endsWith('|older')).toBe(true)
    expect(saved.outputs['71']!.text.endsWith('|DEPTH')).toBe(true)
    expect(saved.outputs['41']).toBeUndefined();expect(saved.outputs['81']).toBeUndefined()
    expect(saved.variables.message.renders).toBe(2)
    await completeTemplateOutput(state,session)
    expect(await loadTemplateState(ws.fs)).toEqual(saved)
    const sibling=(await state.loadBinding('s2'))!,other=await state.storyWorkspace(cardId,sibling.storyId)
    expect(await other.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('首次组装后冻结实际模型选择，同轮宿主配置变化不改变回复上下文',async()=> {
    const {state}=await setup()
    await onTurnStart(state,'s1',1)
    const options={provider:'test-provider',model:'model-a'}
    const agent={options,session:{deriveMessages:()=>[createUserMessage({content:[{type:'text',text:'hello'}]})]}} as unknown as Agent
    const request={state,sessionId:'s1',agent,mode:'live' as const}
    const first=await runTavernPipeline(request)
    expect(first!.templateContext!.model).toBe('model-a')
    expect(first!.turnContext).toContain('model-a')
    options.model='model-b'
    expect((await runTavernPipeline(request))!.templateContext!.model).toBe('model-a')
  })
})
