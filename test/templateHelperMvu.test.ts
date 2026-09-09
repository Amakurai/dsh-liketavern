/** 模板 MVU 桥回归：真实 QuickJS、剧情文件与 WAL 验证只读投影、宏、冻结重放及剧情隔离。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { parseTemplateHelperMvu, projectTemplateHelperMvu } from '../src/core/templateHelperMvu.js'
import { expandMacros } from '../src/core/macros.js'
import { isolated } from '../src/node/isolated.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadHelperState, saveHelperState } from '../src/state/helper.js'
import { loadTemplateState } from '../src/state/template.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'
import type { WorkspaceFs } from '../src/state/workspaceFs.js'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { CONTINUE_INSTRUCTION_PREFIX } from '../src/core/dshPrompt.js'
import { currentHelperMvuTemplateData } from '../src/node/helperMvuTemplateSnapshot.js'
import { prepareHelperMvuJob, queueHelperMvuStop } from '../src/node/helperMvu.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const scope = (id: string) => JSON.stringify(['message', id])
const context = (): TemplateContext => ({ variables: { ...emptyTemplateScopes(), message: { count: 1 } }, char: 'Alice', user: 'Bob', card: {}, entries: [], presets: [],
  history: [{ role: 'assistant', content: 'old' }, { role: 'assistant', content: 'new' }, { role: 'user', content: 'next' }],
  historyIdentities: [{ messageId: 'a', swipeId: 0 }, { messageId: 'b', swipeId: 0 }, { messageId: 'u', swipeId: 0 }],
  helperMvu: { version: 1, snapshots: { a: { hp: 1 }, b: { hp: 2, pair: [3, '说明'], profile: { name: '角色' } } } }, now: 0, seed: 1, phase: 'generate' })
const render = (text: string, patch: Partial<TemplateContext> = {}) => isolated('template', { texts: [text], context: { ...context(), ...patch } })

it('按稳定可见身份投影，排除隐藏和兄弟消息，选择结果不引用源对象', () => {
  const source = { [scope('a')]: { stat_data: { hp: 1 } }, [scope('hidden')]: { stat_data: { secret: 99 } }, [JSON.stringify(['chat', ''])]: { stat_data: { hp: 100 } } }
  const result = projectTemplateHelperMvu(source, context().historyIdentities!)!
  expect(result).toEqual({ version: 1, snapshots: { a: { hp: 1 } } })
  source[scope('a')]!.stat_data.hp = 9
  expect(result.snapshots.a?.hp).toBe(1)
  expect(() => parseTemplateHelperMvu({ version: 1, snapshots: { hidden: {} } }, context().historyIdentities!)).toThrow(/不可见/)
  expect(projectTemplateHelperMvu(source, [])).toBeUndefined()
  expect(projectTemplateHelperMvu({[scope('a')]:{stat_data:null}},context().historyIdentities!)).toBeUndefined()
})

it('隔离入口拒绝伪造的空值或不可见 MVU 快照', async () => {
  await expect(render('text',{helperMvu:null as never})).rejects.toThrow(/快照无效/)
  await expect(render('text',{helperMvu:{version:1,snapshots:{hidden:{secret:1}}}})).rejects.toThrow(/不可见/)
})

it('getvar/variables/getMessageVar 读取最新 helper 快照，历史读取和 findVariables 保留消息边界', async () => {
  const result = await render(`<%- JSON.stringify([getvar('stat_data.hp'),variables.stat_data.hp,getMessageVar('stat_data.hp'),
    getMessageVar('stat_data.hp',{withMsg:{id:0}}),getMessageVar('stat_data.hp',{withMsg:{id:1}}),
    findVariables('stat_data',1).stat_data.hp,findVariables('stat_data').stat_data.hp,getvar('stat_data.pair')]) %>`)
  expect(JSON.parse(result.texts[0]!)).toEqual([2, 2, 2, 1, 2, 1, 2, [3, '说明']])
  expect(result.variables.message).toEqual({ count: 1 })
  expect(Object.values(result.messageVariables.snapshots).some(frame => Object.hasOwn(frame.values, 'stat_data'))).toBe(false)
})

it('MVU 只读视图不干扰普通模板写入和引用修改，不复制进任何可写模板表', async () => {
  const result = await render(`<% incvar('count'); getvar(null).extra=3; getvar('stat_data',{clone:true}).hp=99; %><%- variables.count %>/<%- getvar('stat_data.hp') %>`)
  expect(result.texts).toEqual(['2/2'])
  expect(result.variables.message.count).toBe(2)
  expect(result.variables.message).not.toHaveProperty('stat_data')
  expect(JSON.stringify(result.messageVariables)).not.toContain('stat_data')
})

it.each([
  `setvar('stat_data.hp',99)`, `incvar('stat_data.hp')`, `delvar('stat_data')`, `setGlobalVar('stat_data',{})`, `setvar(null,{})`,
  `setMessageVar('stat_data.hp',9,{withMsg:{id:0}})`, `variables.stat_data.hp=9`, `getvar(null).stat_data={}`,
  `delete variables.stat_data`, `findVariables('stat_data',1).stat_data.hp=9`, `getvar('stat_data.pair').push(4)`,
  `Object.getOwnPropertyDescriptor(getvar('stat_data'),'profile').value.name='伪造'`,
  `Object.defineProperty(variables,'stat_data',{value:{}})`,
  `setVariableSchema({stat_data:z.object({hp:z.number()}).default({hp:99})});incvar('count')`,
])('通过写 API、引用或描述符修改 stat_data 都明确失败：%s', async code => {
  await expect(render('<% ' + code + '; %>')).rejects.toThrow(/只读/)
})

it('未接入 MVU 的模板变量仍保持原有可写行为', async () => {
  const result = await render(`<% setvar('stat_data.hp',4); variables.stat_data.hp++; %><%- getvar('stat_data.hp') %>`, { helperMvu: undefined })
  expect(result.texts).toEqual(['5'])
  expect(result.variables.message.stat_data).toEqual({ hp: 4 })
})

it('宏从相同 stat_data 读取 JSON 和嵌套路径，写宏不进入临时 store', () => {
  const store = new Map<string, string>(), macro = { char: 'Alice', user: 'Bob', readonlyStatData: { hp: 2, pair: [3, '说明'] }, store }
  expect(expandMacros('{{getvar::stat_data.hp}}/{{getvar::stat_data.pair[0]}}/{{getvar::stat_data}}', macro)).toBe('2/3/{"hp":2,"pair":[3,"说明"]}')
  for (const text of ['{{setvar::stat_data.hp::9}}', '{{setglobalvar::stat_data::9}}', '{{addvar::stat_data.hp::1}}']) expect(() => expandMacros(text, macro)).toThrow(/只读/)
  expect(store.size).toBe(0)
})

const event = (type: string, data: unknown, seq: number): SessionEvent => ({ type, data, seq, time: 0, ...(type.endsWith('/message') ? { surfaceOp: 'append' } : {}) } as SessionEvent)
async function writeHelper(fs: WorkspaceFs, floor: string, id: string, hp: number) {
  const saved = await loadHelperState(fs)
  saved.scopes[scope(id)] = { stat_data: { hp }, schema: '没有用别管这个' }
  saved.mvu ??= {version:1,initialized:true,pending:[],completed:[]}
  await saveHelperState(fs.withFloor(floor), saved)
}
async function fixture(description = `EJS=<%- getvar('stat_data.hp') %>;MACRO={{getvar::stat_data.hp}};<% incvar('runs') %>`) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-template-mvu-')); roots.push(root)
  const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const fresh = async () => { const state = new TavernState(paths, () => resolveConfig({})); await state.init(); return state }
  const state = await fresh(), { cardId } = await importCard(paths.characters, parseJsonCard({ name: 'Alice', description }))
  await saveBinding(paths, { sessionId: 's1', cardId, cardName: 'Alice', presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, helperMvu:true, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding('s1'))!, ws = await state.storyWorkspace(cardId, binding.storyId)
  const greeting = createAssistantMessage({ content: [{ type: 'text', text: '开场白' }], source:TAVERN_GREETING_SOURCE }), messages: Message[] = [greeting]
  const events: SessionEvent[] = [event('assistant/message', { turn: 0, step: 0, message: greeting }, 0)]
  await ws.wal.beginFloor('s1#t0'); await writeHelper(ws.fs, 's1#t0', greeting.id, 10); await ws.wal.commitFloor('s1#t0')
  const agent = (id = 's1') => ({ options: {}, session: { id, deriveMessages: () => messages, snapshotEvents: () => events } } as unknown as Agent)
  const run = (runtime = state, id = 's1', mode: 'live' | 'preview' = 'live') => runTavernPipeline({ state: runtime, sessionId: id, agent: agent(id), mode })
  const begin = async (turn: number, text = '继续') => {
    events.push(event('turn/start', { turn }, events.length)); await onTurnStart(state, 's1', turn)
    const input = createUserMessage({ content: [{ type: 'text', text }], source:{kind:'user'} }); messages.push(input); events.push(event('user/message', input, events.length))
  }
  const end = async (turn: number, text = '回复') => {
    events.push(event('assistant/chunk', { turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }, events.length))
    const output = createAssistantMessage({ content: [{ type: 'text', text }] }); messages.push(output); events.push(event('assistant/message', { turn, step: 1, message: output }, events.length))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, events.length)); await onTurnEnd(state, 's1', { id: 's1' as never, snapshotEvents: () => events })
    // 此工厂只验模板桥；模拟原生 MVU 消费完成，具体租约/事件/提交由独立宿主集成覆盖。
    const saved=await loadHelperState(ws.fs)
    if(saved.mvu?.pending.length) {saved.mvu.pending=[];await saveHelperState(ws.fs.withFloor('s1#t'+turn),saved);await ws.wal.commitFloor('s1#t'+turn)}
    return output
  }
  return { state, fresh, paths, binding, ws, messages, events, greeting, run, begin, end }
}

it('真实剧情 MVU 更新进入下一轮 EJS/macros，同轮和重启恢复保持原始快照，模板文件不出现第二份 stat_data', async () => {
  const f = await fixture(); await f.begin(1)
  const first = (await f.run())!
  expect(first.system).toContain('EJS=10;MACRO=10')
  await writeHelper(f.ws.fs, 's1#t1', f.greeting.id, 12)
  expect(await f.run()).toBe(first)
  const restored = (await f.run(await f.fresh()))!
  expect(restored.system).toBe(first.system)
  expect(restored.templateContext?.helperMvu?.snapshots[f.greeting.id]?.hp).toBe(10)
  expect(parseTemplateReplay(first.templateReplay!).context.helperMvu).toEqual(first.templateContext?.helperMvu)
  await f.end(1)
  await f.begin(2)
  const next = (await f.run())!
  expect(next.system).toContain('EJS=12;MACRO=12')
  const stored = await loadTemplateState(f.ws.fs)
  expect(stored.variables.message.runs).toBe(2)
  expect(JSON.stringify(stored.variables)).not.toContain('stat_data')
  expect(JSON.stringify(stored.messageVariables)).not.toContain('stat_data')
  expect((await loadHelperState(f.ws.fs)).scopes[scope(f.greeting.id)]?.stat_data).toEqual({ hp: 12 })
})

it('预览只读，当前变量可继承模型裁剪的原始消息但历史投影与同角色其他剧情保持隔离', async () => {
  const f = await fixture()
  const hidden = createAssistantMessage({ content: [{ type: 'text', text: '不可见' }] })
  f.events.push(event('assistant/message', { turn: 0, step: 0, message: hidden }, f.events.length))
  await f.ws.wal.beginFloor('s1#t1'); await writeHelper(f.ws.fs, 's1#t1', hidden.id, 99); await f.ws.wal.commitFloor('s1#t1')
  const beforeHelper = await f.ws.fs.readText('state/helper.json'), beforeTemplate = await f.ws.fs.readText('state/template.json')
  const preview=await f.run(f.state, 's1', 'preview')
  expect(preview?.system).toContain('EJS=99;MACRO=99')
  expect(preview?.templateContext?.helperMvu?.current).toEqual({hp:99})
  expect(preview?.templateContext?.helperMvu?.snapshots).not.toHaveProperty(hidden.id)
  expect(preview?.templateContext?.history.map(item=>item.content)).not.toContain('不可见')
  expect(await f.ws.fs.readText('state/helper.json')).toBe(beforeHelper)
  expect(await f.ws.fs.readText('state/template.json')).toBe(beforeTemplate)
  await saveBinding(f.paths, { ...f.binding, sessionId: 's2', storyId: undefined })
  const second = (await f.state.loadBinding('s2'))!, ws = await f.state.storyWorkspace(second.cardId, second.storyId)
  await ws.wal.beginFloor('s2#t0'); await writeHelper(ws.fs, 's2#t0', f.greeting.id, 30); await ws.wal.commitFloor('s2#t0')
  expect((await f.run(f.state, 's2', 'preview'))?.system).toContain('EJS=30;MACRO=30')
})

it('跨轮 sticky 闭包读取新只读快照，原有模板变量 continuation 合同不变', async () => {
  const f = await fixture(`<% if(!getvar('registered')) {setvar('registered',true);activateRegex(/T[O]KEN/g,function(){return 'hp='+this.getvar('stat_data.hp')},{generate:true,system:false,sticky:3});} %>ROOT`)
  await f.begin(1,'TOKEN'); expect((await f.run())?.history.at(-1)?.content).toBe('hp=10')
  await writeHelper(f.ws.fs, 's1#t1', f.greeting.id, 15); await f.end(1)
  await f.begin(2,'TOKEN'); expect((await f.run())?.history.at(-1)?.content).toBe('hp=15')
  const stored = await loadTemplateState(f.ws.fs)
  expect(stored.variables.message.registered).toBe(true)
  expect(JSON.stringify(stored.variables)).not.toContain('stat_data')
})

it('关闭原生 MVU 时不注入只读字段，已有 helper 数据不抢占普通模板 stat_data', async () => {
  const f=await fixture(`<% setvar('stat_data.hp',5) %>普通=<%- getvar('stat_data.hp') %>`)
  await saveBinding(f.paths,{...f.binding,helperMvu:false})
  await f.begin(1)
  const result=(await f.run())!
  expect(result.system).toContain('普通=5')
  expect(result.templateContext?.helperMvu).toBeUndefined()
  expect((await loadTemplateState(f.ws.fs)).variables.message.stat_data).toEqual({hp:5})
  expect((await loadHelperState(f.ws.fs)).scopes[scope(f.greeting.id)]?.stat_data).toEqual({hp:10})
})

it('历史负下标只选可见消息，越界和不存在的 swipe 不回流其它快照',async()=>{
  const result=await render(`<%- JSON.stringify([getMessageVar('stat_data.hp',{withMsg:{id:-2}}),getMessageVar('stat_data.hp',{withMsg:{id:-20},defaults:'missing'}),getMessageVar('stat_data.hp',{withMsg:{id:-2,swipe_id:8},defaults:'missing'})]) %>`)
  expect(JSON.parse(result.texts[0]!)).toEqual([2,'missing','missing'])
})

it('默认当前基准与显式历史下标分开，设置 render message_id 不会改写轮初 current',async()=>{
  const result=await render(`<%- JSON.stringify([getvar('stat_data.hp'),variables.stat_data.hp,getMessageVar('stat_data.hp'),findVariables('stat_data').stat_data.hp,
    getMessageVar('stat_data.hp',{withMsg:{id:-2}}),findVariables('stat_data',1).stat_data.hp]) %>`,{
    helperMvu:{...context().helperMvu!,current:{hp:40}},phase:'render',renderMessages:[{index:0,role:'assistant',swipeId:0}],
  })
  expect(JSON.parse(result.texts[0]!)).toEqual([40,40,40,40,2,1])
})

it('真实 Session 摘要压缩后，模板当前基准与后台下一回复继承相同，旧正文不回流模型历史',async()=>{
  const f=await fixture(),id=f.binding.sessionId
  const session=Session.create(id as Session['id'])
  session.append('turn/start',{turn:1})
  const user=session.append('user/message',createUserMessage({content:[{type:'text',text:'旧用户台词'}],source:{kind:'user'}}),{surfaceOp:'append'})
  session.append('step/start',{turn:1,step:1})
  session.append('assistant/chunk',{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}})
  const first=session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'旧角色原文'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  session.append('step/end',{turn:1,step:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  await f.ws.wal.beginFloor(id+'#t1');await writeHelper(f.ws.fs,id+'#t1',first.data.message.id,27);await f.ws.wal.commitFloor(id+'#t1')
  session.append('user/message',createUserMessage({content:[{type:'text',text:'压缩摘要'}],source:{kind:'user'}}),{surfaceOp:{op:'replace',start:user.seq,end:first.seq},sourceEventSeqs:[user.seq,first.seq]})
  session.append('turn/start',{turn:2});session.append('user/message',createUserMessage({content:[{type:'text',text:'下一条用户输入'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const agent={options:{},session} as unknown as Agent
  await onTurnStart(f.state,id,2,session)
  const plan=(await runTavernPipeline({state:f.state,sessionId:id,agent,mode:'live'}))!
  expect(plan.system).toContain('EJS=27;MACRO=27')
  expect(plan.templateContext?.history.map(item=>item.content)).toEqual(['压缩摘要','下一条用户输入'])
  expect(plan.templateContext?.helperMvu).toEqual({version:1,current:{hp:27},snapshots:{}})
  const explicit=await isolated('template',{texts:[`<%- getMessageVar('stat_data.hp',{withMsg:{id:0},defaults:'missing'}) %>`],context:plan.templateContext!})
  expect(explicit.texts).toEqual(['missing'])
  session.append('step/start',{turn:2,step:1});session.append('assistant/chunk',{turn:2,step:1,chunk:{type:'finish',reason:{kind:'stop'}}})
  session.append('assistant/message',{turn:2,step:1,message:createAssistantMessage({content:[{type:'text',text:"_.add('hp',2);"}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  session.append('step/end',{turn:2,step:1})
  const ctx={sessions:{get:()=>session},agents:{get:()=>agent}} as unknown as Context
  await queueHelperMvuStop(f.state,id,session)
  const work=await prepareHelperMvuJob(ctx,f.state,{sessionId:id,storyId:f.binding.storyId!,runtimeId:'template-compression'})
  expect(work.base?.stat_data).toEqual(plan.templateContext?.helperMvu?.current)
  expect(work.base?.stat_data).toEqual({hp:27})
})

it('当前基准沿用最近普通消息的手动变量，摘要替换与续写指令的 scope 不参与后台继承',()=>{
  const session=Session.create('template-mvu-current' as Session['id']),scopes:Record<string,Record<string,unknown>>={}
  const assistant=session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'旧角色回复'}]})},{surfaceOp:'append'})
  scopes[scope(assistant.data.message.id)]={stat_data:{hp:10}}
  const user=session.append('user/message',createUserMessage({content:[{type:'text',text:'手动修改变量的用户消息'}]}),{surfaceOp:'append'})
  scopes[scope(user.data.id)]={stat_data:{hp:15}}
  const summary=session.append('user/message',createUserMessage({content:[{type:'text',text:'摘要'}]}),{surfaceOp:{op:'replace',start:assistant.seq,end:user.seq},sourceEventSeqs:[assistant.seq,user.seq]})
  scopes[scope(summary.data.id)]={stat_data:{hp:999}}
  const continuation=session.append('user/message',createUserMessage({content:[{type:'text',text:CONTINUE_INSTRUCTION_PREFIX+'继续'}]}),{surfaceOp:'append'})
  scopes[scope(continuation.data.id)]={stat_data:{hp:888}}
  expect(currentHelperMvuTemplateData(session.snapshotEvents(),scopes)).toEqual({hp:15})
  scopes[scope(user.data.id)]={stat_data:null}
  expect(currentHelperMvuTemplateData(session.snapshotEvents(),scopes)).toEqual({hp:10})
})
