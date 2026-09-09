/** 在模拟 iframe 中运行实际自包含脚本；验证当前消息、事件生命周期、变量失败原子性与窄桥行为。 */
import { createContext, runInContext } from 'node:vm'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { installCardHelper, type CardHelperContext } from '../src/core/cardHelper.js'
import { installCardEvents } from '../src/core/cardEvents.js'
import { installCardVariables } from '../src/core/cardVariables.js'
import { parseCardBridgeMessage, tavernCardBridgeScript } from '../src/core/cardFrame.js'

const lodash: unknown = createRequire(import.meta.url)('lodash')
function frame(options: CardHelperContext = { message: '当前回复', messageId: 17, name: '灯塔', userName: '旅人', canSwipe: false }) {
  const listeners = new Map<string, Set<() => void>>()
  const document = { readyState: 'loading', body: null,
    addEventListener: (event: string, callback: () => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(callback) },
    removeEventListener: (event: string, callback: () => void) => { listeners.get(event)?.delete(callback) },
  }
  const postMessage = vi.fn()
  const scope: Record<string, unknown> = { document, parent: { postMessage }, TextEncoder, _: lodash,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), queueMicrotask }
  scope.window = scope
  const context = createContext(scope)
  const run = (code: string) => runInContext(code, context)
  run(`(${installCardVariables.toString()})({title:'备份',note:'临时',backup:'备份',text:'数据'}, '', ${options.messageId ?? 0})`)
  run(`var cleanupEvents = (${installCardEvents.toString()})()`)
  run(`var cleanupHelper = (${installCardHelper.toString()})(${JSON.stringify(options)}, ['开场白', '备选'], 0, 'dsh-tavern-card', {diagnostics:'脚本消息',unsupported:'不支持'})`)
  return { run, postMessage, ready: () => { for (const fn of listeners.get('DOMContentLoaded') ?? []) fn() } }
}

describe('卡面消息与受限操作', () => {
  it('同步读取当前回复，兼容 await、负索引、范围、筛选及独立副本', async () => {
    const { run } = frame()
    expect(run('Array.isArray(getChatMessages(-1))')).toBe(true)
    expect(run('getChatMessages(-1)[0]')).toMatchObject({ message_id: 17, name: '灯塔', role: 'assistant', message: '当前回复' })
    expect(await run('(async()=> (await getChatMessages(17))[0].message)()')).toBe('当前回复')
    expect(run('getChatMessages("0-{{lastMessageId}}")')).toHaveLength(1)
    expect(run('getChatMessages(-2)')).toEqual([])
    expect(run('getChatMessages(18)')).toEqual([])
    expect(run('getChatMessages(-1,{role:"user"})')).toEqual([])
    expect(run('getChatMessages(-1,{hide_state:"hidden"})')).toEqual([])
    expect(() => run('getChatMessages("nonsense")')).toThrow('Invalid message range')
    run('getChatMessages(-1)[0].swipes.push("外部修改")')
    expect(run('getChatMessages(-1)[0].swipes')).toEqual(['当前回复'])
    expect(run('getCurrentMessageId()')).toBe(17)
    expect(run('getMessageId(getIframeName())')).toBe(17)
    expect(run('substitudeMacros("{{char}}/{{user}}/{{lastMessageId}}/{{unknown}}")')).toBe('灯塔/旅人/17/{{unknown}}')
  })
  it('开场白现代与旧接口只请求 swipe；非法整批/正文写入和未知 Slash 不产生副作用', async () => {
    const { run, postMessage } = frame({ messageId: 0, canSwipe: true })
    expect(run('getChatMessages(0,{include_swipes:true})[0].swipes')).toEqual(['开场白', '备选'])
    await run('setChatMessages([{message_id:0,swipe_id:1}])')
    await run('setChatMessage("",0,{swipe_id:1})')
    await run('triggerSlash("/swipe right")')
    expect(postMessage).toHaveBeenCalledTimes(3)
    expect(postMessage.mock.calls.every(([value]) => JSON.stringify(value) === JSON.stringify({ source: 'dsh-tavern-card', action: 'swipeGreeting', index: 1 }))).toBe(true)
    for (const script of ['setChatMessages([{message_id:0,swipe_id:1},{message_id:2,swipe_id:1}])',
      'setChatMessages([{message_id:0,message:"不应落盘",swipe_id:1}])', 'setChatMessages([{message_id:0,swipe_id:99}])',
      'setChatMessage("改正文",0,{swipe_id:1})', 'triggerSlash("/swipe | /trigger")', 'triggerSlash("/trigger")']) {
      await expect(run(script)).rejects.toThrow()
    }
    expect(postMessage).toHaveBeenCalledTimes(3)
    expect(await run('triggerSlash("/pass {{lastMessageId}}")')).toBe('0')
    expect(() => run('generate({})')).toThrow(/不支持.*generate/)
    expect(parseCardBridgeMessage({source:'dsh-tavern-card',action:'generate'})).toBeNull()
  })
  it('回复与只读预览均拒绝切换，未发生的宿主事件不会被伪造', async () => {
    const { run, postMessage, ready } = frame()
    run('var count=0; eventOn(tavern_events.MESSAGE_RECEIVED,()=>count++)')
    ready()
    await expect(run('setChatMessages([{message_id:17,swipe_id:1}])')).rejects.toThrow(/不支持/)
    expect(postMessage).not.toHaveBeenCalled()
    expect(run('count')).toBe(0)
    const preview = frame({canSwipe:false})
    await expect(preview.run('triggerSlash("/swipe")')).rejects.toThrow(/不支持/)
  })
  it('原生上下文允许开场白 swipe，不能把正文修改假装保存成功', async () => {
    const { run, postMessage } = frame({messageId:0,canSwipe:true})
    run('var ctx=SillyTavern.getContext(); ctx.chat[0].swipe_id=1')
    await run('ctx.saveChat()')
    expect(postMessage).toHaveBeenCalledOnce()
    run('ctx.chat[0].mes="修改的正文"')
    await expect(run('ctx.saveChat()')).rejects.toThrow(/saveChat/)
    expect(postMessage).toHaveBeenCalledOnce()
  })
})

describe('卡面事件', () => {
  it('同一监听去重，首尾排序、once 重入和 stop 均遵循业务行为', async () => {
    const { run } = frame()
    run('var seen=[]; function a(){seen.push("a")}; function b(){seen.push("b")}; eventOn("x",a); eventOn("x",a); var stop=eventOn("x",b).stop; eventMakeFirst("x",b)')
    await run('eventEmit("x")')
    expect(run('seen')).toEqual(['b','a'])
    run('seen=[]; eventMakeLast("x",b)')
    await run('eventEmit("x")')
    expect(run('seen')).toEqual(['a','b'])
    run('stop(); seen=[]; eventOnce("nested",async()=>{seen.push("once");await eventEmit("nested")})')
    await run('eventEmit("nested")')
    expect(run('seen')).toEqual(['once'])
    run('seen=[]')
    await run('eventEmit("x")')
    expect(run('seen')).toEqual(['a'])
  })
  it('等待异步监听，传播异常，关闭/重装后旧监听不再执行', async () => {
    const { run } = frame()
    run('var seen=[]; eventOn("x",async()=>{await Promise.resolve(); seen.push("async")}); eventOn("x",()=>seen.push("last"))')
    await run('eventEmit("x")')
    expect(run('seen')).toEqual(['async','last'])
    run('eventOn("bad",()=>{throw Error("失败")})')
    await expect(run('eventEmit("bad")')).rejects.toThrow('失败')
    run('seen=[]; cleanupEvents()')
    await run('eventEmit("x")')
    expect(run('seen')).toEqual([])
    expect(() => run('eventOn("x",()=>{})')).toThrow(/disposed/)
  })
  it('清除指定事件/函数不影响其他监听，兄弟卡面不共享事件', async () => {
    const a = frame(), b = frame()
    a.run('var count=0; function shared(){count++}; eventOn("a",shared); eventOn("b",shared); eventClearEvent("a")')
    await a.run('eventEmit("a")')
    await a.run('eventEmit("b")')
    expect(a.run('count')).toBe(1)
    a.run('eventClearListener(shared)')
    await a.run('eventEmit("b")')
    await b.run('eventEmit("b")')
    expect(a.run('count')).toBe(1)
  })
})

describe('卡面变量扩展', () => {
  it('更新、路径删除、作用域合并和消息别名只改当前 iframe', async () => {
    const { run, postMessage } = frame()
    run('replaceVariables({hero:{hp:2,items:[1,2]}},{type:"global"}); replaceVariables({hero:{name:"灯塔"}},{type:"character"}); replaceVariables({hero:{hp:3}},{type:"chat"})')
    run('updateVariablesWith(v=>{v.hero.hp++;return v},{type:"chat"})')
    expect(run('getAllVariables()')).toEqual({hero:{hp:4,items:[1,2],name:'灯塔'}})
    expect(run('deleteVariable("hero.items[0]",{type:"global"})')).toMatchObject({ delete_occurred: true })
    expect(run('deleteVariable("hero.missing",{type:"global"}).delete_occurred')).toBe(false)
    expect(() => run('deleteVariable("__proto__.bad")')).toThrow()
    run('replaceVariables({score:7},{type:"message"})')
    expect(run('getVariables({type:"message",message_id:"latest"})')).toEqual({score:7})
    expect(run('getVariables({type:"message",message_id:-1})')).toEqual({score:7})
    expect(run('getChatMessages(-1)[0].data')).toEqual({score:7})
    run('replaceVariables({preset:true},{type:"preset"})')
    expect(run('getVariables({type:"preset"})')).toEqual({preset:true})
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('异步更新成功提交，抛错、无效返回、超量和等待期间的冲突都保留数据', async () => {
    const { run } = frame()
    run('replaceVariables({value:1})')
    expect(await run('updateVariablesWith(async v=>{v.value++;return v})')).toEqual({value:2})
    await expect(run('updateVariablesWith(async v=>{v.value=0;throw Error("失败")})')).rejects.toThrow('失败')
    expect(run('getVariables()')).toEqual({value:2})
    expect(() => run('updateVariablesWith(()=>null)')).toThrow()
    expect(() => run('updateVariablesWith(()=>({text:"界".repeat(400000)}))')).toThrow()
    const pending = run('var release; updateVariablesWith(async v=>{await new Promise(r=>release=r); v.value=100; return v})')
    run('replaceVariables({value:3}); release()')
    await expect(pending).rejects.toThrow(/changed/)
    expect(run('getVariables()')).toEqual({value:3})
  })
  it('完整桥重装会清理旧事件，变量保留；源码被序列化后仍可运行', async () => {
    const document = { readyState:'loading', body:null, addEventListener:vi.fn(), removeEventListener:vi.fn(),
      open:vi.fn(), write:vi.fn(), close:vi.fn(), currentScript:null, querySelector:()=>null }
    const scope:Record<string,unknown> = {document,TextEncoder,setTimeout,clearTimeout,queueMicrotask,addEventListener:vi.fn(),removeEventListener:vi.fn(),parent:{postMessage:vi.fn()}}
    scope.window=scope
    const context=createContext(scope)
    const source=tavernCardBridgeScript({greetings:['A','B'],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
    runInContext(source,context)
    runInContext('var count=0; eventOn("x",()=>count++); replaceVariables({kept:1})',context)
    runInContext(source,context)
    await runInContext('eventEmit("x")',context)
    expect(runInContext('count',context)).toBe(0)
    expect(runInContext('getVariables()',context)).toEqual({kept:1})
  })
  it('重装期间挂起的旧变量更新被拒绝，不覆盖新文档中的值', async () => {
    const { run } = frame()
    run('replaceVariables({value:1})')
    const pending=run('var finish; updateVariablesWith(async v=>{await new Promise(r=>finish=r);v.value=2;return v})')
    run(`(${installCardVariables.toString()})({title:'备份',note:'临时',backup:'备份',text:'数据'}, '', 17)`)
    run('finish()')
    await expect(pending).rejects.toThrow(/disposed/)
    expect(run('getVariables()')).toEqual({value:1})
  })
})

it('真实消息卡就绪回执带当前事件运行时身份，等待 iframe 生命周期监听结束；后台脚本不伪装消息就绪',async()=>{
  const snapshot={storyId:'s',historyRevision:'r',currentMessageId:0,messages:[],scopes:{},writable:true}
  const f=frame({snapshot});f.run('window.__dshTavernEventRuntimeId="epoch";eventOn(iframe_events.MESSAGE_IFRAME_RENDER_ENDED,()=>new Promise(resolve=>window.finishReady=resolve))')
  f.ready();await Promise.resolve();await Promise.resolve();expect(f.postMessage).not.toHaveBeenCalled()
  await vi.waitFor(()=>expect(f.run('typeof finishReady')).toBe('function'));f.run('finishReady()');await vi.waitFor(()=>expect(f.postMessage).toHaveBeenCalledWith({source:'dsh-tavern-card',action:'helperFrameReady',runtimeId:'epoch'},'*'))
  const background=frame({snapshot,scriptFrame:true});background.ready();await Promise.resolve();expect(background.postMessage).not.toHaveBeenCalled()
})

it('后台诊断区分通知与致命错误，成功通知标题不会误判失败，停止后不再报告',()=>{
  const f=frame({scriptFrame:true})
  f.run("toastr.success('Ready','System');toastr.info('Info','Title')")
  expect(f.run('window.__dshTavernScriptFailure')).toBeUndefined()
  f.run("window.__dshTavernReportError(new Error('failure'))")
  expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperScriptDiagnostic',error:'failure'}),'*')
  const count=f.postMessage.mock.calls.length
  f.run("window.__dshTavernReportError(new Error('failure'));cleanupHelper();window.__dshTavernReportError?.(new Error('late'))")
  expect(f.postMessage).toHaveBeenCalledTimes(count)
})

it('旧状态栏的 window.chat 返回本沙箱消息副本，不需要父窗口访问',()=>{
 const f=frame();expect(f.run('window.chat[0].mes')).toBe('当前回复')
 f.run('window.chat[0].mes="changed"');expect(f.run('window.chat[0].mes')).toBe('当前回复')
 f.run('cleanupHelper()');expect(f.run('window.chat')).toBeUndefined()
})
