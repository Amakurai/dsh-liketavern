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
    expect(window.removeEventListener).toHaveBeenCalledTimes(2)
  })
  it('把开场白变体编进脚本，避免 </script> 打断', () => {
    const script = tavernCardBridgeScript({ greetings: ['cover</script>', 'alt-greeting'], greetingIndex: 0 })
    expect(script).toContain('\\u003c')
    expect(script).toContain('alt-greeting')
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
