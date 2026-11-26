/**
 * 交互卡 srcDoc：默认放行 https 图片/字体；注入 ST stub；解析 swipe 桥消息。
 */
import { describe, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { buildCardSrcDoc, CARD_BRIDGE_SOURCE, parseCardBridgeMessage, tavernCardBridgeScript } from '../src/core/cardFrame.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'

/** 可控的浏览器帧队列：测试同一帧合并与卸载取消，不用真实计时器制造竞态。 */
function animationFrames() {
  let serial=0
  const pending=new Map<number,(time:number)=>void>()
  const requestAnimationFrame=vi.fn((callback:(time:number)=>void)=>{const id=++serial;pending.set(id,callback);return id})
  const cancelAnimationFrame=vi.fn((id:number)=>{pending.delete(id)})
  const flush=()=>{const tasks=[...pending.values()];pending.clear();for(const task of tasks)task(0)}
  return {requestAnimationFrame,cancelAnimationFrame,flush,pending}
}

describe('buildCardSrcDoc', () => {
  it('纯静态卡不复制大型兼容库，脚本入口与 MVU runner 仍保留完整运行时', () => {
    const staticDoc = buildCardSrcDoc('<style>.status{color:red}</style><div class="status">静态状态</div>', { greetings: [], greetingIndex: 0 })
    expect(staticDoc).not.toContain('<script data-dsh-tavern-libraries>')
    expect(staticDoc.length).toBeLessThan(250_000)
    for (const html of [
      '<script>window.cardReady=Boolean(window.jQuery)</script>',
      '<button onclick="window.cardReady=Boolean(window._)">运行</button>',
      '<a href="javascript:window.cardReady=Boolean(window.z)">运行</a>',
    ]) expect(buildCardSrcDoc(html, { greetings: [], greetingIndex: 0 })).toContain('<script data-dsh-tavern-libraries>')
    expect(buildCardSrcDoc('', { greetings: [], greetingIndex: 0, mvuRunner: true })).toContain('<script data-dsh-tavern-libraries>')
  })

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

  it('普通卡面采用宿主偏好的明暗方案，并保留作者自定义样式', () => {
    const html = '<style>:root{color-scheme:only light}body{color:#123;background:#fff}</style><p>正文</p>'
    const doc = buildCardSrcDoc(html, { greetings: [], greetingIndex: 0 })
    expect(doc).toContain('<meta name="color-scheme" content="light dark"></head><body><style>')
    expect(doc.endsWith(`<body>${html}</body></html>`)).toBe(true)
  })

  it('普通片段仍预建 body，首个卡片脚本可立即访问正文节点',()=>{
    const html='<script>window.cardHadBody=Boolean(document.body)</script><main>片段卡</main>'
    const doc=buildCardSrcDoc(html,{greetings:[],greetingIndex:0})
    const payloadStart=doc.indexOf(html)
    expect(doc.slice(payloadStart-6)).toBe(`<body>${html}</body></html>`)
  })

  it('完整文档沿用原 html/body 属性与 load 初始化，同时可信头仍先执行且不重复闭合 html 标签', () => {
    const html = '<html lang="zh-CN" dir="rtl" class="card-root"><head><title>角色卡</title></head><body class="status-page" style="margin:0" onload="window.cardLoaded=1"><main>正文</main></body></html>'
    const doc = buildCardSrcDoc(html, { greetings: [], greetingIndex: 0 })
    const payloadStart = doc.indexOf(html)
    expect(payloadStart).toBeGreaterThan(doc.indexOf('Content-Security-Policy'))
    expect(payloadStart).toBeGreaterThan(doc.indexOf('data-dsh-tavern-bridge'))
    expect(doc.slice(payloadStart)).toBe(html)
    expect(doc).not.toMatch(/<\/html\s*>\s*<\/html\s*>/i)
    expect(doc.slice(payloadStart).match(/<body\b/gi)).toHaveLength(1)
    expect(doc).toContain('<body class="status-page" style="margin:0" onload="window.cardLoaded=1">')
    expect(doc).toContain('<html lang="zh-CN" dir="rtl" class="card-root">')
    const omitted='<!DOCTYPE html><html lang="en"><body class="legacy-cover">旧卡省略 html 闭标签</body>'
    const legacy=buildCardSrcDoc(omitted,{greetings:[],greetingIndex:0})
    expect(legacy.slice(legacy.indexOf(omitted))).toBe(`${omitted}</html>`)
    expect(legacy.slice(legacy.indexOf(omitted)-7,legacy.indexOf(omitted))).toBe('</head>')
  })

  it.each([
    '<!-- <head>伪造的插入点</head> --><html><head></head><body><script>fetch("https://example.invalid/comment")</script></body></html>',
    '<script>fetch("https://example.invalid/early")</script><html><head></head><body>正文</body></html>',
    '<!DoCtYpE hTmL><HTML lang="zh"><HEAD><style>.card{color:red}</style></HEAD><BODY class="card">正文</BODY></HTML>',
    '<html><head data-dsh-tavern-bridge></head><body>伪造已安装标记</body></html>',
  ])('有效 CSP 和可信桥位于整个第三方文档之前且不重复闭合 </html>：%s', (payload) => {
    const doc = buildCardSrcDoc(payload, { greetings: [], greetingIndex: 0 })
    expect(doc).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/)
    const payloadStart = doc.indexOf(payload)
    expect(payloadStart).toBeGreaterThan(doc.indexOf("connect-src 'none'"))
    expect(payloadStart).toBeGreaterThan(doc.indexOf('<script data-dsh-tavern-bridge>'))
    expect(doc.slice(payloadStart)).toBe(payload)
    expect(doc).not.toMatch(/<\/html\s*>\s*<\/html\s*>/i)
  })

  it('按宿主 colorScheme 写入 meta 声明，缺省保持自适应 light dark', () => {
    const darkDoc = buildCardSrcDoc('<div>卡面</div>', { greetings: [], greetingIndex: 0, colorScheme: 'dark' })
    const lightDoc = buildCardSrcDoc('<div>卡面</div>', { greetings: [], greetingIndex: 0, colorScheme: 'light' })
    const defaultDoc = buildCardSrcDoc('<div>卡面</div>', { greetings: [], greetingIndex: 0 })
    expect(darkDoc).toContain('<meta name="color-scheme" content="dark"></head><body>')
    expect(lightDoc).toContain('<meta name="color-scheme" content="light"></head><body>')
    expect(defaultDoc).toContain('<meta name="color-scheme" content="light dark"></head><body>')
  })
})

describe('tavernCardBridgeScript', () => {
  it('重装桥后重写文档仍直达原生方法，不叠加旧包装或旧观察器', () => {
    const nativeOpen = vi.fn(), nativeWrite = vi.fn(), nativeClose = vi.fn()
    const window = { name: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { reload: vi.fn() } }
    const document = { open: nativeOpen, write: nativeWrite, close: nativeClose, currentScript: null,
      querySelector: () => null, readyState: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const context = createContext({crypto:webcrypto, window, document, parent: { postMessage: vi.fn() }, TextEncoder, clearTimeout, setTimeout })
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
  it('只 write 整页不 close 的封面在下一任务补写并保持打开，不会整页空白；同任务内 close 只写一次', async () => {
    const nativeOpen = vi.fn(), nativeWrite = vi.fn(), nativeClose = vi.fn()
    const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const document = { open: nativeOpen, write: nativeWrite, close: nativeClose, currentScript: null,
      querySelector: () => null, readyState: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const context = createContext({crypto:webcrypto, window, document, parent: { postMessage: vi.fn() }, TextEncoder, clearTimeout, setTimeout, queueMicrotask })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    runInContext(script, context)
    runInContext("document.write('<!DOCTYPE html><html><body>拉取的'); document.write('卡面</body></html>')", context)
    expect(nativeWrite).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(nativeOpen).toHaveBeenCalledTimes(1)
    expect(nativeWrite).toHaveBeenCalledTimes(1)
    expect(nativeWrite.mock.lastCall?.[0]).toContain('<body>拉取的卡面</body>')
    expect(nativeClose).not.toHaveBeenCalled()

    runInContext("document.open(); document.write('<html><body>完整</body></html>'); document.close()", context)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(nativeWrite).toHaveBeenCalledTimes(2)
    expect(nativeClose).toHaveBeenCalledTimes(1)
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
    const context = createContext({crypto:webcrypto, window, document, parent: { postMessage: vi.fn() }, TextEncoder, clearTimeout, setTimeout })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    runInContext(script, context)
    for (const payload of [
      '<!-- <head> -->\n<script>fetch("https://blocked.invalid")</script><html><body>重写正文</body></html>',
      '<!DOCTYPE html><html><head data-dsh-tavern-bridge></head><body>伪装已有桥</body></html>',
      '<!DOCTYPE html><HTML><HEAD><style>.card{display:block}</style></HEAD><BODY>大小写</BODY></HTML>',
      '前文 <code>未闭合\n<html><body>真实卡面</body></html>',
    ]) {
      document.open()
      document.write(payload)
      document.close()
      const written = nativeWrite.mock.lastCall?.[0] as string
      expect(written).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8">/)
      expect(written.indexOf(trustedCsp)).toBeLessThan(written.indexOf(trustedBridge))
      expect(written.indexOf(trustedBridge)).toBeLessThan(written.indexOf(payload))
      expect(written).toContain(`${trustedCsp}${trustedBridge}<meta name="color-scheme" content="light dark"></head>${payload}`)
      expect(written).not.toMatch(/<\/html\s*>\s*<\/html\s*>/i)
    }
    expect(nativeWrite).toHaveBeenCalledTimes(4)
  })

  it('只响应合法父窗口与当前运行时的 setColorScheme，重写文档后保留新配色并在卸载时清理监听', () => {
    const nativeOpen = vi.fn(), nativeWrite = vi.fn(), nativeClose = vi.fn()
    const messageHandlers: Array<(event: unknown) => void> = []
    const window = {
      name: '',
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        if (type === 'message') messageHandlers.push(fn)
      }),
      removeEventListener: vi.fn(),
      location: { reload: vi.fn() },
    }
    const metaNode = { name: 'color-scheme', content: 'light' }
    const document = {
      open: nativeOpen, write: nativeWrite, close: nativeClose, currentScript: null,
      querySelector: (selector: string) => selector === 'meta[name="color-scheme"]' ? metaNode : null,
      readyState: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }
    const parent = { postMessage: vi.fn() }
    const context = createContext({ crypto: webcrypto, window, document, parent, TextEncoder, clearTimeout, setTimeout })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0, colorScheme: 'light' })
      .replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
    runInContext(script, context)

    const runtimeId = (window as { __dshTavernEventRuntimeId?: string }).__dshTavernEventRuntimeId
    expect(typeof runtimeId).toBe('string')
    const dispatch = (event: unknown) => { for (const handler of messageHandlers) handler(event) }

    // 伪造来源、旧运行时或非法值必须忽略
    dispatch({ source: {}, data: { source: CARD_BRIDGE_SOURCE, runtimeId, action: 'setColorScheme', colorScheme: 'dark' } })
    dispatch({ source: parent, data: { source: CARD_BRIDGE_SOURCE, runtimeId: 'stale-runtime', action: 'setColorScheme', colorScheme: 'dark' } })
    dispatch({ source: parent, data: { source: CARD_BRIDGE_SOURCE, runtimeId, action: 'setColorScheme', colorScheme: 'sepia' } })
    expect(metaNode.content).toBe('light')

    // 合法父窗口 + 当前运行时更新 meta 并在 document.write 时保留
    dispatch({ source: parent, data: { source: CARD_BRIDGE_SOURCE, runtimeId, action: 'setColorScheme', colorScheme: 'dark' } })
    expect(metaNode.content).toBe('dark')

    document.open()
    document.write('<html><body>重写内容</body></html>')
    document.close()
    expect(nativeWrite.mock.lastCall?.[0]).toContain('<meta name="color-scheme" content="dark"></head>')

    runInContext('window.__dshTavernBridgeCleanup()', context)
    expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
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
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  let contentHeight=560
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{scrollHeight:560,offsetHeight:560,clientHeight:560},
    body:{get offsetHeight(){return contentHeight},get scrollHeight(){return Math.max(contentHeight,560)},
      querySelectorAll:()=>[{getBoundingClientRect:()=>({bottom:contentHeight})}]}}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,clearTimeout:vi.fn(),setTimeout:vi.fn()})
  const script=tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  runInContext(script,context)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  contentHeight=180;callbacks.get('load')?.();frames.flush()
  contentHeight=720;callbacks.get('load')?.();frames.flush()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([560,180,720])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** 延迟脚本常修改绝对定位节点，body 自身尺寸不变时仍须重新测量。 */
it('DOM 变更和资源加载会重测卡片高度，卸载时清理观察器',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),disconnect=vi.fn(),frames=animationFrames()
  let mutation:()=>void=()=>{},contentHeight=120
  class MutationObserver {constructor(callback:()=>void){mutation=callback}observe=vi.fn();disconnect=disconnect}
  const child={parentElement:null,getBoundingClientRect:()=>({bottom:contentHeight})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set('document:'+name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:280},body:{offsetHeight:80,scrollHeight:80,querySelectorAll:()=>[child]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set('window:'+name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},MutationObserver,TextEncoder,clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('document:DOMContentLoaded')?.();frames.flush()
  contentHeight=360;mutation();frames.flush()
  contentHeight=480;callbacks.get('document:load')?.();frames.flush()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([120,360,480])
  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(disconnect).toHaveBeenCalledOnce()
  expect(document.removeEventListener).toHaveBeenCalledWith('load',expect.any(Function),true)
})

/** 同一浏览器帧的多种尺寸信号只做一次布局读取；卸载后排队任务不得碰已销毁文档。 */
it('合并同帧高度信号并在清理时取消待执行测量',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  let mutation:()=>void=()=>{},resize:()=>void=()=>{},scans=0
  class MutationObserver {constructor(callback:()=>void){mutation=callback}observe=vi.fn();disconnect=vi.fn()}
  class ResizeObserver {constructor(callback:()=>void){resize=callback}observe=vi.fn();disconnect=vi.fn()}
  const child={parentElement:null,getBoundingClientRect:()=>({bottom:120})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set('document:'+name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:280},body:{offsetHeight:120,scrollHeight:120,querySelectorAll:()=>{scans++;return [child]}}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set('window:'+name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},MutationObserver,ResizeObserver,TextEncoder,
    clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('document:DOMContentLoaded')?.()
  mutation();resize();callbacks.get('document:load')?.();callbacks.get('document:toggle')?.();callbacks.get('window:load')?.()
  expect(frames.requestAnimationFrame).toHaveBeenCalledOnce()
  expect(scans).toBe(0)
  frames.flush()
  expect(scans).toBe(1)
  mutation()
  expect(frames.pending.size).toBe(1)
  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(frames.cancelAnimationFrame).toHaveBeenCalledOnce()
  expect(frames.pending.size).toBe(0)
  frames.flush()
  expect(scans).toBe(1)
})

/** 老 WebView 没有动画帧 API 时仍用一个零延时任务合并，并能在卸载时撤销。 */
it('无动画帧 API 时用可取消的零延时高度任务',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),tasks=new Map<number,()=>void>()
  let serial=0
  const setTimeout=vi.fn((callback:()=>void,delay:number)=>{const id=++serial;tasks.set(id,callback);return id})
  const clearTimeout=vi.fn((id:number)=>{tasks.delete(id)})
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set('document:'+name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:280},body:{offsetHeight:120,scrollHeight:120,querySelectorAll:()=>[]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set('window:'+name,fn),removeEventListener:vi.fn()}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,setTimeout,clearTimeout})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('document:DOMContentLoaded')?.();callbacks.get('document:load')?.();callbacks.get('window:load')?.()
  expect(setTimeout.mock.calls.filter(([,delay])=>delay===0)).toHaveLength(1)
  expect(tasks.has(1)).toBe(true)
  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(clearTimeout).toHaveBeenCalledWith(1)
  expect(tasks.size).toBe(0)
})

/** 收起 details 后 Chromium 保留内部旧矩形；标题可见、正文不可见，必须区分测量。 */
it('折叠日志的隐藏旧矩形不撑高卡片，展开和再次收起立即同步',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  const summary={tagName:'SUMMARY',contains:(node:unknown)=>node===label}
  const details={tagName:'DETAILS',open:false,children:[summary],parentElement:null}
  const label={parentElement:details,getBoundingClientRect:()=>({bottom:64})}
  const content={parentElement:details,getBoundingClientRect:()=>({bottom:530})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:560},body:{get offsetHeight(){return details.open?530:52},scrollHeight:560,querySelectorAll:()=>[label,content]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,clearTimeout:vi.fn(),setTimeout:vi.fn()})
  const script=tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  runInContext(script,context)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  details.open=true;callbacks.get('toggle')?.();frames.flush()
  details.open=false;callbacks.get('toggle')?.();frames.flush()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([64,530,64])
  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(document.removeEventListener).toHaveBeenCalledWith('toggle',expect.any(Function),true)
})

/** body 外折叠的边距必须纳入实际溢出；视口随后变高也不能锁死收起高度。 */
it('展开内容的外边距不造成内部滚动条，根视口不会阻止再次缩小',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  const root={clientHeight:200,scrollHeight:224}
  let contentHeight=200
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:root,body:{get offsetHeight(){return contentHeight},get scrollHeight(){return contentHeight},getBoundingClientRect:()=>({bottom:contentHeight+12}),querySelectorAll:()=>[]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,getComputedStyle:()=>({marginBottom:'12px'}),clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  root.clientHeight=224;callbacks.get('toggle')?.();frames.flush()
  contentHeight=52;callbacks.get('toggle')?.();frames.flush()
  root.clientHeight=76;root.scrollHeight=76;callbacks.get('toggle')?.();frames.flush()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([224,76])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** 内部滚动区只占作者指定的可见高度，不能按被裁切的长列表再次撑高整个 iframe。 */
it('受限滚动区的后代矩形按容器裁切，允许外溢时仍可扩展',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  const panel={parentElement:null,tagName:'DIV',children:[],style:{marginBottom:'0px',overflowY:'auto'},getBoundingClientRect:()=>({bottom:120})}
  const child={parentElement:panel,style:{marginBottom:'0px',overflowY:'visible'},getBoundingClientRect:()=>({bottom:920})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:280},body:{offsetHeight:120,scrollHeight:120,querySelectorAll:()=>[panel,child]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,getComputedStyle:(node:{style?:unknown})=>node.style??{},clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  panel.style.overflowY='visible';callbacks.get('load')?.();frames.flush()
  expect(postMessage.mock.calls.map(([message])=>message).filter(message=>message.action==='resize').map(message=>message.height)).toEqual([120,920])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** min-height: 100vh 叠加 body 外边距会导致视口反弹；必须识别并终止正反馈，同时不阻断真实内容展开与折叠。 */
it('阻断 100vh 视口正反馈循环，且不影响真实内容展开与收起',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  const timerCallbacks:Array<()=>void>=[]
  let resize:()=>void=()=>{},mutation:()=>void=()=>{}
  class ResizeObserver {constructor(cb:()=>void){resize=cb}observe=vi.fn();disconnect=vi.fn()}
  class MutationObserver {constructor(cb:()=>void){mutation=cb}observe=vi.fn();disconnect=vi.fn()}
  let clientHeight=280,realContent=180
  const root={get clientHeight(){return clientHeight},clientWidth:640}
  const body={
    get offsetHeight(){return Math.max(realContent,clientHeight)},
    get scrollHeight(){return Math.max(realContent,clientHeight)+16},
    getBoundingClientRect:()=>({bottom:Math.max(realContent,clientHeight)+8,width:624,height:Math.max(realContent,clientHeight)}),
    querySelectorAll:()=>[],
  }
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:root,body}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},ResizeObserver,MutationObserver,TextEncoder,
    getComputedStyle:(node:unknown)=>node===body?{marginBottom:'8px',minHeight:`${clientHeight}px`}:{},
    clearTimeout:vi.fn(),setTimeout:(fn:()=>void)=>{timerCallbacks.push(fn);return timerCallbacks.length}})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)

  const resizes=()=>postMessage.mock.calls.map(([m])=>m).filter(m=>m.action==='resize').map(m=>m.height)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  expect(resizes()).toEqual([296])

  // 宿主把 iframe 拉高到 296，触发 ResizeObserver；100vh 反弹到 312 应立即截断，兜底定时器和无变化 DOM 变更也不继续拉高。
  clientHeight=296;resize();frames.flush()
  for(const fn of timerCallbacks) fn()
  frames.flush()
  mutation();frames.flush()
  expect(resizes()).toEqual([296])

  // 真实内容展开到 520，仍可正常上报新高度。
  realContent=520;mutation();frames.flush()
  expect(resizes()).toEqual([296,536])

  // 随后真实内容折叠到 120 且视口回落，可正常缩小。
  clientHeight=120;realContent=120;mutation();frames.flush()
  expect(resizes()).toEqual([296,536,136])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** fixed 蒙层、display:none 与空矩形不得锁死缩小高度；非视觉标签与 SVG 子图元不占用扫描配额。 */
it('忽略 fixed/display:none/空矩形节点，并在超过 400 个非视觉或 SVG 节点后仍测到末尾可见元素',()=>{
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  const fixedOverlay={tagName:'DIV',parentElement:null,style:{position:'fixed',display:'block'},getBoundingClientRect:()=>({bottom:900,width:640,height:900})}
  const hiddenParent={tagName:'DIV',parentElement:null,style:{display:'none'},getBoundingClientRect:()=>({bottom:800,width:0,height:0})}
  const hiddenChild={tagName:'SPAN',parentElement:hiddenParent,style:{display:'inline'},getBoundingClientRect:()=>({bottom:800,width:100,height:20})}
  const zeroRect={tagName:'DIV',parentElement:null,style:{display:'block'},getBoundingClientRect:()=>({bottom:0,width:0,height:0})}
  const svgPaths=Array.from({length:500},()=>({tagName:'path',namespaceURI:'http://www.w3.org/2000/svg',parentElement:null,style:{},getBoundingClientRect:()=>({bottom:999,width:10,height:10})}))
  const fillerDivs=Array.from({length:450},()=>({tagName:'DIV',parentElement:null,style:{display:'block'},getBoundingClientRect:()=>({bottom:100,width:100,height:20})}))
  const deepTail={tagName:'DIV',parentElement:null,style:{display:'block'},getBoundingClientRect:()=>({bottom:420,width:100,height:20})}
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:900,clientWidth:640},
    body:{offsetHeight:120,scrollHeight:120,querySelectorAll:()=>[fixedOverlay,hiddenParent,hiddenChild,zeroRect,...svgPaths,...fillerDivs,deepTail]}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,
    getComputedStyle:(node:{style?:unknown})=>node.style??{},clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  expect(postMessage.mock.calls.map(([m])=>m).filter(m=>m.action==='resize').map(m=>m.height)).toEqual([420])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** Web 字体延迟加载可能改变文本换行与卡片总高；fonts.ready 与 loadingdone 均应触发重测，清理时退订且不再上报。 */
it('Web 字体加载完成触发高度重测，并在清理时退订 loadingdone 监听', async () => {
  const callbacks=new Map<string,()=>void>(),fontListeners=new Map<string,()=>void>()
  const postMessage=vi.fn(),frames=animationFrames()
  let height=180
  const fontsReady=Promise.withResolvers<void>()
  const removeFontListener=vi.fn((name:string)=>{ fontListeners.delete(name) })
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:{clientHeight:height,clientWidth:640},
    body:{get offsetHeight(){return height},get scrollHeight(){return height},querySelectorAll:()=>[]},
    fonts:{ready:fontsReady.promise,addEventListener:(name:string,fn:()=>void)=>fontListeners.set(name,fn),removeEventListener:removeFontListener}}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},TextEncoder,
    getComputedStyle:()=>({}),clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  const resizes=()=>postMessage.mock.calls.map(([m])=>m).filter(m=>m.action==='resize').map(m=>m.height)
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  expect(resizes()).toEqual([180])

  // 字体异步加载导致卡片增高，loadingdone 立即重测。
  height=240
  fontListeners.get('loadingdone')?.();frames.flush()
  expect(resizes()).toEqual([180,240])

  // fonts.ready 兑现再次触发重测。
  height=272
  fontsReady.resolve()
  await Promise.resolve();await Promise.resolve()
  frames.flush()
  expect(resizes()).toEqual([180,240,272])

  runInContext('window.__dshTavernBridgeCleanup()',context)
  expect(removeFontListener).toHaveBeenCalledWith('loadingdone', expect.any(Function))
})

/** 含可见子节点的 100vh 卡片在收起时，即使视口仍停留在旧展开高度，也应立即按实际子节点回缩。 */
it('body 设为 min-height: 100vh 时按真实子节点测量高度，收起无需等待视口先缩小', () => {
  const callbacks=new Map<string,()=>void>(),postMessage=vi.fn(),frames=animationFrames()
  let mutation:()=>void=()=>{}
  class MutationObserver {constructor(cb:()=>void){mutation=cb}observe=vi.fn();disconnect=vi.fn()}
  let clientHeight=280,panelBottom=180
  const panel={tagName:'DIV',parentElement:null,style:{display:'block',marginBottom:'0px'},getBoundingClientRect:()=>({bottom:panelBottom,width:600,height:panelBottom})}
  const root={get clientHeight(){return clientHeight},clientWidth:640}
  const body={
    get offsetHeight(){return Math.max(panelBottom+20,clientHeight)},
    get scrollHeight(){return Math.max(panelBottom+20,clientHeight)},
    getBoundingClientRect:()=>({bottom:Math.max(panelBottom+20,clientHeight),width:624,height:Math.max(panelBottom+20,clientHeight)}),
    querySelectorAll:()=>[panel],
  }
  const document={open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null,
    readyState:'loading',addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    documentElement:root,body}
  const window={addEventListener:(name:string,fn:()=>void)=>callbacks.set(name,fn),removeEventListener:vi.fn(),
    requestAnimationFrame:frames.requestAnimationFrame,cancelAnimationFrame:frames.cancelAnimationFrame}
  const context=createContext({crypto:webcrypto,window,document,parent:{postMessage},MutationObserver,TextEncoder,
    getComputedStyle:(node:unknown)=>node===body?{minHeight:`${clientHeight}px`,paddingBottom:'12px',marginBottom:'8px'}:(node as {style?:unknown})?.style??{},
    clearTimeout:vi.fn(),setTimeout:vi.fn()})
  runInContext(tavernCardBridgeScript({greetings:[],greetingIndex:0}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''),context)
  const resizes=()=>postMessage.mock.calls.map(([m])=>m).filter(m=>m.action==='resize').map(m=>m.height)

  // 首次渲染：clientHeight=280 但子节点只有 180 + pad(12) + margin(8) = 200。
  callbacks.get('DOMContentLoaded')?.();frames.flush()
  expect(resizes()).toEqual([200])

  // 展开面板到 520，宿主随后拉高视口到 540。
  panelBottom=520;mutation();frames.flush()
  clientHeight=540
  expect(resizes()).toEqual([200,540])

  // 面板收起到 120，而宿主 iframe 视口仍停留在 540：应立即回缩到 140 而非卡死在 540。
  panelBottom=120;mutation();frames.flush()
  expect(resizes()).toEqual([200,540,140])
  runInContext('window.__dshTavernBridgeCleanup()',context)
})

/** 视口缩窄（如桌面 1440px -> 手机 390px）导致正文折行增高时，window resize 应触发重测并上报新高度。 */
it('视口宽度缩窄折行时 window resize 立即上报增长后的内容高度，卸载时退订 resize', () => {
  const callbacks = new Map<string, () => void>(), postMessage = vi.fn(), frames = animationFrames()
  let clientWidth = 680, clientHeight = 340, wrappedHeight = 340
  const panel = {
    tagName: 'DIV', parentElement: null,
    style: { display: 'block', marginBottom: '0px' },
    getBoundingClientRect: () => ({ bottom: 340, width: clientWidth - 24, height: 340 }),
  }
  const root = {
    get clientWidth() { return clientWidth },
    get clientHeight() { return clientHeight },
    get scrollHeight() { return wrappedHeight },
  }
  const body = {
    get offsetHeight() { return clientHeight },
    get scrollHeight() { return wrappedHeight },
    getBoundingClientRect: () => ({ bottom: clientHeight, width: clientWidth, height: clientHeight }),
    querySelectorAll: () => [panel],
  }
  const document = {
    open: vi.fn(), write: vi.fn(), close: vi.fn(), currentScript: null, querySelector: () => null,
    readyState: 'loading', addEventListener: (name: string, fn: () => void) => callbacks.set('document:' + name, fn), removeEventListener: vi.fn(),
    documentElement: root, body,
  }
  const window = {
    addEventListener: (name: string, fn: () => void) => callbacks.set('window:' + name, fn), removeEventListener: vi.fn(),
    requestAnimationFrame: frames.requestAnimationFrame, cancelAnimationFrame: frames.cancelAnimationFrame,
  }
  const context = createContext({
    crypto: webcrypto, window, document, parent: { postMessage }, TextEncoder,
    getComputedStyle: (node: unknown) => node === body ? { height: `${clientHeight}px`, paddingBottom: '0px', marginBottom: '0px' } : (node as { style?: unknown })?.style ?? {},
    clearTimeout: vi.fn(), setTimeout: vi.fn(),
  })
  runInContext(tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), context)
  const resizes = () => postMessage.mock.calls.map(([m]) => m).filter(m => m.action === 'resize').map(m => m.height)

  // 初始桌面宽度：卡片高度 340，宿主随后将 iframe 固定到 340。
  callbacks.get('document:DOMContentLoaded')?.(); frames.flush()
  expect(resizes()).toEqual([340])

  // 缩窄到手机宽度 350px：即使增长幅度 <= 32px 且 body 计算高度曾等于旧 clientHeight，也不应被误判为 100vh 正反馈。
  clientWidth = 350; wrappedHeight = 368
  callbacks.get('window:resize')?.(); frames.flush()
  expect(resizes()).toEqual([340, 368])

  // 继续折行到 460px 时同样即时同步。
  clientHeight = 368; clientWidth = 320; wrappedHeight = 460
  callbacks.get('window:resize')?.(); frames.flush()
  expect(resizes()).toEqual([340, 368, 460])

  runInContext('window.__dshTavernBridgeCleanup()', context)
  expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
})

/** 长历史卡面内嵌快照：共享对象只序列化一次，默认页集合省略后在卡面代码运行前逐字段还原。 */
describe('卡面内嵌快照', () => {
  const page = (message: string, data: Record<string, unknown>) => ({ message, data, extra: {} })
  function factorySnapshot(): HelperSnapshot {
    const first = { stat_data: { 时间: '第1天' } }, second = { stat_data: { 时间: '第2天' } }
    return {
      storyId: 'story', historyRevision: 'revision', currentMessageId: 1, writable: true,
      scopes: { '["chat",""]': { 好感: 3 } },
      messages: [
        { message_id: 0, name: '灯塔', role: 'assistant', is_hidden: false, message: '开场白', data: first, extra: {},
          swipe: { active: 1, pages: [page('备选开场', {}), page('开场白', first)] } },
        { message_id: 1, name: '旅人', role: 'user', is_hidden: false, message: '你好', data: {}, extra: {}, swipe: { active: 0, pages: [page('你好', {})] } },
        { message_id: 2, name: '灯塔', role: 'assistant', is_hidden: false, message: '<b>欢迎</b> ', data: second, extra: { source: 'factory' },
          swipe: { active: 0, pages: [{ message: '<b>欢迎</b> ', data: second, extra: { source: 'factory' } }] } },
      ],
    }
  }
  /** 只执行桥脚本中的配置与还原段，得到卡面代码实际看到的快照。 */
  function embedded(snapshot: HelperSnapshot): { cfg: { helperSnapshot: HelperSnapshot }; script: string } {
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0, helperSnapshot: snapshot })
    const start = script.indexOf('var cfg = '), end = script.indexOf('// 先固定本次运行时')
    const cfg = runInContext(script.slice(start, end) + ';cfg', createContext({ JSON })) as { helperSnapshot: HelperSnapshot }
    return { cfg, script }
  }

  it('还原后与逐字段内嵌的旧快照完全相同，默认页的数据是独立副本', () => {
    const snapshot = factorySnapshot()
    const { cfg, script } = embedded(snapshot)
    expect(cfg.helperSnapshot).toEqual(JSON.parse(JSON.stringify(snapshot)))
    expect(Object.keys(cfg.helperSnapshot)).not.toContain('swipeDefaults')
    const restored = cfg.helperSnapshot.messages[2]!
    expect(restored.swipe!.pages[0]!.data).not.toBe(restored.data)
    restored.swipe!.pages[0]!.data.stat_data = '改写'
    expect(restored.data).toEqual({ stat_data: { 时间: '第2天' } })
    // 多页集合原样保留；默认页正文只内嵌一次，转义规则不变。
    expect(script.split('备选开场').length - 1).toBe(1)
    expect(script.split('\\u003cb>欢迎').length - 1).toBe(1)
    expect(script).not.toContain(' ')
  })

  it('批量展示共用 messages/scopes 时多个卡面只序列化一次，内容变化后重新序列化', () => {
    const snapshot = factorySnapshot()
    let serialized = 0
    Object.defineProperty(snapshot.scopes, 'toJSON', { enumerable: false, value() { serialized++; return { '["chat",""]': { 好感: 3 } } } })
    for (let id = 0; id < 3; id++) embedded({ ...snapshot, currentMessageId: id })
    expect(serialized).toBe(1)
    const { cfg } = embedded({ ...snapshot, currentMessageId: 2 })
    expect(cfg.helperSnapshot.currentMessageId).toBe(2)
    expect(serialized).toBe(1)
    expect(embedded({ ...snapshot, scopes: { '["chat",""]': { 好感: 9 } } }).cfg.helperSnapshot.scopes).toEqual({ '["chat",""]': { 好感: 9 } })
  })
})
