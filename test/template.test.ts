/** 模板行为与失败边界：真实隔离器、真实文件/WAL、模拟宿主事件，覆盖冻结、预览、回滚和回复幂等。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { emptyTemplateScopes, parseTemplateScopes, type TemplateContext } from '../src/core/template.js'
import type { CharacterCard } from '../src/core/types.js'
import { isolated } from '../src/node/isolated.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { saveBinding } from '../src/node/bindings.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { completeTemplateOutput } from '../src/node/templateOutput.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context = (patch: Partial<TemplateContext> = {}): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'Alice', user: 'Bob', card: { name: 'Alice', description: '角色描述' },
  entries: [], presets: [], history: [{ role: 'user', content: '你好' }], now: 1000, seed: 42, phase: 'generate', ...patch,
})
const render = (text: string, patch: Partial<TemplateContext> = {}) => isolated('template', { texts: [text], context: context(patch) })

describe('隔离 EJS', () => {
  it('执行条件、循环、转义、注释、空白控制和异步表达式', async () => {
    const result = await render('<%# comment %><% for (const n of [1,2]) { %><%- n %><% } %>|<%= "<b>" %>|<%- await Promise.resolve(char) -%>\n!')
    expect(result.texts).toEqual(['12|<b>|Alice!'])
    expect((await render('<%%= literal %%>')).texts).toEqual(['<%= literal %>'])
  })
  it('变量路径、作用域、初始树、nx 和临时变量符合预期', async () => {
    const entries = parseLorebook({ entries: [{ uid: 1, comment: '[InitialVariables]', content: '{"affinity":5}', constant: true }] }, { source: 'character', sourceRef: 'card' })
    const result = await render('<% incvar("affinity", 2); setLocalVar("world.items[0]", "apple"); setGlobalVar("day",1,"nx"); setGlobalVar("day",9,"nx"); setvar("temp",42,"cache"); %><%- variables.affinity %>/<%- getLocalVar("world.items[0]") %>/<%- getGlobalVar("day") %>', { entries })
    expect(result.texts).toEqual(['7/apple/1'])
    expect(result.variables.message).toEqual({ affinity: 7 })
    expect(result.variables.local).toEqual({ world: { items: ['apple'] } })
    expect(result.variables.global).toEqual({ day: 1 })
  })
  it('读取当前资产并执行嵌套模板、define、print', async () => {
    const entries = parseLorebook({ entries: [{ uid: 2, comment: '天气', content: '<%- weather %>，<%- char %>', constant: true }] }, { source: 'character', sourceRef: 'card' })
    const result = await render('<% define("hello", () => "Hi"); print(hello(),":"); %><%- await getwi("天气", {weather:"晴"}) %>|<%- await getpreset("规则") %>|<%- getChatMessage(-1) %>', {
      entries, presets: [{ identifier: 'rule', name: '规则', content: '<%- user %>规则' }],
    })
    expect(result.texts).toEqual(['Hi:晴，Alice|Bob规则|你好'])
    expect((await render('<%- _.isEqual({a:1,b:[2]}, {b:[2],a:1}) %>/<%- _.isEqual([1,2],[2,1]) %>')).texts).toEqual(['true/false'])
  })
  it('YAML 初始值与 JSON 初始值等价，拒绝循环别名和非 JSON 状态', async () => {
    const entries = parseLorebook({ entries:[{uid:1,comment:'[InitialVariables]',content:'world:\n  affinity: 12\n  items: [apple, pear]',constant:true}] }, {source:'character',sourceRef:'card'})
    expect((await render('<%- getvar("world.affinity") %>/<%- variables.world.items[1] %>',{entries})).texts).toEqual(['12/pear'])
    entries[0]!.content = 'world: &loop\n  next: *loop'
    await expect(render('x',{entries})).rejects.toThrow()
    await expect(render('<% setvar("bad", Infinity) %>')).rejects.toThrow(/JSON/)
    await expect(render('<% setvar("bad", ()=>1) %>')).rejects.toThrow(/JSON/)
  })
  it('不给第三方脚本 Node、模块、网络或浏览器权限', async () => {
    const result = await render('<%- [typeof process,typeof require,typeof fetch,typeof window,typeof WebAssembly,Function("return typeof process")()].join(",") %>')
    expect(result.texts[0]).toBe('undefined,undefined,undefined,undefined,undefined,undefined')
    await expect(render('<%- await import("node:fs") %>')).rejects.toThrow()
    await expect(render('<% setvar("__proto__.polluted",1) %>')).rejects.toThrow(/变量路径/)
    expect(() => parseTemplateScopes(JSON.parse('{"global":{"__proto__":{}},"local":{},"message":{}}'))).toThrow()
  })
  it('脚本异常、未完成 Promise、超量输出和无限循环明确失败', async () => {
    await expect(render('<% throw Error("broken") %>')).rejects.toThrow(/broken/)
    await expect(render('<%- await new Promise(()=>{}) %>')).rejects.toThrow(/未完成/)
    await expect(render('<%- "x".repeat(1100000) %>')).rejects.toThrow(/上限/)
    await expect(render('<% while(true){} %>')).rejects.toThrow(/interrupt|超时/)
    await expect(render('<% while(true){await Promise.resolve()} %>')).rejects.toThrow(/interrupt|超时/)
  }, 15000)
})

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(description = '<% incvar("visits"); %>访问=<%- getvar("visits") %>') {
  const root = await mkdtemp(join(tmpdir(), 'tavern-template-')); roots.push(root)
  const paths = { root, characters: join(root,'characters'), lorebooks: join(root,'lorebooks'), presets: join(root,'presets'), personas: join(root,'personas'), regexDir: join(root,'regex'), sessions: join(root,'sessions') }
  const state = new TavernState(paths, () => resolveConfig({})); await state.init()
  const card: CharacterCard = { spec:'chara_card_v2', name:'测试卡', description, personality:'', scenario:'', firstMes:'你好', alternateGreetings:[], mesExample:'', systemPrompt:'', postHistoryInstructions:'', creatorNotes:'', creator:'', characterVersion:'', tags:[], characterBook:null, regexScripts:[], extensions:{}, pngBytes:null, raw:{}, depthPrompt:null }
  const { cardId } = await importCard(paths.characters, card)
  for (const sessionId of ['s1','s2']) await saveBinding(paths, { sessionId, cardId, cardName:card.name, presetId:null, personaId:null, lorebookIds:[], characterLorebookId:null, interactiveCards:null, greetingIndex:0, createdAt:new Date(0).toISOString() })
  const binding = (await state.loadBinding('s1'))!
  const ws = await state.storyWorkspace(cardId, binding.storyId)
  const run = (mode: 'live'|'preview' = 'live', sessionId = 's1') => runTavernPipeline({ state, sessionId, agent:null, mode, historyOverride:[{role:'user',content:'你好'}] })
  return { state, ws, run, paths, cardId }
}

function sessionOutput(text: string, reason = 'completed', finish = 'stop'): Pick<Session,'id'|'snapshotEvents'> {
  const events = [
    { type:'assistant/chunk', seq:4, time:0, data:{turn:1,step:1,chunk:{type:'finish',reason:{kind:finish}}} },
    { type:'assistant/message', seq:5, time:0, data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text}]})} },
    { type:'turn/end', seq:6, time:0, data:{turn:1,reason:{kind:reason}} },
  ] as unknown as SessionEvent[]
  return {id:'s1' as Session['id'], snapshotEvents:()=>events}
}

describe('剧情模板集成', () => {
  it('定位模板同轮冻结且只写一次，失败不落变量，预览与其它剧情隔离并可回滚',async()=> {
    const {state,ws,run,cardId}=await setup('角色')
    const book=(content:string)=>({entries:[{uid:1,comment:'@INJECT target=user,index=-1,at=before,role=system',content}]})
    await state.saveCharacter(cardId,{characterBook:book('<% incvar("injections"); await activewi("extra") %>注入=<%- getvar("injections") %>')})
    expect((await run('preview'))!.turnContext).toContain('注入=1')
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await onTurnStart(state,'s1',1)
    const [first,replay]=await Promise.all([run(),run()])
    expect(first!.messages.findIndex(m=>m.content==='注入=1')).toBe(first!.messages.findIndex(m=>m.content==='你好')-1)
    expect(replay!.turnContext).toBe(first!.turnContext)
    expect(first!.standing).not.toContain('注入=1')
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({injections:1})
    await state.saveCharacter(cardId,{characterBook:book('<% incvar("injections",10) %>新版')})
    expect((await run())!.turnContext).toBe(first!.turnContext)
    await onTurnStart(state,'s2',1)
    await run('live','s2')
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({injections:1})
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await state.saveCharacter(cardId,{characterBook:book('<% setvar("partial",1); throw Error("injection failed") %>')})
    await onTurnStart(state,'s1',2)
    await expect(run()).rejects.toThrow(/injection failed/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('schema 随冻结资产校验生成和回复，失败回复保留旧值，成功转换随楼层回滚',async()=> {
    const {state,ws,run,cardId}=await setup('<% setvar("hp","10") %>角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'schema',content:'@@only_preload\n<% setVariableSchema({hp:z.coerce.number().min(0).max(100)}); %>'},
    ]}})
    expect((await run('preview'))!.turnContext).toContain('角色')
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await onTurnStart(state,'s1',1); await run()
    await state.saveCharacter(cardId,{characterBook:{entries:[]}})
    await expect(completeTemplateOutput(state,sessionOutput('<% setvar("hp",-1) %>'))).rejects.toThrow()
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({hp:10})
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
    await onTurnEnd(state,'s1',sessionOutput('<% setvar("hp","8") %>生命=<%- getvar("hp") %>'))
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({hp:8})
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('生命=8')
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('动态正则按角色和世界书范围处理，冻结字符串回复规则并保存展示快照', async()=> {
    const {state,ws,run,cardId} = await setup('角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'[GENERATE:BEFORE]',constant:true,content:'<% activateRegex(/你好/g,"您好",{user:true,assistant:false}); activateRegex(/secret/g,"public",{worldinfo:true}); activateRegex(/damage=(\\d+)/g,(_,n)=>"伤害="+(Number(n)+1),{worldinfo:true,basic:false,generate:true}); activateRegex(/hidden/g,"shown",{message:true,basic:false}); %>'},
      {uid:2,comment:'world',constant:true,content:'secret damage=3'},
    ]}})
    await onTurnStart(state,'s1',1)
    const result=await run()
    expect(result!.history.at(-1)?.content).toBe('您好')
    expect(result!.turnContext).toContain('public 伤害=4')
    expect(result!.standing).not.toContain('secret')
    await state.saveCharacter(cardId,{characterBook:{entries:[]}})
    await onTurnEnd(state,'s1',sessionOutput('hidden'))
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('shown')
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('回复预加载回调保留同沙箱闭包，纯文本回复同样保存处理结果', async()=> {
    const {state,ws,run,cardId} = await setup('角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'callbacks',content:'@@only_preload\n<% const suffix="!"; activateRegex(/hello/g,()=>"你好"+suffix,{message:true,basic:false,sticky:2}); %>'},
    ]}})
    await onTurnStart(state,'s1',1); await run()
    await onTurnEnd(state,'s1',sessionOutput('hello'))
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('你好!')
  })
  it('主动激活在同轮生效，嵌套激活只执行一次并保留定时器与剧情隔离', async () => {
    const {state,ws,run,cardId} = await setup('<% incvar("cardRuns"); await activewi("fromCard"); %>角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'[GENERATE:BEFORE] start',constant:true,content:'<% incvar("startRuns"); await activewi("event"); %>'},
      {uid:2,comment:'event',key:['never'],sticky:2,content:'<% incvar("eventRuns"); await activewi("nested"); %>事件已触发'},
      {uid:3,comment:'nested',key:['never'],content:'<% incvar("nestedRuns"); await activewi("event"); %>嵌套内容'},
      {uid:4,comment:'fromCard',key:['never'],content:'从角色模板激活'},
    ]}})
    await onTurnStart(state,'s1',1)
    const result = await run()
    expect(result!.turnContext).toContain('事件已触发')
    expect(result!.turnContext).toContain('嵌套内容')
    expect(result!.turnContext).toContain('从角色模板激活')
    expect(result!.standing).not.toContain('从角色模板激活')
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({startRuns:1,cardRuns:1,eventRuns:1,nestedRuns:1})
    expect(await run()).toBe(result)
    await onTurnEnd(state,'s1')
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('预处理的内容和关键词参与原生递归扫描，普通组装不重执行脚本', async()=> {
    const {state,ws,run,cardId} = await setup('角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'[InitialVariables]',content:'trigger: 你好'},
      {uid:2,comment:'preprocessed',key:['<%- getvar("trigger") %>'],content:'@@preprocessing\n<% incvar("runs") %>secret-key'},
      {uid:3,comment:'recursive',key:['secret-key'],content:'递归解锁'},
      {uid:4,comment:'disabled preprocessing',constant:true,content:'@@preprocessing\n@@if false\n<% throw Error("must not run") %>'},
    ]}})
    await onTurnStart(state,'s1',1)
    const result = await run()
    expect(result!.turnContext).toContain('递归解锁')
    expect((await loadTemplateState(ws.fs)).variables.message.runs).toBe(1)
    await onTurnEnd(state,'s1')
  })
  it('主动激活仍遵守 WI 预算，force 不得越过明确禁止激活', async()=> {
    const {state,run,cardId} = await setup('<% await activewi("blocked",true); await activewi("huge"); %>角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'blocked',content:'@@dont_activate\n禁止内容'},
      {uid:2,comment:'huge',key:['never'],content:'巨大正文'.repeat(10000)},
    ]}})
    const result=await run('preview')
    expect(result!.system).not.toContain('禁止内容')
    expect(result!.system).not.toContain('巨大正文')
    expect(result!.wiBudget.overflowed).toBe(true)
    expect(result!.logLines.some(line=>line.includes('budget-trim'))).toBe(true)
  })
  it('预加载定义、条件筛选与回复装饰器共用冻结资产，变量补丁可整层回滚', async () => {
    const {state,ws,run,cardId} = await setup('生命=<%- hpText() %>')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'defaults',content:'@@initial_variables\nhp: 10'},
      {uid:2,comment:'functions',content:'@@only_preload\n<% define("hpText", function(){return this.getvar("hp")}); %>'},
      {uid:3,comment:'hidden',constant:true,group:'stage',groupOverride:true,content:'@@if false\n<% throw Error("should not run") %>'},
      {uid:4,comment:'visible',constant:true,group:'stage',content:'@@if getvar("hp") === 10\n本轮条件成立'},
      {uid:5,comment:'status',content:'@@render_after\n@@if getvar("hp") === 8\n状态=<%- hpText() %>'},
    ]}})
    expect((await run('preview'))!.turnContext).toContain('本轮条件成立')
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await onTurnStart(state,'s1',1)
    const plan = await run()
    expect(plan!.turnContext).toContain('生命=10')
    expect(plan!.standing).not.toContain('本轮条件成立')
    await state.saveCharacter(cardId,{characterBook:{entries:[]}})
    const text = '<% patchVariables(null,[{op:"replace",path:"/hp",value:8}]); %>正文'
    await onTurnEnd(state,'s1',sessionOutput(text))
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('正文\n状态=8')
    expect((await loadTemplateState(ws.fs)).variables.message.hp).toBe(8)
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('条件预选拒绝变量副作用；失败补丁的回复不留下半份状态', async () => {
    const {state,ws,run,cardId} = await setup('角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'bad condition',constant:true,content:'@@if setvar("bad",1)\n正文'},
    ]}})
    await onTurnStart(state,'s1',1)
    await expect(run()).rejects.toThrow(/条件必须只读/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await state.saveCharacter(cardId,{characterBook:{entries:[]}})
    await run()
    const prepared=await ws.fs.readText(TEMPLATE_STATE_PATH)
    await expect(onTurnEnd(state,'s1',sessionOutput('<% setvar("hp",10); patchVariables(null,[{op:"replace",path:"/hp",value:1},{op:"test",path:"/hp",value:2}]) %>'))).rejects.toThrow(/test 失败/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(prepared)
    expect(state.openFloors.has('s1')).toBe(false)
  })
  it('预览不落盘，同轮并发只执行一次；动态卡定义进入 turn，跨轮更新且剧情隔离', async () => {
    const {state,ws,run,cardId} = await setup()
    expect((await run('preview'))!.turnContext).toContain('访问=1')
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await onTurnStart(state,'s1',1)
    const [first,second] = await Promise.all([run(),run()])
    expect(first).toBe(second)
    expect(first!.standing).not.toContain('访问=')
    expect(first!.turnContext).toContain('访问=1')
    expect((await loadTemplateState(ws.fs)).variables.message.visits).toBe(1)
    await state.saveCharacter(cardId,{description:'修改后=<%- getvar("visits") %>'})
    expect((await run())!.turnContext).toContain('访问=1')
    await onTurnEnd(state,'s1'); await onTurnStart(state,'s1',2)
    expect((await run())!.turnContext).toContain('修改后=1')
    await onTurnStart(state,'s2',1)
    expect((await run('live','s2'))!.turnContext).not.toContain('修改后=1')
    await onTurnEnd(state,'s1'); await onTurnEnd(state,'s2')
  })
  it('回复正常 stop 后写入一次并缓存展示，错误/截断不执行', async () => {
    const {state,ws,run} = await setup()
    await onTurnStart(state,'s1',1); await run()
    const text = '<% incvar("affinity",10) %>好感=<%- getvar("affinity") %>'
    await completeTemplateOutput(state, sessionOutput(text,'max-tokens','max-tokens'))
    await completeTemplateOutput(state, sessionOutput(text,'error'))
    await completeTemplateOutput(state, sessionOutput(text,'completed','length'))
    const malformed = sessionOutput(text)
    const invalidEvents = [...malformed.snapshotEvents()]
    invalidEvents.splice(1,0,{type:'assistant/chunk',seq:4,time:0,data:{turn:1,step:1,chunk:{type:'text-delta',index:0,text:'after stop'}}} as unknown as SessionEvent)
    await completeTemplateOutput(state,{id:malformed.id,snapshotEvents:()=>invalidEvents})
    expect((await loadTemplateState(ws.fs)).variables.message.affinity).toBeUndefined()
    const session = sessionOutput(text)
    await completeTemplateOutput(state,session); await completeTemplateOutput(state,session)
    expect((await loadTemplateState(ws.fs)).variables.message.affinity).toBe(10)
    expect((await loadTemplateState(ws.fs)).outputs['5']?.text).toBe('好感=10')
    await onTurnEnd(state,'s1',session)
    expect((await loadTemplateState(ws.fs)).variables.message.affinity).toBe(10)
    const raw = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
    const ctx = {reflect:{provide:()=>{}},get:()=>undefined,sessions:{get:()=>session}} as unknown as Context
    const service = new TavernService(ctx,state,{get:()=>raw} as unknown as SettingsScope<TavernConfigRaw>)
    expect((await service.renderOutputText({sessionId:'s1',text,messageId:5})).text).toBe('好感=10')
    expect((await service.renderOutputText({sessionId:'s1',text,messageId:5})).text).toBe('好感=10')
    await service.renderOutputText({sessionId:'s1',text:'<% incvar("affinity",100) %>预览'})
    expect((await loadTemplateState(ws.fs)).variables.message.affinity).toBe(10)
    expect(resolveReadableAssetPath('state/template.json').ok).toBe(false)
    const greetingText = '<% setvar("greeting",42) %>开场白=<%- getvar("greeting") %>'
    const greetingEvents = greetingTurnEvents(greetingText)
    const greetingCtx = {reflect:{provide:()=>{}},get:()=>undefined,sessions:{get:()=>({id:'s1',snapshotEvents:()=>greetingEvents})}} as unknown as Context
    const greetingService = new TavernService(greetingCtx,state,{get:()=>raw} as unknown as SettingsScope<TavernConfigRaw>)
    const greetingId = Number(greetingEvents.find(e=>e.type==='assistant/message')!.seq)
    expect((await greetingService.renderOutputText({sessionId:'s1',text:greetingText,messageId:greetingId})).text).toBe('开场白=42')
    expect((await loadTemplateState(ws.fs)).variables.message.greeting).toBeUndefined()
    await ws.wal.rollbackFloor('s1#t1', ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
  it('失败组装/回复不提交部分变量，正常楼层仍能结束', async () => {
    const {state,ws,run,cardId} = await setup('<% setvar("bad",1); throw Error("stop") %>')
    await onTurnStart(state,'s1',1)
    await expect(run()).rejects.toThrow(/stop/)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
    await state.saveCharacter(cardId,{description:'正常'}); await run()
    await expect(onTurnEnd(state,'s1',sessionOutput('<% setvar("bad",2); throw Error("render failed") %>'))).rejects.toThrow(/render failed/)
    expect((await loadTemplateState(ws.fs)).variables.message.bad).toBeUndefined()
    expect(state.openFloors.has('s1')).toBe(false)
  })
  it('分支复制模板状态，在草稿中撤销楼层不修改来源', async () => {
    const {state,ws,run,paths,cardId} = await setup()
    await onTurnStart(state,'s1',1); await run(); await onTurnEnd(state,'s1')
    const id = newStoryId(), cardRoot = join(paths.characters,cardId)
    await snapshotStory({ cardRoot, sourceRoot:ws.fs.root, id, sessionId:'child', includeWal:true })
    const destRoot = storyRoot(cardRoot,id)
    const dest = new WorkspaceFs(destRoot,null)
    expect((await loadTemplateState(dest)).variables.message.visits).toBe(1)
    const wal = new Wal(join(destRoot,'state','wal'))
    await wal.rollbackFloor('s1#t1',destRoot)
    expect(await dest.readText(TEMPLATE_STATE_PATH)).toBeNull()
    expect((await loadTemplateState(ws.fs)).variables.message.visits).toBe(1)
  })
  it('同正文的不同世界书条目独立执行，未激活模板不会写变量', async () => {
    const {state,ws,run,cardId} = await setup('角色')
    await state.saveCharacter(cardId,{characterBook:{entries:[
      {uid:1,comment:'first',constant:true,content:'<% incvar("count") %>正文'},
      {uid:2,comment:'second',constant:true,content:'<% incvar("count") %>正文'},
      {uid:3,key:['missing-key'],content:'<% setvar("inactive",true) %>正文'},
    ]}})
    await onTurnStart(state,'s1',1); await run()
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({count:2})
    await onTurnEnd(state,'s1')
  })
  it('正文替换后报错通过读回确认提交，重试不重复自增', async () => {
    const {state,ws,run} = await setup()
    await onTurnStart(state,'s1',1)
    const original = WorkspaceFs.prototype.writeText
    let fault = true
    vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,content) {
      await original.call(this,path,content)
      if (path === TEMPLATE_STATE_PATH && fault) { fault=false; throw Error('rename 后故障') }
    })
    await run(); await run()
    expect((await loadTemplateState(ws.fs)).variables.message.visits).toBe(1)
    await onTurnEnd(state,'s1')
  })
})
