/**
 * 非安全上下文（局域网 http 打开宿主）回退：crypto.randomUUID / crypto.subtle 不存在时，
 * 主页面 ID 与 MVU 回执摘要、卡面 iframe 桥接都必须照常工作。对照 flizzywine/dsh-tavern #41。
 */
import { createHash, webcrypto } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
import { randomUuid, sha256Hex, sha256HexSync } from '../src/core/secureRandom.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const insecureCrypto = { getRandomValues: <T extends ArrayBufferView>(array: T) => webcrypto.getRandomValues(array as never) as T }

afterEach(() => { vi.unstubAllGlobals() })

describe('纯 JS SHA-256', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'b'.repeat(1000), '中文角色卡「变量」🎲'])('与 Node createHash 一致：%#', text => {
    expect(sha256HexSync(new TextEncoder().encode(text))).toBe(createHash('sha256').update(text).digest('hex'))
  })

  it('缺 crypto.subtle 时 sha256Hex 回退纯 JS，结果与服务端回执口径相同', async () => {
    vi.stubGlobal('crypto', insecureCrypto)
    const text = JSON.stringify({ stat_data: { 好感: 3 } })
    expect(await sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
  })
})

describe('randomUuid', () => {
  it('缺 crypto.randomUUID 时用 getRandomValues 生成合法且不重复的 v4 UUID', () => {
    vi.stubGlobal('crypto', insecureCrypto)
    const ids = new Set(Array.from({ length: 200 }, () => randomUuid()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})

it('卡面桥在没有 randomUUID 的 iframe 里也能安装，并给卡片脚本补上 crypto.randomUUID', () => {
  const crypto = { ...insecureCrypto }
  const document = { readyState: 'loading', body: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    open: vi.fn(), write: vi.fn(), close: vi.fn(), currentScript: null, querySelector: () => null }
  const scope: Record<string, unknown> = { document, TextEncoder, crypto, setTimeout, clearTimeout, queueMicrotask,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), parent: { postMessage: vi.fn() } }
  scope.window = scope
  const context = createContext(scope)
  const source = tavernCardBridgeScript({ greetings: ['A'], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
  expect(() => runInContext(source, context)).not.toThrow()
  expect(runInContext('crypto.randomUUID()', context)).toMatch(UUID_V4)
})
