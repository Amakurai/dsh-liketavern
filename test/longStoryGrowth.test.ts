/** 长剧情增长回归（issue #12）：真实管线逐楼推进，每楼新增的重放操作、数据块与日志字节不随历史增长，分支后状态一致。 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState, TEMPLATE_GENERATION_PATH } from '../src/state/template.js'
import { TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
const user=(text:string)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
const assistant=(text:string)=>createAssistantMessage({source:{provider:'factory',model:'factory'},content:[{type:'text',text}]})
const event=(type:string,data:unknown,seq:number):SessionEvent=>({type,data,seq,time:0,...(type.endsWith('/message')?{surfaceOp:'append'}:{})} as unknown as SessionEvent)
const MARKER='角色设定专用标记'

it('十余楼后每楼新增的重放操作、数据块与日志保持有界，计划正文不随楼层累积，分支得到相同状态',async()=> {
  const root=await mkdtemp(join(tmpdir(),'tavern-long-story-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const runtime=new TavernState(paths,()=>resolveConfig({}));await runtime.init()
  // 设定在历史之前读取模拟序列，结尾指令在历史之后读取累积缓冲：两处都要带上全部历史。
  const card=parseJsonCard({name:'Alice',description:`<% incvar('turns');define('status',()=>'回合'+getvar('turns')) %>${MARKER}`+'设定正文'.repeat(1500),
    scenario:'场景 <%- generateData.length %>',post_history_instructions:'结尾 <%- generateBuffer.length %>'})
  const {cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:'Alice',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await runtime.loadBinding('s1'))!,ws=await runtime.storyWorkspace(cardId,binding.storyId)
  const messages:Message[]=[],events:SessionEvent[]=[]
  const agent={options:{},session:{id:'s1',snapshotEvents:()=>events,deriveMessages:()=>messages}} as unknown as Agent
  const session={id:'s1' as Session['id'],snapshotEvents:()=>events}
  const blocks=async()=>(await ws.fs.list(TEMPLATE_DATA_PATH)).length
  const bodies=()=>readdir(join(ws.fs.root,TEMPLATE_GENERATION_PATH)).catch(()=>[] as string[])
  const operations:number[]=[],added:number[]=[],logs:number[]=[],bodyChars:number[]=[]
  const turns=14
  for(let turn=1;turn<=turns;turn++) {
    const before=await blocks()
    events.push(event('turn/start',{turn},events.length));await onTurnStart(runtime,'s1',turn,session)
    const input=user(`第${turn}轮：`+'提问'.repeat(40));messages.push(input);events.push(event('user/message',input,events.length))
    await runTavernPipeline({state:runtime,sessionId:'s1',agent,mode:'live'})
    const prepared=(await loadTemplateState(ws.fs)).generation
    if(prepared?.status!=='prepared') throw new Error('缺少工厂生成计划')
    operations.push(prepared.replay.operations.length)
    const files=await bodies()
    // 状态超过内联上限后，未结束的计划只有一份单独存放的正文。
    if(files.length) {
      expect(files).toHaveLength(1)
      bodyChars.push((await ws.fs.readText(`${TEMPLATE_GENERATION_PATH}/${files[0]}`))!.length)
    }
    const reply=assistant(`第${turn}轮回复：`+'剧情正文，'.repeat(500));messages.push(reply)
    events.push(event('assistant/message',{stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}],turn,step:1,message:reply},events.length))
    events.push(event('turn/end',{turn,reason:{kind:'completed'}},events.length))
    await onTurnEnd(runtime,'s1',session)
    expect(await bodies()).toEqual([])
    added.push(await blocks()-before)
    logs.push((await ws.fs.stat(`state/wal/s1_t${turn}/records.jsonl`))!.size)
  }
  // 重放操作只取决于模板来源，不随消息数增加。
  expect(new Set(operations.slice(2)).size).toBe(1)
  // 计划正文随可见历史增长，但始终只有当前这一份，不留在数据块与日志里。
  expect(bodyChars.length).toBeGreaterThan(5)
  expect(bodyChars.at(-1)!).toBeGreaterThan(100_000)
  let stored=''
  for(const file of await ws.fs.list(TEMPLATE_DATA_PATH)) stored+=await ws.fs.readText(`${TEMPLATE_DATA_PATH}/${file}`)
  expect(stored).not.toContain(MARKER)
  // 状态进入分块后：每楼只新增本楼回复与少量分页，日志只记这些增量，都远小于当轮计划正文。
  const late=added.slice(-5),lateLogs=logs.slice(-5)
  expect(Math.max(...late)).toBeLessThan(40)
  expect(Math.max(...lateLogs)).toBeLessThan(bodyChars.at(-1)!/2)
  expect(Math.max(...lateLogs)).toBeLessThan(Math.min(...lateLogs)*2)
  const state=await loadTemplateState(ws.fs)
  expect(Object.keys(state.outputs)).toHaveLength(turns)
  expect(state.variables.message.turns).toBe(turns)
  expect(state.generation?.status).toBe('completed')
  // 分支快照继承全部回复与日志，得到同一份状态。
  const id=newStoryId(),cardRoot=join(paths.characters,cardId)
  await snapshotStory({cardRoot,sourceRoot:ws.fs.root,id,sessionId:'child',includeWal:true})
  expect(await loadTemplateState(new WorkspaceFs(storyRoot(cardRoot,id),null))).toEqual(state)
},120000)
