/**
 * 交互卡 srcDoc：默认放行 https 图片/字体；注入 ST stub；解析 swipe 桥消息。
 */
import { describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'
import { buildCardSrcDoc, CARD_BRIDGE_SOURCE, parseCardBridgeMessage, tavernCardBridgeScript } from '../src/core/cardFrame.js'

describe('buildCardSrcDoc', () => {
  it('CSP 允许沙箱内模板编译，默认不加载外部脚本或连接网络', () => {
    const doc = buildCardSrcDoc('<html><head></head><body>hi</body></html>', { greetings: ['cover'], greetingIndex: 0 })
    expect(doc).toContain("img-src https: http: data: blob:")
    expect(doc).toContain("font-src https: http: data:")
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval';")
    expect(doc).toContain('getChatMessages')
    expect(doc).toContain('setChatMessage')
    expect(doc).toContain('SillyTavern')
    expect(doc).toContain('shimStorage') // opaque origin 下 localStorage 访问会抛，须装内存 shim
    expect(doc).toContain('reportHeight')
  })

  it('白名单主机写入 connect-src 与 script-src', () => {
    const doc = buildCardSrcDoc('<html><head></head><body></body></html>', {
      greetings: [],
      greetingIndex: 0,
      connectHosts: ['example.com'],
    })
    expect(doc).toContain('connect-src https://example.com')
    expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval' https://example.com")
  })

  it('白名单 * = 全部放行 https/http', () => {
    const doc = buildCardSrcDoc('<html><head></head><body></body></html>', {
      greetings: [],
      greetingIndex: 0,
      connectHosts: ['*'],
    })
    expect(doc).toContain('connect-src https: http:')
    expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval' https: http:")
  })

  it('非法白名单条目被丢弃：含引号/空白的注入尝试不进 CSP', () => {
    const doc = buildCardSrcDoc('<html><head></head><body></body></html>', {
      greetings: [],
      greetingIndex: 0,
      connectHosts: ['good.com', 'ok.dev:8443', 'https://fine.net', 'evil.com"><script>alert(1)</script>', 'not a host', 'ftp://bad.scheme'],
    })
    expect(doc).toContain('connect-src https://good.com https://ok.dev:8443 https://fine.net')
    expect(doc).not.toContain('evil.com')
    expect(doc).not.toContain('not a host')
    expect(doc).not.toContain('ftp://')
  })

  it('无 html 根的片段包成文档，并拦截 document.write', () => {
    const doc = buildCardSrcDoc('<style>.x{}</style><div class="x">hi</div>', { greetings: [], greetingIndex: 0 })
    expect(doc).toContain('<html>')
    expect(doc).toContain('<body>')
    expect(doc).toContain('<style>.x{}</style>')
    expect(doc).toContain('data-dsh-tavern-bridge')
    expect(doc).toContain('document.write')
    expect(doc).toContain('injectBridge')
  })

  it.each([
    '<!-- <head>伪造的插入点</head> --><html><head></head><body><script>fetch("https://example.invalid/comment")</script></body></html>',
    '<script>fetch("https://example.invalid/early")</script><html><head></head><body>正文</body></html>',
    '<!DoCtYpE hTmL><HTML lang="zh"><HEAD><style>.card{color:red}</style></HEAD><BODY class="card">正文</BODY></HTML>',
    '<html><head data-dsh-tavern-bridge></head><body>伪造已安装标记</body></html>',
  ])('有效 CSP 和可信桥位于整个第三方文档之前：%s', (payload) => {
    const doc = buildCardSrcDoc(payload, { greetings: [], greetingIndex: 0 })
    expect(doc).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/)
    const payloadStart = doc.indexOf(payload)
    expect(payloadStart).toBeGreaterThan(doc.indexOf("connect-src 'none'"))
    expect(payloadStart).toBeGreaterThan(doc.indexOf('<script data-dsh-tavern-bridge>'))
    expect(doc.slice(payloadStart)).toBe(`${payload}</body></html>`)
  })
})

describe('tavernCardBridgeScript', () => {
  it('重装桥后重写文档仍直达原生方法，不叠加旧包装或旧观察器', () => {
    const nativeOpen = vi.fn(), nativeWrite = vi.fn(), nativeClose = vi.fn()
    const window = { name: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { reload: vi.fn() } }
    const document = { open: nativeOpen, write: nativeWrite, close: nativeClose, currentScript: null,
      querySelector: () => null, readyState: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const context = createContext({ window, document, parent: { postMessage: vi.fn() }, TextEncoder, clearTimeout, setTimeout })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    for (let n = 0; n < 3; n++) {
      runInContext(script, context)
      document.open()
      document.write('<html><head></head><body>工厂页面</body></html>')
      document.close()
    }
    expect(nativeOpen).toHaveBeenCalledTimes(3)
    expect(nativeWrite).toHaveBeenCalledTimes(3)
    expect(nativeClose).toHaveBeenCalledTimes(3)
    expect(window.removeEventListener.mock.calls.filter(([event]) => event === 'load')).toHaveLength(2)
    expect(window.removeEventListener.mock.calls.filter(([event]) => event === 'error')).toHaveLength(2)
    expect(window.removeEventListener.mock.calls.filter(([event]) => event === 'unhandledrejection')).toHaveLength(2)
  })
  it('把开场白变体编进脚本，避免 </script> 打断', () => {
    const script = tavernCardBridgeScript({ greetings: ['cover</script>', 'alt-greeting'], greetingIndex: 0 })
    expect(script).toContain('\\u003c')
    expect(script).toContain('alt-greeting')
  })

  it('document.write 遇到假 head 或假 bridge 仍先写入可信 CSP 与桥，保留原文和白名单', () => {
    const nativeWrite = vi.fn()
    const trustedCsp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src https://approved.example">'
    const trustedBridge = '<script data-dsh-tavern-bridge>/* trusted bridge */</script>'
    const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const document = { open: vi.fn(), write: nativeWrite, close: vi.fn(), currentScript: { outerHTML: trustedBridge },
      querySelector: () => ({ outerHTML: trustedCsp }), readyState: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const context = createContext({ window, document, parent: { postMessage: vi.fn() }, TextEncoder, clearTimeout, setTimeout })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    runInContext(script, context)
    for (const payload of [
      '<!-- <head> -->\n<script>fetch("https://blocked.invalid")</script><html><body>重写正文</body></html>',
      '<!DOCTYPE html><html><head data-dsh-tavern-bridge></head><body>伪装已有桥</body></html>',
      '<!DOCTYPE html><HTML><HEAD><style>.card{display:block}</style></HEAD><BODY>大小写</BODY></HTML>',
    ]) {
      document.open()
      document.write(payload)
      document.close()
      const written = nativeWrite.mock.lastCall?.[0] as string
      expect(written).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8">/)
      expect(written.indexOf(trustedCsp)).toBeLessThan(written.indexOf(trustedBridge))
      expect(written.indexOf(trustedBridge)).toBeLessThan(written.indexOf(payload))
      expect(written).toContain(`${trustedCsp}${trustedBridge}</head><body>${payload}`)
    }
    expect(nativeWrite).toHaveBeenCalledTimes(3)
  })
})

describe('parseCardBridgeMessage', () => {
  it('只接受本插件 source 的 swipeGreeting', () => {
    expect(parseCardBridgeMessage({ source: CARD_BRIDGE_SOURCE, action: 'swipeGreeting', index: 1 })).toEqual({
      source: CARD_BRIDGE_SOURCE,
      action: 'swipeGreeting',
      index: 1,
    })
    expect(parseCardBridgeMessage({ source: 'other', action: 'swipeGreeting', index: 1 })).toBeNull()
    expect(parseCardBridgeMessage(null)).toBeNull()
    expect(parseCardBridgeMessage({ source: CARD_BRIDGE_SOURCE, action: 'resize', height: 240 })).toEqual({
      source: CARD_BRIDGE_SOURCE,
      action: 'resize',
      height: 240,
    })
  })
})

/** 使用真实注入桥验证尺寸反馈，视口高度不能成为卡片折叠后的高度下限。 */
it('卡片内容折叠后可以缩小，内容扩展仍通知新高度',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn()
  let contentHeight=560
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn()}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{scrollHeight:560,offsetHeight:560,clientHeight:560},
    body:{get offsetHeight(){return contentHeight},get scrollHeight(){return Math.max(contentHeight,560)},
      querySelectorAll:()=>[{getBoundingClientRect:()=>({bottom:contentHeight})}]}}
  const context=createContext({window,document,parent:{postMessage},TextEncoder,clearTimeout:vi.fn(),setTimeout:vi.fn()})
  const script=tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  runInContext(script,context)
  callbacks.get('DOMContentLoaded')?.()
  contentHeight=180;callbacks.get('load')?.()
  contentHeight=720;callbacks.get('load')?.()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([560,180,720])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** 收起 details 后 Chromium 保留内部旧矩形；标题可见、正文不可见，必须区分测量。 */
it('折叠日志的隐藏旧矩形不撑高卡片，展开和再次收起立即同步',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn()
  const summary={tagName:'SUMMARY',contains:(node:unknown)=>node===label}
  const details={tagName:'DETAILS',open:false,children:[summary],parentElement:null}
  const label={parentElement:details,getBoundingClientRect:()=>({bottom:64})}
  const content={parentElement:details,getBoundingClientRect:()=>({bottom:530})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:560},body:{get offsetHeight(){return details.open?530:52},scrollHeight:560,querySelectorAll:()=>[label,content]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn()}
  const context=createContext({window,document,parent:{postMessage},TextEncoder,clearTimeout:vi.fn(),setTimeout:vi.fn()})
  const script=tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  runInContext(script,context)
  callbacks.get('DOMContentLoaded')?.()
  details.open=true;callbacks.get('toggle')?.()
  details.open=false;callbacks.get('toggle')?.()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([64,530,64])
  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(document.removeEventListener).toHaveBeenCalledWith('toggle',expect.any(Function),true)
})

/** body 外折叠的边距必须纳入实际溢出；视口随后变高也不能锁死收起高度。 */
it('展开内容的外边距不造成内部滚动条，根视口不会阻止再次缩小',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn()
  const root={clientHeight:200,scrollHeight:224}
  let contentHeight=200
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:root,body:{get offsetHeight(){return contentHeight},get scrollHeight(){return contentHeight},getBoundingClientRect:()=>({bottom:contentHeight+12}),querySelectorAll:()=>[]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn()}
  const context=createContext({window,document,parent:{postMessage},TextEncoder,getComputedStyle:()=>({marginBottom:'12px'}),clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('DOMContentLoaded')?.()
  root.clientHeight=224;callbacks.get('toggle')?.()
  contentHeight=52;callbacks.get('toggle')?.()
  root.clientHeight=76;root.scrollHeight=76;callbacks.get('toggle')?.()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([224,76])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** 内部滚动区只占作者指定的可见高度，不能按被裁切的长列表再次撑高整个 iframe。 */
it('受限滚动区的后代矩形按容器裁切，允许外溢时仍可扩展',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn()
  const panel={parentElement:null,tagName:'DIV',children:[],style:{marginBottom:'0px',overflowY:'auto'},getBoundingClientRect:()=>({bottom:120})}
  const child={parentElement:panel,style:{marginBottom:'0px',overflowY:'visible'},getBoundingClientRect:()=>({bottom:920})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:280},body:{offsetHeight:120,scrollHeight:120,querySelectorAll:()=>[panel,child]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn()}
  const context=createContext({window,document,parent:{postMessage},TextEncoder,getComputedStyle:(node:{style?:unknown})=>node.style??{},clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('DOMContentLoaded')?.()
  panel.style.overflowY='visible';callbacks.get('load')?.()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([120,920])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})
