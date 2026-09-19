/** 输入身份回归：真实剧情文件与 Session、隔离组装验证图片位置、插件通知隔离以及同文不同 ID 的冻结计划。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defaultPreset } from '../src/core/assemble.js'
import { Marker, type PresetEntry } from '../src/core/types.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
const text=(value:string)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:value}]})
const image=()=>createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:{
  attachmentId:AttachmentId('a'.repeat(64)),mediaType:'image/png',bytes:32,width:1,height:1,name:'factory.png',
}}]})
const notice=()=>createUserMessage({source:{kind:'plugin',plugin:'factory-notice',form:'notice',summary:'工厂通知'},
  content:[{type:'text',text:'FACTORY-KEY'}]})
const entry=(identifier:string,content:string,other:Partial<PresetEntry>={}):PresetEntry=>({identifier,name:identifier,content,
  role:'system',enabled:true,position:'relative',depth:0,order:10,marker:false,...other})

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'preset-input-identity-'));roots.push(root)
  const state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),
    personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init()
  const {cardId}=await state.createCharacter('输入身份工厂')
  await state.saveLorebook('factory-book',{entries:{one:{uid:1,key:['FACTORY-KEY'],content:'KEYWORD-LORE',constant:false}}})
  const preset={...defaultPreset(),identifier:'input-identity-factory',entries:[
    entry('main','<% incvar("planRuns") %>USER={{lastusermessage}}|LAST={{lastmessage}}|CHAR={{lastcharmessage}}'),
    entry(Marker.WorldInfoBefore,'',{marker:true,markerId:Marker.WorldInfoBefore,order:15}),
    entry(Marker.ChatHistory,'',{marker:true,markerId:Marker.ChatHistory,order:20}),
    entry('depth-guide','DEPTH-GUIDE',{position:'in-chat',depth:1,role:'assistant',order:5}),
  ]}
  const presetId=await state.savePreset(preset)
  const session=Session.create(SessionId('input-identity'))
  await state.saveBinding({sessionId:session.id,cardId,presetId,personaId:null,lorebookIds:['factory-book'],characterLorebookId:null,
    interactiveCards:false,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const agent={id:session.id,options:{},session} as unknown as Agent
  const run=()=>runTavernPipeline({state,sessionId:session.id,agent,mode:'live'})
  const begin=async(turn:number)=>{session.append('turn/start',{turn});await onTurnStart(state,session.id,turn,session)}
  const pending=(messages:UserMessage[])=> {
    const values=messages.map(message=>({id:message.id,text:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),
      hasImage:message.content.some(block=>block.type==='image'),chat:message.source.kind==='user'}))
    state.pendingInputs.set(session.id,values.map(value=>value.text))
    state.pendingTemplateInputs.set(session.id,values)
  }
  const baseline=(first:UserMessage)=> {
    session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1})
    session.append('user/message',first,{surfaceOp:'append'})
    const answer=createAssistantMessage({source:{provider:'factory',model:'factory'},content:[{type:'text',text:'REAL-ANSWER'}]})
    session.append('assistant/message',{turn:1,step:1,message:answer,stream:[]},{surfaceOp:'append'})
    session.append('step/end',{turn:1,step:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}})
    return answer
  }
  return {state,session,run,begin,pending,baseline}
}

describe('当前输入的稳定身份',()=> {
  it('首条纯图片未入日志时就保留 ID、真实深度及模板历史位置',async()=> {
    const f=await fixture(),current=image()
    await f.begin(1);f.pending([current])
    const original=f.session.snapshotEvents()
    const result=(await f.run())!
    expect(result.layout!.history).toEqual([{inputIndex:0,messageId:current.id,role:'user',chat:true}])
    expect(result.layout!.entries.find(value=>value.content==='DEPTH-GUIDE')!.placement).toMatchObject({kind:'depth',depth:1,
      next:{messageId:current.id}})
    expect(result.templateContext!.history).toEqual([{role:'user',content:'',name:result.userName}])
    expect(result.templateContext!.historyIdentities?.map(value=>value.messageId)).toEqual([current.id])
    expect(result.templateContext!.history).toHaveLength(result.layout!.history.length)
    expect(result.system).toContain('USER=|LAST=|CHAR=')
    expect(f.session.snapshotEvents()).toEqual(original)
  })

  it('已有历史后的当前纯图片成为 depth=1 的 next，已入日志图片按 ID 只出现一次',async()=> {
    const f=await fixture(),first=text('REAL-QUESTION'),answer=f.baseline(first),current=image()
    await f.begin(2);f.pending([current])
    const result=(await f.run())!
    expect(result.layout!.entries.find(value=>value.content==='DEPTH-GUIDE')!.placement).toMatchObject({kind:'depth',
      previous:{messageId:answer.id},next:{messageId:current.id}})
    expect(result.templateContext!.historyIdentities?.map(value=>value.messageId)).toEqual([first.id,answer.id,current.id])
    expect(result.templateContext!.history).toHaveLength(result.layout!.history.length)
    expect(result.templateContext!.history.at(-1)?.content).toBe('')
    f.session.append('step/start',{turn:2,step:1})
    f.session.append('user/message',current,{surfaceOp:'append'})
    const replay=await f.run()
    expect(replay).toBe(result)
    expect(replay!.layout!.history.filter(value=>value.messageId===current.id)).toHaveLength(1)
  })

  it('相同台词的不同 ID 不吞输入，已入日志的旧 ID 不重复追加',async()=> {
    const f=await fixture(),first=text('SAME'),answer=f.baseline(first),second=text('SAME'),third=text('SAME')
    await f.begin(2);f.pending([first,second,third])
    const result=(await f.run())!
    const ids=[first.id,answer.id,second.id,third.id]
    expect(result.layout!.history.map(value=>value.messageId)).toEqual(ids)
    expect(result.templateContext!.historyIdentities?.map(value=>value.messageId)).toEqual(ids)
    expect(result.templateContext!.history.map(value=>value.content)).toEqual(['SAME','REAL-ANSWER','SAME','SAME'])
    expect(result.layout!.entries.find(value=>value.content==='DEPTH-GUIDE')!.placement).toMatchObject({kind:'depth',
      previous:{messageId:second.id},next:{messageId:third.id}})
    expect(f.session.deriveMessages().map(message=>message.id)).toEqual([first.id,answer.id])
  })
})

describe('插件通知与真实台词隔离',()=> {
  it('已落日志和待接收插件通知均保留模板索引，但不触发 WI、不占聊天深度或台词宏',async()=> {
    const f=await fixture(),first=text('REAL-QUESTION'),answer=f.baseline(first),stored=notice(),incoming=notice()
    await f.begin(2)
    f.session.append('step/start',{turn:2,step:1})
    f.session.append('user/message',stored,{surfaceOp:'append'})
    f.pending([incoming])
    const result=(await f.run())!
    expect(result.system).toContain('USER=REAL-QUESTION|LAST=REAL-ANSWER|CHAR=REAL-ANSWER')
    expect(result.system).not.toContain('KEYWORD-LORE')
    expect(result.assembled.messages.some(value=>value.content==='KEYWORD-LORE')).toBe(false)
    expect(result.templateContext!.history.map(value=>value.content)).toEqual(['REAL-QUESTION','REAL-ANSWER','FACTORY-KEY','FACTORY-KEY'])
    expect(result.layout!.history.map(value=>[value.messageId,value.chat])).toEqual([
      [first.id,true],[answer.id,true],[stored.id,false],[incoming.id,false]])
    expect(result.layout!.entries.find(value=>value.content==='DEPTH-GUIDE')!.placement).toMatchObject({kind:'depth',
      previous:{messageId:first.id},next:{messageId:answer.id}})
    expect(result.templateContext!.history).toHaveLength(result.layout!.history.length)
  })
})
