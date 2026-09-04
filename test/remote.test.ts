/**
 * remote 契约（src/remote.ts）覆盖点：
 * - 描述符形态：三处同步的方法集齐全、id/service/namespace/method 与 codec 模式正确。
 * - zod/mini 迁移守卫：每个参数 codec 的 schema 必须有可调用的 `.parse`
 *   （gateway 两面都只用这一个方法：client 侧 parseInput、host 侧 decode）。
 * - 校验语义与迁移前一致：非空串、正整数 turn、可选字段缺省放行、枚举与数组类型拒绝错值。
 * - host / client 两份贡献共享同一批描述符实例。
 */
import { describe, expect, it } from 'vitest'
import { TYPERT_HOST, TYPERT_REMOTE } from '../src/remote.js'

interface Codec {
  mode: string
  typeSymbol: string
  schema: { parse(value: unknown): unknown }
}
interface Descriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: string }
  parameters: Array<{ name: string; wire: string; source: string; codec: Codec }>
  result: { mode: string; typeSymbol: string; schema: { parse(value: unknown): unknown } }
}

const descriptors = TYPERT_REMOTE.descriptors as unknown as Descriptor[]
const byMethod = new Map(descriptors.map((d) => [d.method, d]))

function requestCodec(method: string): Codec {
  const descriptor = byMethod.get(method)
  expect(descriptor, `缺少 remote 方法 ${method}`).toBeDefined()
  const parameter = descriptor!.parameters[0]!
  expect(parameter.wire).toBe('request')
  return parameter.codec
}

describe('remote 契约描述符', () => {
  it('每个方法都是 direct 调用 + 单个 request 参数 + strict codec', () => {
    expect(descriptors.length).toBeGreaterThan(50)
    for (const d of descriptors) {
      expect(d.id).toBe(`dsh-liketavern#tavern/${d.method}`)
      expect(d.service).toBe('tavern')
      expect(d.namespace).toBe('tavern')
      expect(d.invocation.kind).toBe('direct')
      expect(d.parameters).toHaveLength(1)
      expect(d.parameters[0]!.codec.mode).toBe('strict')
      expect(d.result.mode).toBe('strict')
    }
  })

  it('host 与 client 两份贡献共享同一批描述符', () => {
    expect(TYPERT_HOST.invocations).toBe(TYPERT_REMOTE.descriptors)
    expect(TYPERT_HOST.package).toBe('dsh-liketavern')
    expect(TYPERT_HOST.face).toBe('host')
  })

  it('model 里每个 service 成员都对应一个描述符', () => {
    const members = TYPERT_HOST.model.services[0]!.members.map((m) => m.name)
    expect(new Set(members)).toEqual(new Set(descriptors.map((d) => d.method)))
    for (const m of TYPERT_HOST.model.services[0]!.members) {
      expect(m.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('请求 schema 校验（gateway 只调用 .parse）', () => {
  it('每个方法的 request schema 都暴露可调用的 parse', () => {
    for (const d of descriptors) {
      expect(typeof d.parameters[0]!.codec.schema.parse, d.method).toBe('function')
      expect(typeof d.result.schema.parse, d.method).toBe('function')
    }
  })

  it('sessionId / cardId / messageId 必须非空', () => {
    const codec = requestCodec('getFloorUserMessage')
    expect(codec.schema.parse({ sessionId: 's1', messageId: 'm1' })).toEqual({ sessionId: 's1', messageId: 'm1' })
    expect(() => codec.schema.parse({ sessionId: '', messageId: 'm1' })).toThrow()
    expect(() => codec.schema.parse({ sessionId: 's1', messageId: '' })).toThrow()
    expect(() => codec.schema.parse({ sessionId: 's1' })).toThrow()
  })

  it('楼层 turn 是可选正整数，messageId 也可缺省', () => {
    const codec = requestCodec('regenerate')
    expect(codec.schema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(codec.schema.parse({ sessionId: 's1', turn: 3 })).toEqual({ sessionId: 's1', turn: 3 })
    expect(() => codec.schema.parse({ sessionId: 's1', turn: 0 })).toThrow()
    expect(() => codec.schema.parse({ sessionId: 's1', turn: 1.5 })).toThrow()
  })

  it('可选字段缺省放行、类型错误拒绝（saveCharacter 的 depthPrompt 可空）', () => {
    const codec = requestCodec('saveCharacter')
    expect(codec.schema.parse({ cardId: 'c1' })).toEqual({ cardId: 'c1' })
    expect(codec.schema.parse({ cardId: 'c1', depthPrompt: null })).toEqual({ cardId: 'c1', depthPrompt: null })
    expect(
      codec.schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'system' }, tags: ['a'] }),
    ).toEqual({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'system' }, tags: ['a'] })
    expect(() => codec.schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'bogus' } })).toThrow()
    expect(() => codec.schema.parse({ cardId: 'c1', tags: 'a' })).toThrow()
  })

  it('枚举字段只接受公布的取值（addWorldDelta.type）', () => {
    const codec = requestCodec('addWorldDelta')
    expect(codec.schema.parse({ cardId: 'c1', type: 'update', content: 'x' })).toMatchObject({ type: 'update' })
    expect(() => codec.schema.parse({ cardId: 'c1', type: 'remove', content: 'x' })).toThrow()
    expect(() => codec.schema.parse({ cardId: 'c1', type: 'add', content: '' })).toThrow()
  })

  it('宽松资产字段（json/preset/binding）放行任意 JSON', () => {
    const codec = requestCodec('saveLorebook')
    expect(codec.schema.parse({ name: 'book', json: { entries: { 0: { key: ['k'] } } } })).toBeTruthy()
    expect(codec.schema.parse({ name: 'book', json: null })).toBeTruthy()
  })

  it('getFloorSiblings 的结果 schema 校验 swipe 形状', () => {
    const schema = byMethod.get('getFloorSiblings')!.result.schema
    expect(schema.parse({ swipe: null })).toEqual({ swipe: null })
    expect(schema.parse({ swipe: { turn: 2, index: 0, total: 3, siblings: ['a', 'b', 'c'] } })).toBeTruthy()
    expect(() => schema.parse({ swipe: { turn: 2, index: 0, total: 3 } })).toThrow()
  })
})
