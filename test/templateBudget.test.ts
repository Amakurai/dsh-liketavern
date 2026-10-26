/** 模板预算计量回归：不复制整包 JSON，保留转义/缺省语义，并按输入线性分配有界执行资源。 */
import { describe, expect, it } from 'vitest'
import { measureTemplateJson, templateExecutionBudget, TEMPLATE_INPUT_MAX_CHARS, TEMPLATE_OUTPUT_MAX_CHARS } from '../src/core/templateBudget.js'

describe('模板 JSON 计量', () => {
  it('与真实 JSON 对 Unicode、转义、数组空项、日期和共享对象的编码一致', () => {
    const common = { text: '角色\n"\\\u0000\b\t\r\f😀\ud800末\udc00', value: -0 }
    const value = { common, again: common, number: [NaN, Infinity, 1e30], date: new Date('2026-10-12T01:02:03.456Z'),
      invalidDate: new Date(NaN), list: [undefined, , () => 1, Symbol('ignored')], omitted: undefined }
    expect(measureTemplateJson(value)).toBe(JSON.stringify(value).length)
    expect(measureTemplateJson(value, JSON.stringify(value).length)).toBe(JSON.stringify(value).length)
    expect(() => measureTemplateJson(value, JSON.stringify(value).length - 1)).toThrow(/容量/)
  })

  it('超量提前停止，拒绝循环和自定义序列化而不执行其代码', () => {
    let invoked = false
    expect(() => measureTemplateJson({ toJSON() { invoked = true; return null } })).toThrow(/toJSON/)
    expect(invoked).toBe(false)
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic
    expect(() => measureTemplateJson(cyclic)).toThrow(/循环/)
    expect(() => measureTemplateJson('x'.repeat(100), 20)).toThrow(/容量/)
    expect(() => measureTemplateJson({ integer: 1n })).toThrow(/BigInt/)
  })
})

it('小输入取档位基础预算，长输入获得资源而所有默认预算仍封顶，显式期限不被放宽', () => {
  const small = templateExecutionBudget(1024), large = templateExecutionBudget(4 * 1024 * 1024), maximum = templateExecutionBudget(TEMPLATE_INPUT_MAX_CHARS)
  // 第三方 EJS 在 QuickJS 中解释执行，需要容下整轮渲染；纯 V8 展示正则保留短期限以尽快释放槽位。
  expect(small.computingMs).toBe(5000)
  expect(small.sandboxMs).toBe(4000)
  const display = templateExecutionBudget(1024, undefined, 'display')
  expect(display.computingMs).toBe(1000)
  expect(display.sandboxMs).toBe(750)
  expect(templateExecutionBudget(4 * 1024 * 1024, undefined, 'display').computingMs).toBeGreaterThan(display.computingMs)
  expect(templateExecutionBudget(TEMPLATE_INPUT_MAX_CHARS, undefined, 'display').computingMs).toBeLessThanOrEqual(30_000)
  expect(small.quickJsMemoryBytes).toBe(32 * 1024 * 1024)
  expect(small.workerMemoryMb).toBe(128)
  expect(large.computingMs).toBeGreaterThan(small.computingMs)
  expect(large.quickJsMemoryBytes).toBeGreaterThan(small.quickJsMemoryBytes)
  expect(large.outputChars).toBeGreaterThan(16 * 1024 * 1024)
  expect(maximum.computingMs).toBeLessThanOrEqual(30_000)
  expect(maximum.sandboxMs).toBeLessThanOrEqual(15_000)
  expect(maximum.workerMemoryMb).toBeLessThanOrEqual(1536)
  expect(maximum.quickJsMemoryBytes).toBeLessThanOrEqual(512 * 1024 * 1024)
  expect(maximum.outputChars).toBeLessThanOrEqual(TEMPLATE_OUTPUT_MAX_CHARS)
  expect(templateExecutionBudget(TEMPLATE_INPUT_MAX_CHARS, 80).computingMs).toBe(80)
  expect(() => templateExecutionBudget(TEMPLATE_INPUT_MAX_CHARS + 1)).toThrow(/容量/)
})
