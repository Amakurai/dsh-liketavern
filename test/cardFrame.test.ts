/**
 * 交互卡 srcDoc：默认放行 https 图片/字体；注入 ST stub；解析 swipe 桥消息。
 */
import { describe, expect, it } from 'vitest'
import { buildCardSrcDoc, CARD_BRIDGE_SOURCE, parseCardBridgeMessage, tavernCardBridgeScript } from '../src/core/cardFrame.js'

describe('buildCardSrcDoc', () => {
  it('CSP 默认允许 https 图片与字体，connect-src 默认 none、script-src 仅内联', () => {
    const doc = buildCardSrcDoc('<html><head></head><body>hi</body></html>', { greetings: ['cover'], greetingIndex: 0 })
    expect(doc).toContain("img-src https: http: data: blob:")
    expect(doc).toContain("font-src https: http: data:")
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain("script-src 'unsafe-inline';")
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
    expect(doc).toContain("script-src 'unsafe-inline' https://example.com")
  })

  it('白名单 * = 全部放行 https/http', () => {
    const doc = buildCardSrcDoc('<html><head></head><body></body></html>', {
      greetings: [],
      greetingIndex: 0,
      connectHosts: ['*'],
    })
    expect(doc).toContain('connect-src https: http:')
    expect(doc).toContain("script-src 'unsafe-inline' https: http:")
  })
})

describe('tavernCardBridgeScript', () => {
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
