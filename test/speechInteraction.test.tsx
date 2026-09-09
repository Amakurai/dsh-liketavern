/** 交互卡消息行为：真实 React + 伪 iframe 窗口，验证来源校验、连续点击去重、错误反馈与会话隔离。 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import {watchHelperScripts} from '../src/client/helperScriptNotifications.js'
import {ScriptChoices} from '../src/client/helperChoices.js'
import { SpeechHtmlFrame,SpeechBubble } from '../src/client/speech.js'
import type { TavernRemote } from '../src/client/types.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn,FileBtn,SearchInput,Select,Tabs,Toggle } from '../src/client/util.js'
import { HelperScriptEditorBody } from '../src/client/helperScriptEditor.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import { HelperScripts } from '../src/client/helperScripts.js'
import { parseHelperScriptTrees } from '../src/core/helperScripts.js'
import { splitTemplateDisplay } from '../src/core/templateDisplay.js'
import { presentRenderedOutput } from '../src/core/displaySanitize.js'

vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/client/cache.js', () => ({ cachedAvatar: async () => ({ ok: true, value: { dataUrl: null } }) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutline16: () => null, IconUserOutline16: () => null, IconSearchOutline16: () => null,
  IconChevronDownOutline14: () => null, Menu: () => null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; children?: ReactNode; footer?: ReactNode }) => p.open ? <div>{p.children}{p.footer}</div> : null,
  MarkdownText: (p: {text:string}) => <p data-markdown={p.text}>{p.text}</p>, Toast: () => null,
}))
let view: ReactTestRenderer | undefined
let events: EventTarget
const source = { postMessage: vi.fn() }
const remote = { renderOutputText: async () => ({ ok: true, value: { text: '', htmls: ['<p>测试卡</p>'], interactiveCards: true,
  whitelist: [], greetings: ['初始', '备选'], greetingIndex: 0, canSwipeGreeting: true } }) } as unknown as TavernRemote
beforeEach(() => { source.postMessage.mockClear(); events = new EventTarget(); vi.stubGlobal('window', events); setTavernLocale('zh') })
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
function node(onSwipeGreeting: (index: number) => Promise<void>, sessionId = 'source') {
  return <SpeechBubble remote={remote} sessionId={sessionId} cardId="card" name="灯塔" rawText="测试开场白" onSwipeGreeting={onSwipeGreeting} />
}
async function mount(component: ReactNode) {
  await act(async () => { view = create(component, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: source } : null }) })
}
function swipe(from: unknown = source) {
  const event = new Event('message')
  Object.defineProperties(event, { source: { value: from }, data: { value: { source: 'dsh-tavern-card', action: 'swipeGreeting', index: 1 } } })
  events.dispatchEvent(event)
}

/** 卡面可指定业务数据，但 sessionId/messageId 必须始终由已挂载气泡固定。 */
function helperRequest(requestId='request-1',from:unknown=source,changes:unknown=[{key:'["chat",""]',before:{},value:{n:1}}]) {
  const event=new Event('message')
  Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action:'helperVariablesCommit',requestId,
    sessionId:'forged-session',messageId:999,storyId:'story',historyRevision:'revision',changes}}})
  events.dispatchEvent(event)
}
const helperSnapshot:HelperSnapshot={storyId:'story',historyRevision:'revision',currentMessageId:0,messages:[],scopes:{},writable:true}

it('脚本编辑器保存真实正文与持久开关，失败保留草稿和原修订以便合并',async()=>{
  const trees=parseHelperScriptTrees([{id:'script',name:'工厂脚本',content:'old'}])
  const saveCharacterHelperScripts=vi.fn(async()=>({ok:false as boolean,error:{code:'conflict',message:'脚本库已被修改'},value:{cardId:'card',revision:'new',trees}}))
  const saved=vi.fn(),closed=vi.fn()
  await mount(<HelperScriptEditorBody remote={{saveCharacterHelperScripts} as unknown as TavernRemote} library={{cardId:'card',revision:'original',trees}} onClose={closed} onSaved={saved}/>)
  const click=(label:string)=>view!.root.findAllByType(Btn).find(button=>button.props.children===label)!.props.onClick()
  await act(async()=>click('工厂脚本'))
  await act(async()=>view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.onChange({target:{value:'await Promise.resolve();'}}))
  await act(async()=>view!.root.findAllByType(Toggle)[0]!.props.onChange(true))
  await act(async()=>click('保存并重新加载'))
  expect(saveCharacterHelperScripts.mock.calls[0]?.[0]).toMatchObject({cardId:'card',revision:'original',trees:[{id:'script',enabled:true,content:'await Promise.resolve();'}]})
  expect(view!.root.findByProps({role:'alert'}).children.join('')).toContain('脚本库已被修改')
  expect(view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.value).toBe('await Promise.resolve();')
  expect(saved).not.toHaveBeenCalled();expect(closed).not.toHaveBeenCalled()
})

it('无效脚本初始变量在保存前报错，不调用资产写入',async()=>{
  const trees=parseHelperScriptTrees([{id:'script',name:'工厂脚本'}]),saveCharacterHelperScripts=vi.fn()
  await mount(<HelperScriptEditorBody remote={{saveCharacterHelperScripts} as unknown as TavernRemote} library={{cardId:'card',revision:'original',trees}} onClose={()=>{}} onSaved={()=>{}}/>)
  const click=(label:string)=>view!.root.findAllByType(Btn).find(button=>button.props.children===label)!.props.onClick()
  await act(async()=>click('工厂脚本'))
  await act(async()=>view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.onChange({target:{value:'{"broken":'}}))
  await act(async()=>click('保存并重新加载'))
  expect(saveCharacterHelperScripts).not.toHaveBeenCalled()
  expect(view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.value).toBe('{"broken":')
})

it('脚本跨文件夹移动保留源码、变量草稿和邻居，移回顶层不产生重复项',async()=>{
  const trees=parseHelperScriptTrees([{type:'folder',id:'folder',name:'目录',scripts:[{id:'neighbor',name:'邻居'}]},{id:'script',name:'脚本',content:'await test();'}])
  const saveCharacterHelperScripts=vi.fn(async()=>({ok:false,error:{message:'保留草稿'}}))
  await mount(<HelperScriptEditorBody remote={{saveCharacterHelperScripts} as unknown as TavernRemote} library={{cardId:'card',revision:'original',trees}} onClose={()=>{}} onSaved={()=>{}}/>)
  const click=(label:string)=>view!.root.findAllByType(Btn).find(button=>button.props.children===label)!.props.onClick()
  await act(async()=>click('脚本'))
  await act(async()=>view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.onChange({target:{value:'{"hp":7}'}}))
  await act(async()=>view!.root.findByType(Select).props.onChange('folder'))
  await act(async()=>click('保存并重新加载'))
  expect(saveCharacterHelperScripts.mock.calls[0]?.[0]).toMatchObject({trees:[{id:'folder',scripts:[{id:'neighbor'},{id:'script',content:'await test();',data:{hp:7}}]}]})
  await act(async()=>view!.root.findByType(Select).props.onChange(''))
  await act(async()=>click('保存并重新加载'))
  expect(saveCharacterHelperScripts.mock.calls[1]?.[0]).toMatchObject({trees:[{id:'folder',scripts:[{id:'neighbor'}]},{id:'script',data:{hp:7}}]})
})

it('会话隐藏后台脚本，设置保存只重新加载使用该资产的运行器',async()=>{
  const {notifyHelperScriptAssets}=await import('../src/client/helperScriptNotifications.js')
  const trees=parseHelperScriptTrees([{id:'script-a',name:'工厂脚本',enabled:true,content:'await Promise.resolve(); window.factory=1'}])
  let revision='v1'
  const getHelperScriptBundle=vi.fn(async()=>({ok:true,value:{cardId:'card',revision,storyId:'story',trees,messageId:17,snapshot:helperSnapshot,enabled:true,whitelist:[]}}))
  await mount(<HelperScripts remote={{getHelperScriptBundle} as unknown as TavernRemote} sessionId="script-session"/>)
  const frame=view!.root.findByType('iframe')
  expect(frame.props.sandbox).toBe('allow-scripts')
  expect(view!.root.findByProps({className:'dsh-tavern-scriptHost'}).props.hidden).toBe(true)
  expect(view!.root.findAllByType(Btn).some(button=>['后台脚本','管理角色脚本','暂停'].includes(button.props.children))).toBe(false)
  await act(async()=>notifyHelperScriptAssets({type:'character',cardId:'other'}))
  expect(getHelperScriptBundle).toHaveBeenCalledOnce();expect(view!.root.findByType('iframe')).toBe(frame)
  revision='v2'
  await act(async()=>notifyHelperScriptAssets({type:'character',cardId:'card'}))
  expect(getHelperScriptBundle).toHaveBeenCalledTimes(2)
  expect(view!.root.findByType('iframe')).not.toBe(frame)
  expect(view!.root.findByType('iframe').props.srcDoc).toContain('window.factory=1')
})

it('刷新固定真实会话和消息；剧情换绑后的回包不能泄漏新剧情数据',async()=>{
  const getHelperSnapshot=vi.fn(async()=>({ok:true as const,value:helperSnapshot}))
  const helperRemote={...remote,getHelperSnapshot} as unknown as TavernRemote
  await mount(<SpeechBubble remote={helperRemote} sessionId="real" cardId="card" name="角色" rawText="卡面" messageId={17}/>)
  const refresh=(from:unknown=source)=>{
    const event=new Event('message')
    Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action:'helperSnapshotGet',requestId:'refresh',storyId:'story',sessionId:'forged',messageId:999}}})
    events.dispatchEvent(event)
  }
  await act(async()=>refresh({}));expect(getHelperSnapshot).not.toHaveBeenCalled()
  await act(async()=>refresh())
  expect(getHelperSnapshot.mock.calls[0]).toEqual([{sessionId:'real',messageId:17}])
  expect(source.postMessage.mock.calls[0]?.[0]).toMatchObject({ok:true,action:'helperSnapshotResult',snapshot:helperSnapshot})
  source.postMessage.mockClear()
  getHelperSnapshot.mockResolvedValueOnce({ok:true,value:{...helperSnapshot,storyId:'other',scopes:{'["chat",""]':{private:'other story'}}}})
  await act(async()=>refresh())
  expect(source.postMessage.mock.calls[0]?.[0]).toMatchObject({ok:false,action:'helperSnapshotResult'})
  expect(JSON.stringify(source.postMessage.mock.calls)).not.toContain('other story')
})

it('仅在宿主保存成功后向当前剧情卡面发送刷新通知',async()=>{
  const commitHelperVariables=vi.fn(async()=>({ok:true as const,value:helperSnapshot}))
  const helperRemote={...remote,commitHelperVariables,renderOutputText:async()=>({ok:true,value:{text:'',htmls:['<p>卡面</p>'],
    helper:helperSnapshot,interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false}})} as unknown as TavernRemote
  await mount(<SpeechBubble remote={helperRemote} sessionId="real" cardId="card" name="角色" rawText="卡面" messageId={17}/>)
  await act(async()=>helperRequest())
  expect(source.postMessage.mock.calls.map(call=>call[0].action)).toEqual(['helperSnapshotInvalidated','helperVariablesResult'])
})

it('变量写入校验来源并固定宿主上下文；普通重绘不丢失待处理回执',async()=>{
  let finish!:(value:{ok:true;value:HelperSnapshot})=>void
  const commitHelperVariables=vi.fn(()=>new Promise<{ok:true;value:HelperSnapshot}>(resolve=>{finish=resolve}))
  const helperRemote={...remote,commitHelperVariables} as unknown as TavernRemote
  const component=()=> <SpeechBubble remote={helperRemote} sessionId="real-session" cardId="card" name="角色" rawText="卡面" messageId={17}/>
  await mount(component())
  await act(async()=>helperRequest('foreign',{}))
  expect(commitHelperVariables).not.toHaveBeenCalled()
  await act(async()=>{helperRequest();helperRequest()})
  expect(commitHelperVariables).toHaveBeenCalledOnce()
  expect(commitHelperVariables.mock.calls[0]).toEqual([{sessionId:'real-session',messageId:17,storyId:'story',historyRevision:'revision',
    changes:[{key:'["chat",""]',before:{},value:{n:1}}]}])
  await act(async()=>view!.update(component()))
  await act(async()=>finish({ok:true,value:helperSnapshot}))
  expect(source.postMessage).toHaveBeenCalledWith({source:'dsh-tavern-card',action:'helperVariablesResult',requestId:'request-1',ok:true,scopes:{}},'*')
})

it('非法变量不进入 remote，旧会话的迟到保存回执不进入新卡面',async()=>{
  let finish!:(value:{ok:true;value:HelperSnapshot})=>void
  const commitHelperVariables=vi.fn(()=>new Promise<{ok:true;value:HelperSnapshot}>(resolve=>{finish=resolve}))
  const helperRemote={...remote,commitHelperVariables} as unknown as TavernRemote
  const component=(sessionId:string)=> <SpeechBubble remote={helperRemote} sessionId={sessionId} cardId="card" name="角色" rawText="卡面" messageId={17}/>
  await mount(component('old'))
  await act(async()=>helperRequest('invalid',source,[{key:'["message",-1]',before:{},value:{}}]))
  expect(commitHelperVariables).not.toHaveBeenCalled()
  expect(source.postMessage.mock.calls[0]?.[0]).toMatchObject({requestId:'invalid',ok:false})
  source.postMessage.mockClear()
  await act(async()=>helperRequest())
  await act(async()=>view!.update(component('new')))
  await act(async()=>finish({ok:true,value:helperSnapshot}))
  expect(source.postMessage).not.toHaveBeenCalled()
})

it('忽略别的窗口；当前卡面失败明确展示错误，重试期间重复点击只发一次请求', async () => {
  let fail!: (reason: Error) => void
  const onSwipe = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  await mount(node(onSwipe))
  expect(view!.root.findByType('iframe').props.sandbox).toBe('allow-scripts')
  await act(async () => swipe({}))
  expect(onSwipe).not.toHaveBeenCalled()
  await act(async () => { swipe(); swipe() })
  expect(onSwipe).toHaveBeenCalledOnce()
  await act(async () => fail(new Error('分支创建失败，请重试')))
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('分支创建失败')
  onSwipe.mockResolvedValueOnce()
  await act(async () => swipe())
  expect(onSwipe).toHaveBeenCalledTimes(2)
  expect(view!.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('切换会话后旧请求失败不能污染新气泡，也不能锁住新卡面的点击', async () => {
  let fail!: (reason: Error) => void
  const oldSwipe = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  const newSwipe = vi.fn(async () => {})
  await mount(node(oldSwipe))
  await act(async () => swipe())
  await act(async () => view!.update(node(newSwipe, 'new-session')))
  await act(async () => fail(new Error('旧请求失败')))
  await act(async () => swipe())
  expect(newSwipe).toHaveBeenCalledOnce()
  expect(view!.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('消息卡面不再提供备份恢复入口，保留隔离渲染', async () => {
  await mount(node(vi.fn(async () => {})))
  expect(view!.root.findByType('iframe').props.sandbox).toBe('allow-scripts')
  expect(view!.root.findAllByType(Btn).some(button=>button.props.children==='恢复卡内备份')).toBe(false)
  expect(view!.root.findAllByType('textarea')).toHaveLength(0)
})

it('模板渲染传递宿主消息 seq，失败在气泡中明确展示', async () => {
  const renderOutputText = vi.fn(async () => ({ ok: false as const, error: { code: 'template-error', message: '模板未成功提交' } }))
  const templateRemote = { renderOutputText } as unknown as TavernRemote
  await mount(<SpeechBubble remote={templateRemote} sessionId="template-session" cardId="card" name="角色"
    rawText="<% broken() %>" messageId={17} />)
  expect(renderOutputText).toHaveBeenCalledWith({ sessionId: 'template-session', text: '<% broken() %>', messageId: 17 })
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('模板未成功提交')
})

it('内联样式状态栏经真实拆分进入现有沙箱，前后台词继续作为 Markdown 显示',async()=>{
  const html='<div style="display:flex"><span>好感度</span><div style="width:5%">5</div></div>',text='前文\n'+html+'\n后文'
  const fragmentRemote={renderOutputText:async()=>({ok:true,value:{...presentRenderedOutput(text,true),parts:splitTemplateDisplay(text),interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false}})} as unknown as TavernRemote
  await mount(<SpeechBubble remote={fragmentRemote} sessionId="fragment" cardId="card" name="角色" rawText={text}/> )
  const nodes=view!.root.findAll(node=>node.type==='iframe'||node.type==='p'&&node.props['data-markdown']!==undefined)
  expect(nodes.map(node=>node.type)).toEqual(['p','iframe','p'])
  expect(nodes[0]!.props['data-markdown']).toBe('前文');expect(nodes[2]!.props['data-markdown']).toBe('后文')
  expect(nodes[1]!.props.srcDoc).toContain(html);expect(nodes[1]!.props.sandbox).toBe('allow-scripts')
  expect(nodes[1]!.props.srcDoc).toContain("connect-src 'none'")
})

it('模板片段依次展示；折叠标题是纯文字，格式化 HTML 全部保持不透明来源 iframe',async()=>{
  const parts=[{kind:'markdown',text:'前置文字'},{kind:'html',text:'<script>window.test=1</script><b>前置卡</b>',title:'<img src=x onerror=alert(1)>'},
    {kind:'markdown',text:'正文'},{kind:'html',text:'<strong>后置格式化</strong>'}]
  const orderedRemote={renderOutputText:async()=>({ok:true,value:{text:'前置文字\n正文',html:null,htmls:[],parts,interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false}})} as unknown as TavernRemote
  await mount(<SpeechBubble remote={orderedRemote} sessionId="ordered" cardId="card" name="角色" rawText="<% script %>" />)
  const ordered=view!.root.findAll(node=>node.type==='iframe'||node.type==='p'&&node.props['data-markdown']!==undefined)
  expect(ordered.map(node=>node.type)).toEqual(['p','iframe','p','iframe'])
  expect(ordered[0]!.props['data-markdown']).toBe('前置文字')
  expect(ordered[2]!.props['data-markdown']).toBe('正文')
  const fold=view!.root.findByType('details')
  expect(fold.props.open).toBeUndefined()
  expect(fold.findByType('summary').children).toEqual(['<img src=x onerror=alert(1)>'])
  expect(view!.root.findAllByType('img')).toHaveLength(0)
  for(const frame of view!.root.findAllByType('iframe')) {
    expect(frame.props.sandbox).toBe('allow-scripts')
    expect(frame.props.srcDoc).toContain('Content-Security-Policy')
    expect(frame.props.srcDoc).toContain("connect-src 'none'")
  }
  expect(ordered[1]!.props.srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(ordered[1]!.props.srcDoc.indexOf('window.test=1'))
  await act(async()=>view!.update(<SpeechBubble remote={orderedRemote} sessionId="ordered" cardId="card" name="角色" rawText="<% script %>" interactiveCards={false} />))
  expect(view!.root.findAllByType('iframe')).toHaveLength(0)
  expect(view!.root.findAllByType('p').map(node=>node.props['data-markdown'])).toEqual(['前置文字','正文'])
})

it('全 HTML 或空模板关闭交互卡后使用求值结果，不重新展示原始 EJS',async()=>{
  const pureRemote={renderOutputText:async()=>({ok:true,value:{text:'<p>已求值</p>',html:null,htmls:[],parts:[{kind:'html',text:'<p>已求值</p>'}],interactiveCards:false,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false}})} as unknown as TavernRemote
  await mount(<SpeechBubble remote={pureRemote} sessionId="pure" cardId="card" name="角色" rawText="<%= '已求值' %>" />)
  expect(view!.root.findByType('p').props['data-markdown']).toBe('<p>已求值</p>')
  expect(view!.root.findAllByType('iframe')).toHaveLength(0)
  const emptyRemote={renderOutputText:async()=>({ok:true,value:{text:'',html:null,htmls:[],parts:[],interactiveCards:false,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false}})} as unknown as TavernRemote
  await act(async()=>view!.update(<SpeechBubble remote={emptyRemote} sessionId="empty" cardId="card" name="角色" rawText="<% incvar('x') %>" />))
  expect(view!.root.findByType('p').props['data-markdown']).toBe(' ')
})

it('全局与预设编辑器保存固定目标库，不调用角色资产接口',async()=>{
  for(const target of [{type:'global' as const},{type:'preset' as const,presetId:'factory'}]){
    const trees=parseHelperScriptTrees([{id:'script',name:'库脚本'}]),saved=vi.fn()
    const saveHelperScriptLibrary=vi.fn(async()=>({ok:true as const,value:{target,revision:'next',trees}}))
    const saveCharacterHelperScripts=vi.fn()
    if(view)await act(async()=>view!.unmount())
    await mount(<HelperScriptEditorBody remote={{saveHelperScriptLibrary,saveCharacterHelperScripts} as unknown as TavernRemote} library={{target,revision:'original',trees}} onClose={()=>{}} onSaved={saved}/>)
    const click=(label:string)=>view!.root.findAllByType(Btn).find(button=>button.props.children===label)!.props.onClick()
    await act(async()=>click('库脚本'))
    await act(async()=>view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.onChange({target:{value:'await libraryTest();'}}))
    await act(async()=>click('保存并重新加载'))
    expect(saveHelperScriptLibrary.mock.calls[0]?.[0]).toMatchObject({target,revision:'original',trees:[{content:'await libraryTest();'}]})
    expect(saveCharacterHelperScripts).not.toHaveBeenCalled();expect(saved).toHaveBeenCalledOnce()
  }
})
it('脚本库冲突时不启动沙箱，会话不恢复旧管理面板',async()=>{
  const trees=parseHelperScriptTrees([{id:'same',enabled:true}])
  const libraries=[{target:{type:'global'},revision:'g',trees},{target:{type:'preset',presetId:'p'},revision:'p',trees},{target:{type:'character',cardId:'c'},revision:'c',trees:[]}]
  const helperRemote={getHelperScriptBundle:async()=>({ok:true,value:{cardId:'c',revision:'c',storyId:'story',trees:[],libraries,messageId:null,enabled:true,whitelist:[],runtimeError:'启用的脚本 ID 重复：same'}})} as unknown as TavernRemote
  await mount(<HelperScripts remote={helperRemote} sessionId="script-session"/>)
  expect(view!.root.findAllByType('iframe')).toHaveLength(0)
  const names=view!.root.findAllByType(Btn).map(button=>button.props.children)
  expect(names).not.toEqual(expect.arrayContaining(['管理全局脚本','管理当前预设脚本','管理角色脚本']))
  expect(view!.root.findByProps({className:'dsh-tavern-scriptHost'}).props.hidden).toBe(true)
})

it('脚本保存回执先送回来源沙箱，只有该请求的确认才能重载，普通重绘不丢回执',async()=>{
  let finish!:(value:{type:'global';revision:string;trees:never[]})=>void
  const commit=vi.fn(()=>new Promise<{type:'global';revision:string;trees:never[]}>(resolve=>finish=resolve)),notified=vi.fn()
  const stop=watchHelperScripts('real-session','story',notified)
  const component=()=> <SpeechHtmlFrame title="script" srcDoc="<p>script</p>" widget helperBinding={{sessionId:'real-session',storyId:'story'}} onScriptCommit={commit}/>
  const emit=(action:string,from:unknown=source,requestId='script-request')=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action,requestId,storyId:'story',bindingRevision:'binding',type:'global',revision:'r0',trees:[],sessionId:'forged'}}});events.dispatchEvent(event)}
  try{
    await mount(component())
    await act(async()=>emit('helperScriptLibraryCommit',{}));expect(commit).not.toHaveBeenCalled()
    await act(async()=>{emit('helperScriptLibraryCommit');emit('helperScriptLibraryCommit')})
    expect(commit).toHaveBeenCalledOnce();expect(commit.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
    await act(async()=>view!.update(component()))
    await act(async()=>finish({type:'global',revision:'r1',trees:[]}))
    expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperScriptLibraryResult',ok:true,requestId:'script-request'}),'*')
    expect(notified).not.toHaveBeenCalled()
    await act(async()=>emit('helperScriptLibraryApplied',source,'forged'));expect(notified).not.toHaveBeenCalled()
    await act(async()=>{emit('helperScriptLibraryApplied');emit('helperScriptLibraryApplied')});expect(notified).toHaveBeenCalledOnce()
  }finally{stop()}
})
it('脚本保存中的旧文档回执不能通知新剧情重载',async()=>{
  let finish!:(value:{type:'global';revision:string;trees:never[]})=>void
  const commit=()=>new Promise<{type:'global';revision:string;trees:never[]}>(resolve=>finish=resolve)
  await mount(<SpeechHtmlFrame title="old" srcDoc="old" widget helperBinding={{sessionId:'session',storyId:'old'}} onScriptCommit={commit}/>)
  await act(async()=>{const event=new Event('message');Object.defineProperties(event,{source:{value:source},data:{value:{source:'dsh-tavern-card',action:'helperScriptLibraryCommit',requestId:'old',storyId:'old',bindingRevision:'binding',type:'global',revision:'r0',trees:[]}}});events.dispatchEvent(event)})
  await act(async()=>view!.update(<SpeechHtmlFrame title="new" srcDoc="new" widget helperBinding={{sessionId:'session',storyId:'new'}}/>))
  await act(async()=>finish({type:'global',revision:'r1',trees:[]}))
  expect(source.postMessage).not.toHaveBeenCalled()
})

it('世界书桥固定剧情且仅传业务字段，外来窗口与旧文档回执不能越过桥',async()=>{
  let finish!:(value:{created:boolean})=>void
  const request=vi.fn(()=>new Promise<{created:boolean}>(resolve=>finish=resolve))
  await mount(<SpeechHtmlFrame title="worldbook" srcDoc="old" helperBinding={{sessionId:'real',storyId:'story'}} onWorldbookRequest={request}/>)
  const emit=(from:unknown,storyId='story')=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action:'helperWorldbookOperation',requestId:'worldbook',storyId,bindingRevision:'binding',name:'book',operation:'create',entries:[],sessionId:'forged',messageId:99,path:'private'}}});events.dispatchEvent(event)}
  await act(async()=>emit({}));expect(request).not.toHaveBeenCalled()
  await act(async()=>emit(source,'other'));expect(request).not.toHaveBeenCalled()
  source.postMessage.mockClear()
  await act(async()=>{emit(source);emit(source)})
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0]?.[0]).toEqual({storyId:'story',bindingRevision:'binding',name:'book',operation:'create',entries:[]})
  await act(async()=>view!.update(<SpeechHtmlFrame title="new" srcDoc="new" helperBinding={{sessionId:'real',storyId:'new'}}/>))
  await act(async()=>finish({created:true}));expect(source.postMessage).not.toHaveBeenCalled()
})

it('世界书绑定桥校验窗口与剧情，只传枚举选择，普通重绘保留在途回执',async()=>{
  let finish!:(value:{storyId:string;bindingRevision:string;names:string[];global:string[];characterName:string;character:{primary:null;additional:string[]};chat:null})=>void
  const bind=vi.fn(()=>new Promise<Parameters<typeof finish>[0]>(resolve=>finish=resolve))
  const component=()=> <SpeechHtmlFrame title="bindings" srcDoc="same" widget helperBinding={{sessionId:'real',storyId:'story'}} onWorldbookBind={bind}/>
  const emit=(from:unknown,storyId='story')=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action:'helperWorldbookBind',requestId:'bind',storyId,bindingRevision:'old',kind:'global',selection:['book'],sessionId:'forged',messageId:99,path:'private'}}});events.dispatchEvent(event)}
  await mount(component());await act(async()=>emit({}));expect(bind).not.toHaveBeenCalled()
  await act(async()=>emit(source,'other'));expect(bind).not.toHaveBeenCalled()
  source.postMessage.mockClear();await act(async()=>{emit(source);emit(source)});expect(bind).toHaveBeenCalledOnce()
  expect(bind.mock.calls[0]?.[0]).toEqual({storyId:'story',bindingRevision:'old',kind:'global',selection:['book']})
  await act(async()=>view!.update(component()))
  await act(async()=>finish({storyId:'story',bindingRevision:'new',names:['book'],global:['book'],characterName:'角色',character:{primary:null,additional:[]},chat:null}))
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperWorldbookBindResult',ok:true,context:expect.objectContaining({bindingRevision:'new'})}),'*')
})

it('消息正文桥固定上下文、一次只准备一个分支，沙箱确认回执后才跳转',async()=>{
  let finish!:(value:{branch:{childSessionId:string;title:string}})=>void
  const edit=vi.fn(()=>new Promise<Parameters<typeof finish>[0]>(resolve=>finish=resolve)),open=vi.fn(async()=>{})
  const component=(doc='same')=><SpeechHtmlFrame title="edit" srcDoc={doc} widget helperBinding={{sessionId:'real',storyId:'story'}} onMessageEdit={edit} onMessageBranch={open}/>
  const emit=(action:string,from:unknown=source,id='edit',storyId='story')=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action,requestId:id,storyId,historyRevision:'revision',edits:[{message_id:0,message:'new'}],sessionId:'forged',messageId:999}}});events.dispatchEvent(event)}
  await mount(component());await act(async()=>emit('helperMessageEdit',{}));expect(edit).not.toHaveBeenCalled()
  await act(async()=>emit('helperMessageEdit',source,'wrong','other'));expect(edit).not.toHaveBeenCalled()
  await act(async()=>{emit('helperMessageEdit');emit('helperMessageEdit');emit('helperMessageEdit',source,'second')})
  expect(edit).toHaveBeenCalledOnce();expect(edit.mock.calls[0]?.[0]).toEqual({storyId:'story',historyRevision:'revision',edits:[{message_id:0,message:'new'}]})
  await act(async()=>view!.update(component()));await act(async()=>finish({branch:{childSessionId:'child',title:'branch'}}))
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperMessageEditResult',ok:true,requestId:'edit'}),'*');expect(open).not.toHaveBeenCalled()
  await act(async()=>emit('helperMessageEditApplied',source,'wrong'));expect(open).not.toHaveBeenCalled()
  await act(async()=>{emit('helperMessageEditApplied');emit('helperMessageEditApplied')});expect(open).toHaveBeenCalledOnce()
  await act(async()=>emit('helperMessageEdit',source,'third'));expect(edit).toHaveBeenCalledOnce()
})
it('编辑回执迟到不能让新文档跳转；打开分支失败有可重试入口',async()=>{
  let finish!:(value:{branch:{childSessionId:string;title:string}})=>void
  const edit=()=>new Promise<Parameters<typeof finish>[0]>(resolve=>finish=resolve),open=vi.fn(async()=>{throw Error('navigation failed')})
  const component=(doc:string)=><SpeechHtmlFrame title="edit" srcDoc={doc} widget helperBinding={{sessionId:'real',storyId:'story'}} onMessageEdit={edit} onMessageBranch={open}/>
  const emit=(action:string)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:source},data:{value:{source:'dsh-tavern-card',action,requestId:'edit',storyId:'story',historyRevision:'revision',edits:[{message_id:0,message:'new'}]}}});events.dispatchEvent(event)}
  await mount(component('old'));await act(async()=>emit('helperMessageEdit'));await act(async()=>view!.update(component('new')));await act(async()=>finish({branch:{childSessionId:'child-old',title:'old'}}))
  expect(source.postMessage).not.toHaveBeenCalled();await act(async()=>emit('helperMessageEditApplied'));expect(open).not.toHaveBeenCalled()
  await act(async()=>emit('helperMessageEdit'));await act(async()=>finish({branch:{childSessionId:'child-new',title:'new'}}));await act(async()=>emit('helperMessageEditApplied'))
  expect(view!.root.findByProps({role:'alert'}).children.join('')).toContain('navigation failed')
  expect(view!.root.findAllByType(Btn).some(button=>button.props.children==='打开消息编辑分支')).toBe(true)
})

it('删除桥同样固定来源和剧情，拒绝混合字段，支持长删除批次且等回执确认后导航',async()=>{
  const edit=vi.fn(async()=>({branch:{childSessionId:'deleted',title:'删除聊天消息'}})),open=vi.fn(async()=>{})
  await mount(<SpeechHtmlFrame title="delete" srcDoc="delete" widget helperBinding={{sessionId:'real',storyId:'story'}} onMessageEdit={edit} onMessageBranch={open}/>)
  const emit=(action:string,edits:unknown,from:unknown=source,storyId='story')=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action,requestId:'delete',storyId,historyRevision:'revision',edits,sessionId:'forged',messageId:999,path:'private'}}});events.dispatchEvent(event)}
  await act(async()=>emit('helperMessageEdit',[{message_id:0,delete:true}],{}));await act(async()=>emit('helperMessageEdit',[{message_id:0,delete:true}],source,'other'))
  await act(async()=>emit('helperMessageEdit',[{message_id:0,delete:true,data:{x:1}}]));expect(edit).not.toHaveBeenCalled()
  const rows=Array.from({length:100},(_,message_id)=>({message_id,delete:true}))
  await act(async()=>emit('helperMessageEdit',rows));expect(edit).toHaveBeenCalledOnce();expect(edit.mock.calls[0]?.[0]).toEqual({storyId:'story',historyRevision:'revision',edits:rows});expect(open).not.toHaveBeenCalled()
  await act(async()=>emit('helperMessageEditApplied',[],{}));expect(open).not.toHaveBeenCalled();await act(async()=>emit('helperMessageEditApplied',[]));expect(open).toHaveBeenCalledOnce()
})

/** 真实 React 气泡仅在回执确认后替换，并再次执行只读渲染；普通重绘不得毁掉旧卡。 */
it('刷新固定当前会话与消息，准备失败保留原卡，成功确认后替换且可再次刷新',async()=>{
  const snapshot:HelperSnapshot={...helperSnapshot,messages:[{message_id:0,name:'灯塔',role:'assistant',is_hidden:false,message:'卡面',data:{},extra:{}}]}
  let body='<p>旧显示</p>',fail=false
  const renderOutputText=vi.fn(async()=>fail?{ok:false as const,error:{message:'渲染失败'}}:{ok:true as const,value:{text:'',htmls:[body],interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false,helper:snapshot}})
  const getHelperSnapshot=vi.fn(async()=>({ok:true as const,value:snapshot}))
  const rpc={renderOutputText,getHelperSnapshot} as unknown as TavernRemote
  const component=()=> <SpeechBubble remote={rpc} sessionId="display-session" cardId="card" name="灯塔" rawText="卡面" messageId={17}/>
  const send=(data:Record<string,unknown>,from:unknown=source)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',...data}}});events.dispatchEvent(event)}
  await mount(component());const initial=view!.root.findByType('iframe').props.srcDoc
  const request=(id:string)=>({action:'helperDisplayRefresh',requestId:id,storyId:'story',historyRevision:'revision',ids:[0],sessionId:'forged',messageId:999})
  await act(async()=>send(request('forged'),{}));expect(getHelperSnapshot).not.toHaveBeenCalled()
  await act(async()=>send({...request('wrong'),storyId:'other'}));expect(getHelperSnapshot).not.toHaveBeenCalled()
  await act(async()=>send(request('first')))
  const guard=source.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayGuard')![0]
  body='<p>新显示</p>'
  await act(async()=>send({action:'helperDisplayGuardResult',requestId:guard.requestId,ok:true}))
  expect(view!.root.findByType('iframe').props.srcDoc).toBe(initial)
  expect(renderOutputText.mock.calls.at(-1)?.[0]).toEqual({sessionId:'display-session',text:'卡面',messageId:17})
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperDisplayResult',requestId:'first',ok:true}),'*')
  const reads=getHelperSnapshot.mock.calls.length
  await act(async()=>send({action:'helperSnapshotGet',requestId:'during-refresh',storyId:'story'}))
  expect(getHelperSnapshot).toHaveBeenCalledTimes(reads)
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperSnapshotResult',requestId:'during-refresh',ok:false}),'*')
  await act(async()=>view!.update(component()))
  await act(async()=>send({action:'helperDisplayApplied',requestId:'first'},{}));expect(view!.root.findByType('iframe').props.srcDoc).toBe(initial)
  await act(async()=>send({action:'helperDisplayApplied',requestId:'first'}));const updated=view!.root.findByType('iframe').props.srcDoc;expect(updated).toContain('新显示')
  expect(updated).not.toBe(initial);expect(getHelperSnapshot.mock.calls[0]?.[0]).toEqual({sessionId:'display-session',messageId:17})
  source.postMessage.mockClear();fail=true
  await act(async()=>send(request('second')))
  const nextGuard=source.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayGuard')![0]
  await act(async()=>send({action:'helperDisplayGuardResult',requestId:nextGuard.requestId,ok:true}))
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperDisplayResult',requestId:'second',ok:false,error:'渲染失败'}),'*')
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperDisplayUnlock'}),'*')
  expect(view!.root.findByType('iframe').props.srcDoc).toBe(updated)
})
it('未显示楼层无需重建；拒绝错误序号和陈旧历史，取消迟到的显示发布',async()=>{
  const {registerHelperDisplay}=await import('../src/client/helperDisplay.js')
  const lease={check:vi.fn(),commit:vi.fn(),cancel:vi.fn()},prepare=vi.fn(async()=>lease)
  const stop=registerHelperDisplay('display-bound',prepare)
  const snapshot={...helperSnapshot,messages:[{message_id:0,name:'灯塔',role:'assistant' as const,is_hidden:false,message:'卡面',data:{},extra:{}}]}
  const component=(doc:string)=><SpeechHtmlFrame title="display" srcDoc={doc} widget helperBinding={{sessionId:'display-bound',storyId:'story'}} onHelperRefresh={async()=>snapshot}/>
  const send=(id:string,data:Record<string,unknown>)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:source},data:{value:{source:'dsh-tavern-card',action:'helperDisplayRefresh',requestId:id,storyId:'story',historyRevision:'revision',ids:[0],...data}}});events.dispatchEvent(event)}
  try{
    await mount(component('old'));await act(async()=>send('bad',{ids:[1]}));await act(async()=>send('stale',{historyRevision:'old'}));expect(prepare).not.toHaveBeenCalled()
    await act(async()=>send('valid',{}));expect(prepare).toHaveBeenCalledOnce();expect(lease.commit).not.toHaveBeenCalled()
    await act(async()=>view!.update(component('new')));expect(lease.cancel).toHaveBeenCalledOnce()
    await act(async()=>send('valid',{action:'helperDisplayApplied'}));expect(lease.commit).not.toHaveBeenCalled()
  }finally{stop()}
})


/** 多卡面属于一个可见消息：真实 React 挂载与真实宿主事件路由协作，只在全体就绪后发一次。 */
it('同一消息的全部卡面就绪才发送显示事件，all 等待新卡后发一次 CHAT_CHANGED',async()=>{
  const {attachHelperEvents}=await import('../src/client/helperEventRouter.js')
  const deliveries:{event:string;args:unknown}[]=[],frames:{postMessage:ReturnType<typeof vi.fn>}[]=[]
  const prepared=new Map<string,{event:string;args:unknown}>()
  const observer=attachHelperEvents('lifecycle-session','story',message=>{
    if(message.action==='helperEventDeliver'){prepared.set(String(message.deliveryId),{event:String(message.listenerId),args:message.args});queueMicrotask(()=>observer.receive({source:'dsh-tavern-card',action:'helperEventPrepared',runtimeId:'observer',deliveryId:message.deliveryId,args:message.args}))}
    if(message.action==='helperEventCancel')prepared.delete(String(message.deliveryId))
    if(message.action==='helperEventExecute'){const pending=prepared.get(String(message.deliveryId));if(!pending)return;prepared.delete(String(message.deliveryId));deliveries.push(pending);queueMicrotask(()=>observer.receive({source:'dsh-tavern-card',action:'helperEventReply',runtimeId:'observer',deliveryId:message.deliveryId,args:pending.args,ok:true}))}
  })
  observer.receive({source:'dsh-tavern-card',action:'helperEventConnect',runtimeId:'observer'})
  for(const name of ['character_message_rendered','chat_id_changed'])observer.receive({source:'dsh-tavern-card',action:'helperEventSubscribe',runtimeId:'observer',listenerId:name,event:name,once:false,position:'normal'})
  const snapshot:HelperSnapshot={...helperSnapshot,messages:[{message_id:0,name:'灯塔',role:'assistant',message:'卡面',is_hidden:false,data:{},extra:{}}]}
  const getHelperSnapshot=vi.fn(async()=>({ok:true as const,value:snapshot}))
  const rpc={renderOutputText:async()=>({ok:true,value:{text:'',htmls:['<p>卡一</p>','<p>卡二</p>'],interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,helper:snapshot}}),getHelperSnapshot} as unknown as TavernRemote
  const component=()=> <SpeechBubble remote={rpc} sessionId="lifecycle-session" cardId="card" name="灯塔" rawText="卡面" messageId={9}/>
  const send=(from:unknown,value:Record<string,unknown>)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',...value}}});events.dispatchEvent(event)}
  const ready=(frame:unknown,runtimeId:string)=>{send(frame,{action:'helperEventConnect',runtimeId});send(frame,{action:'helperFrameReady',runtimeId})}
  try{
    await act(async()=>{view=create(component(),{createNodeMock:element=>{if(element.type!=='iframe')return null;const frame={postMessage:vi.fn()};frames.push(frame);return {contentWindow:frame}}})})
    expect(frames).toHaveLength(2);await act(async()=>ready(frames[0],'a'));expect(deliveries).toEqual([])
    await act(async()=>send(frames[1],{action:'helperFrameReady',runtimeId:'not-connected'}));expect(deliveries).toEqual([])
    await act(async()=>ready(frames[1],'b'));expect(deliveries).toEqual([{event:'character_message_rendered',args:[0,'normal']}])
    await act(async()=>{send(frames[0],{action:'helperFrameReady',runtimeId:'a'});view!.update(component())});expect(deliveries).toHaveLength(1)
    await act(async()=>send(frames[0],{action:'helperDisplayRefresh',requestId:'all',storyId:'story',historyRevision:'revision',ids:null}))
    await act(async()=>{for(const frame of frames){const guard=frame.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayGuard')![0];send(frame,{action:'helperDisplayGuardResult',requestId:guard.requestId,ok:true})}})
    await act(async()=>send(frames[0],{action:'helperDisplayApplied',requestId:'all'}));expect(frames).toHaveLength(4);expect(deliveries).toHaveLength(1)
    await act(async()=>{ready(frames[2],'c');send(frames[3],{action:'helperFrameReady',runtimeId:'b'})});expect(deliveries).toHaveLength(1)
    await act(async()=>ready(frames[3],'d'));expect(deliveries).toEqual([{event:'character_message_rendered',args:[0,'normal']},{event:'character_message_rendered',args:[0,'normal']},{event:'chat_id_changed',args:['story']}])
    await act(async()=>send(frames[3],{action:'helperFrameReady',runtimeId:'d'}));expect(deliveries).toHaveLength(3)
  }finally{observer.dispose()}
})

/** 一页中旧气泡停留 H1、新气泡已是 H2；用真实 React 与沙箱回执确认目标选择依据宿主最新快照。 */
it.each(['affected','all'] as const)('新消息追加后 %s 重绘跳过旧显示修订，仍拒绝真正过期请求',async mode=>{
  const {prepareHelperDisplay}=await import('../src/client/helperDisplay.js')
  const frames:{postMessage:ReturnType<typeof vi.fn>}[]=[],counts=new Map<number,number>()
  const messages:HelperSnapshot['messages']=[0,1].map(message_id=>({message_id,name:'灯塔',role:'assistant',is_hidden:false,message:'卡面'+message_id,data:{},extra:{}}))
  const latest=(id:number):HelperSnapshot=>({...helperSnapshot,historyRevision:'H2',currentMessageId:id===17?0:1,messages})
  const getHelperSnapshot=vi.fn(async({messageId}:{messageId:number})=>({ok:true as const,value:latest(messageId)}))
  const renderOutputText=vi.fn(async({messageId}:{messageId:number})=>{
    const count=(counts.get(messageId)??0)+1;counts.set(messageId,count)
    const helper=latest(messageId)
    return {ok:true as const,value:{text:'',htmls:['<p>卡面'+messageId+'</p>'],interactiveCards:true,whitelist:[],greetings:[],greetingIndex:0,canSwipeGreeting:false,
      helper:messageId===17&&count===1?{...helper,historyRevision:'H1',messages:messages.slice(0,1)}:helper}}
  })
  const rpc={getHelperSnapshot,renderOutputText} as unknown as TavernRemote
  const component=<>{[17,27].map(messageId=><SpeechBubble key={messageId} remote={rpc} sessionId="history-display" cardId="card" name="灯塔" rawText={'卡面'+messageId} messageId={messageId}/>)}</>
  const send=(from:unknown,value:Record<string,unknown>)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',...value}}});events.dispatchEvent(event)}
  await act(async()=>{view=create(component,{createNodeMock:element=>{if(element.type!=='iframe')return null;const frame={postMessage:vi.fn()};frames.push(frame);return {contentWindow:frame}}})})
  expect(frames).toHaveLength(2)
  const original=view!.root.findAllByType('iframe')
  expect(original[0]!.props.srcDoc).toContain('H1');expect(original[1]!.props.srcDoc).toContain('H2')
  await act(async()=>{await expect(prepareHelperDisplay('history-display',{storyId:'another-story',historyRevision:'H2',ids:null})).rejects.toMatchObject({code:'stale'})})
  expect(getHelperSnapshot).not.toHaveBeenCalled()
  await act(async()=>{await expect(prepareHelperDisplay('history-display',{storyId:'story',historyRevision:'H1',ids:null})).rejects.toMatchObject({code:'stale'})})
  expect(renderOutputText).toHaveBeenCalledTimes(2)
  expect(frames.every(frame=>frame.postMessage.mock.calls.every(([value])=>value.action!=='helperDisplayGuard'))).toBe(true)
  await act(async()=>send(frames[1],{action:'helperDisplayRefresh',requestId:'new',storyId:'story',historyRevision:'H2',ids:mode==='all'?null:[1]}))
  const targets=mode==='all'?frames.slice():[frames[1]!]
  if(mode==='affected')expect(frames[0]!.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayGuard')).toBe(false)
  await act(async()=>{for(const frame of targets){const guard=frame.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayGuard')![0];expect(guard.historyRevision).toBe('H2');send(frame,{action:'helperDisplayGuardResult',requestId:guard.requestId,ok:true})}})
  expect(frames[1]!.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperDisplayResult',requestId:'new',ok:true}),'*')
  expect(view!.root.findAllByType('iframe')[0]).toBe(original[0]);expect(view!.root.findAllByType('iframe')[1]).toBe(original[1])
  await act(async()=>send(frames[1],{action:'helperDisplayApplied',requestId:'new'}))
  const updated=view!.root.findAllByType('iframe')
  expect(updated[1]).not.toBe(original[1])
  if(mode==='all'){expect(updated[0]).not.toBe(original[0]);expect(updated[0]!.props.srcDoc).toContain('H2')}
  else expect(updated[0]).toBe(original[0])
  expect(counts.get(17)).toBe(mode==='all'?2:1);expect(counts.get(27)).toBe(2)
  expect(getHelperSnapshot).toHaveBeenCalledWith({sessionId:'history-display',messageId:17})
  expect(getHelperSnapshot).toHaveBeenCalledWith({sessionId:'history-display',messageId:27})
  await act(async()=>{for(let index=2;index<frames.length;index++){send(frames[index],{action:'helperEventConnect',runtimeId:'updated-'+index});send(frames[index],{action:'helperFrameReady',runtimeId:'updated-'+index})}})
})

/** 等待首条消息的后台脚本随剧情通知启动，运行后保持同一沙箱，避免每个新回复重新执行脚本。 */
it('后台脚本空历史等待可由当前剧情通知启动，后续消息及其它剧情通知不重启',async()=>{
  const {notifyHelperStory}=await import('../src/client/helperNotifications.js')
  const trees=parseHelperScriptTrees([{id:'first-script',name:'首消息脚本',enabled:true,content:'window.firstMessageFactory=1'}])
  let available=false
  const getHelperScriptBundle=vi.fn(async()=>({ok:true as const,value:{cardId:'card',revision:'scripts',storyId:'first-story',trees,enabled:true,whitelist:[],
    messageId:available?17:null,...(available?{snapshot:{...helperSnapshot,storyId:'first-story'}}:{})}}))
  const rpc={getHelperScriptBundle} as unknown as TavernRemote
  await mount(<HelperScripts remote={rpc} sessionId="first-session"/>)
  expect(getHelperScriptBundle).toHaveBeenCalledOnce();expect(view!.root.findAllByType('iframe')).toHaveLength(0)
  await act(async()=>{notifyHelperStory('first-session','other-story');notifyHelperStory('other-session','first-story')})
  expect(getHelperScriptBundle).toHaveBeenCalledOnce()
  available=true
  await act(async()=>{notifyHelperStory('first-session','first-story');notifyHelperStory('first-session','first-story')})
  expect(getHelperScriptBundle).toHaveBeenCalledTimes(2)
  const running=view!.root.findByType('iframe')
  expect(running.props.srcDoc).toContain('window.firstMessageFactory=1');expect(running.props.sandbox).toBe('allow-scripts')
  await act(async()=>{notifyHelperStory('first-session','first-story');notifyHelperStory('first-session','other-story')})
  expect(getHelperScriptBundle).toHaveBeenCalledTimes(2);expect(view!.root.findByType('iframe')).toBe(running)
  expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperSnapshotInvalidated',storyId:'first-story'}),'*')
  await act(async()=>view!.unmount());view=undefined;source.postMessage.mockClear()
  await act(async()=>notifyHelperStory('first-session','first-story'))
  expect(getHelperScriptBundle).toHaveBeenCalledTimes(2);expect(source.postMessage).not.toHaveBeenCalled()
})
it.each(['disabled','failed','empty'] as const)('后台脚本 %s 时普通剧情通知不重试启动',async state=>{
  const {notifyHelperStory}=await import('../src/client/helperNotifications.js')
  const trees=state==='empty'?[]:parseHelperScriptTrees([{id:'script',name:'脚本',enabled:true,content:'window.test=1'}])
  const getHelperScriptBundle=vi.fn(async()=>({ok:true as const,value:{cardId:'card',revision:'scripts',storyId:'waiting-story',trees,enabled:state!=='disabled',whitelist:[],messageId:null,...(state==='failed'?{runtimeError:'脚本快照读取失败'}:{})}}))
  await mount(<HelperScripts remote={{getHelperScriptBundle} as unknown as TavernRemote} sessionId="waiting-session"/>)
  await act(async()=>notifyHelperStory('waiting-session','waiting-story'))
  expect(getHelperScriptBundle).toHaveBeenCalledOnce();expect(view!.root.findAllByType('iframe')).toHaveLength(0)
})
/** 脚本编辑布局交互：搜索不丢草稿，跨页签保存校验定位错误，保存成功仍可连续编辑。 */
it('搜索与切换分组保留脚本草稿，非法变量定位到变量页，保存后留在当前脚本',async()=>{
  const trees=parseHelperScriptTrees([{id:'a',name:'晨光',content:'old'},{id:'b',name:'夜色',content:'night'}])
  const saved=vi.fn(),closed=vi.fn()
  const saveCharacterHelperScripts=vi.fn(async(request:{trees:unknown})=>({ok:true,value:{cardId:'card',revision:'v2',trees:request.trees}}))
  await mount(<HelperScriptEditorBody remote={{saveCharacterHelperScripts} as unknown as TavernRemote} library={{cardId:'card',revision:'v1',trees}} onClose={closed} onSaved={saved}/>)
  const click=(label:string)=>view!.root.findAllByType(Btn).find(button=>button.props.children===label)!.props.onClick()
  expect(view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.value).toBe('old')
  expect(view!.root.findAllByType(Btn).find(button=>button.props.children==='上移')!.props.disabled).toBe(true)
  await act(async()=>view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.onChange({target:{value:'edited'}}))
  await act(async()=>view!.root.findByType(SearchInput).props.onChange('夜'))
  await act(async()=>click('夜色'))
  await act(async()=>view!.root.findByType(SearchInput).props.onChange(''))
  await act(async()=>click('晨光'))
  expect(view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.value).toBe('edited')
  await act(async()=>view!.root.findByType(Tabs).props.onChange('data'))
  await act(async()=>view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.onChange({target:{value:'[]'}}))
  await act(async()=>view!.root.findByType(Tabs).props.onChange('code'))
  await act(async()=>click('保存并重新加载'))
  expect(saveCharacterHelperScripts).not.toHaveBeenCalled()
  expect(view!.root.findByType(Tabs).props.value).toBe('data')
  expect(view!.root.findByProps({role:'alert'}).children.join('')).toContain('晨光')
  await act(async()=>view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.onChange({target:{value:'{"hp":7}'}}))
  await act(async()=>click('格式化 JSON'))
  expect(view!.root.findByProps({'aria-label':'初始变量（JSON 对象）'}).props.value).toBe('{\n  "hp": 7\n}')
  await act(async()=>{click('保存并重新加载');click('保存并重新加载')})
  expect(saveCharacterHelperScripts).toHaveBeenCalledOnce();expect(saved).toHaveBeenCalledOnce();expect(closed).not.toHaveBeenCalled()
  expect(view!.root.findAllByType(Btn).find(button=>button.props.children==='保存并重新加载')!.props.disabled).toBe(true)
  expect(view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.value).toBe('edited')
})

it('导入先替换草稿并选中新脚本，不直接保存或启用资产',async()=>{
  const saveCharacterHelperScripts=vi.fn()
  await mount(<HelperScriptEditorBody remote={{saveCharacterHelperScripts} as unknown as TavernRemote} library={{cardId:'card',revision:'v1',trees:[]}} onClose={()=>{}} onSaved={()=>{}}/>)
  const file={size:128,text:async()=>JSON.stringify([{id:'imported',name:'导入项',content:'imported code',enabled:false}])} as File
  await act(async()=>view!.root.findByType(FileBtn).props.onFile(file))
  expect(view!.root.findByProps({'aria-label':'JavaScript 正文'}).props.value).toBe('imported code')
  expect(view!.root.findAllByType(Toggle)[0]!.props.checked).toBe(false)
  expect(saveCharacterHelperScripts).not.toHaveBeenCalled()
})

it('脚本诊断必须来自绑定 iframe 的当前运行时，伪造和旧运行时不能改变状态',async()=>{
  const failed=vi.fn(),ready=vi.fn()
  await mount(<SpeechHtmlFrame srcDoc="diagnostic" title="script" helperBinding={{sessionId:'session',storyId:'story'}} onScriptReady={ready} onScriptError={failed}/>)
  const send=(action:string,runtimeId:string,from:unknown=source)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action,runtimeId,error:'bad script'}}});events.dispatchEvent(event)}
  await act(async()=>{send('helperEventConnect','runtime');send('helperScriptDiagnostic','runtime',{});send('helperScriptDiagnostic','stale')})
  expect(failed).not.toHaveBeenCalled()
  await act(async()=>send('helperScriptDiagnostic','runtime'))
  expect(failed).toHaveBeenCalledWith('bad script');expect(ready).toHaveBeenLastCalledWith(false)
})

it('消息选项只接受当前运行时与真实快照，迟到的旧历史不能保留旧按钮',async()=>{
  const snapshot={...helperSnapshot,messages:[{message_id:0,name:'C',role:'assistant' as const,is_hidden:false,message:'text',data:{},extra:{}}]}
  const refresh=vi.fn(async()=>snapshot),failed=vi.fn()
  await mount(<><SpeechHtmlFrame srcDoc="choices" title="script" helperBinding={{sessionId:'session',storyId:'story'}} onScriptReady={()=>{}} onScriptError={failed} onHelperRefresh={refresh}/><ScriptChoices sessionId="session" context={snapshot}/></>)
  const send=(action:string,options:Record<string,unknown>={},from:unknown=source)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',action,runtimeId:'runtime',storyId:'story',historyRevision:'revision',messageId:0,choices:[{label:'Choice',text:'Draft'}],...options}}});events.dispatchEvent(event)}
  await act(async()=>{send('helperEventConnect');send('helperScriptChoices',{},{});send('helperScriptChoices',{runtimeId:'stale'})})
  expect(refresh).not.toHaveBeenCalled()
  await act(async()=>send('helperScriptChoices'));expect(view!.root.findAllByType(Btn).some(button=>button.props.children==='Choice')).toBe(true)
  await act(async()=>send('helperScriptChoices',{historyRevision:'old'}));expect(failed).toHaveBeenCalled();expect(view!.root.findAllByType(Btn).some(button=>button.props.children==='Choice')).toBe(false)
})

it('旧卡高度回执仅接受本 iframe，原生探测不会覆盖卡片自己报告的收缩高度',async()=>{
 await mount(<SpeechHtmlFrame srcDoc="legacy-height" title="status"/>)
 const send=(data:unknown,from:unknown=source)=>{const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:data}});events.dispatchEvent(event)}
 await act(async()=>send({type:'iframe-resize',height:430},{}));expect(view!.root.findByType('iframe').props.style.height).toBeUndefined()
 await act(async()=>send({type:'iframe-resize',height:430}));expect(view!.root.findByType('iframe').props.style.height).toBe(430)
 await act(async()=>send({source:'dsh-tavern-card',action:'resize',height:610}));expect(view!.root.findByType('iframe').props.style.height).toBe(430)
 await act(async()=>send({type:'resizeIframe',height:999999}));expect(view!.root.findByType('iframe').props.style.height).toBe(8000)
})
