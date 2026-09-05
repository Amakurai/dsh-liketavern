/** 交互卡消息行为：真实 React + 伪 iframe 窗口，验证来源校验、连续点击去重、错误反馈与会话隔离。 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SpeechBubble } from '../src/client/speech.js'
import type { TavernRemote } from '../src/client/types.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn } from '../src/client/util.js'

vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/client/cache.js', () => ({ cachedAvatar: async () => ({ ok: true, value: { dataUrl: null } }) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutline16: () => null, IconUserOutline16: () => null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; children?: ReactNode; footer?: ReactNode }) => p.open ? <div>{p.children}{p.footer}</div> : null,
  MarkdownText: (p: {text:string}) => <p data-markdown={p.text}>{p.text}</p>, Toast: () => null,
}))
let view: ReactTestRenderer | undefined
let events: EventTarget
const source = {}
const remote = { renderOutputText: async () => ({ ok: true, value: { text: '', htmls: ['<p>测试卡</p>'], interactiveCards: true,
  whitelist: [], greetings: ['初始', '备选'], greetingIndex: 0, canSwipeGreeting: true } }) } as unknown as TavernRemote
beforeEach(() => { events = new EventTarget(); vi.stubGlobal('window', events); setTavernLocale('zh') })
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

it('恢复由用户在宿主输入；错误备份保留原 iframe，合法备份重建隔离卡面', async () => {
  await mount(node(vi.fn(async () => {})))
  const oldFrame = view!.root.findByType('iframe')
  const before = oldFrame.props.srcDoc
  const click = (text: string) => view!.root.findAllByType(Btn).find((b) => b.props.children === text)!.props.onClick()
  await act(async () => click('恢复卡内备份'))
  await act(async () => view!.root.findByType('textarea').props.onChange({ target: { value: 'bad' } }))
  await act(async () => click('确定'))
  expect(view!.root.findByType('iframe')).toBe(oldFrame)
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('备份无效')
  const backup = JSON.stringify({ version: 1, scopes: { '["character",""]': { test: '恢复内容' } } })
  await act(async () => view!.root.findByType('textarea').props.onChange({ target: { value: backup } }))
  await act(async () => click('确定'))
  const after = view!.root.findByType('iframe')
  expect(after).not.toBe(oldFrame)
  expect(after.props.srcDoc).not.toBe(before)
  expect(after.props.srcDoc).toContain('恢复内容')
  expect(after.props.sandbox).toBe('allow-scripts')
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
