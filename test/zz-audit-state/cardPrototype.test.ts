/**
 * S7 回归：角色卡导入镜像的扩展字段不能被 `__proto__` 这类键丢字段或改写原型。
 *
 * 修复前：`extensions[key] = value` 裸赋值遇到 JSON.parse 出来的自有 `__proto__` 键会触发
 * 原型 setter——字段静默丢失，extensions 的原型还被替换成外来对象。
 * 修复后：污染键用 defineProperty 落成自有数据属性（与 core/characterData.ts 同口径）。
 */
import { describe, expect, it } from 'vitest'
import { cardToStJson, parseJsonCard } from '../../src/state/card.js'

/** JSON.parse 才会产生自有 __proto__ 属性；对象字面量会把它当原型语法。 */
const pollutedJson = () => JSON.parse(`{
  "spec": "chara_card_v2",
  "data": {
    "name": "污染卡",
    "description": "d",
    "__proto__": { "pollutedFromData": true },
    "extensions": {
      "__proto__": { "pollutedFromExtensions": true },
      "constructor": { "pollutedFromConstructor": true },
      "custom": 1
    }
  }
}`) as Record<string, unknown>

describe('角色卡扩展字段污染守卫', () => {
  it('__proto__/constructor 落成自有数据属性，字段不丢且原型不被替换', () => {
    const card = parseJsonCard(pollutedJson())
    const extensions = card.extensions as Record<string, unknown>

    expect(Object.hasOwn(extensions, '__proto__')).toBe(true)
    expect(Object.hasOwn(extensions, 'constructor')).toBe(true)
    expect(Object.getPrototypeOf(extensions)).toBe(Object.prototype)
    // data 顶层的自有 __proto__ 与 data.extensions.__proto__ 同键：按原实现顺序后者被覆盖。
    expect((extensions as { __proto__?: unknown }).__proto__).toEqual({ pollutedFromData: true })
    expect((extensions as { constructor?: unknown }).constructor).toEqual({ pollutedFromConstructor: true })
    expect(extensions.custom).toBe(1)
    expect(({} as { pollutedFromData?: unknown }).pollutedFromData).toBeUndefined()
    expect(({} as { pollutedFromExtensions?: unknown }).pollutedFromExtensions).toBeUndefined()
  })

  it('导出/再导入保留污染键字段，不破坏原型', () => {
    const card = parseJsonCard(pollutedJson())
    const exported = cardToStJson(card) as { data: { extensions: Record<string, unknown> } }
    expect(Object.hasOwn(exported.data.extensions, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(exported.data.extensions)).toBe(Object.prototype)
    const again = parseJsonCard(JSON.parse(JSON.stringify(exported)) as unknown)
    expect(Object.hasOwn(again.extensions, '__proto__')).toBe(true)
    expect((again.extensions as { __proto__?: unknown }).__proto__).toEqual({ pollutedFromData: true })
  })
})
