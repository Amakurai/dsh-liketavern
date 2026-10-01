/** 工具拒绝展示预算的纯函数回归：完整 JSON 包装与转义计费，短错误不改结构，截断不创建伪定位字段。 */
import { expect, it } from 'vitest'
import { boundedToolError } from '../src/core/toolErrorBudget.js'
import { assetOutputTokens } from '../src/core/assetRead.js'

it('正常短错误保留原结构与完整原因', () => {
  const error = 'not-found：记忆 m-known 不存在'
  expect(boundedToolError(error)).toEqual({ ok: false, error })
})

it('巨型 CJK 错误展示明确截断，完整响应与自身计数仍在 3000 内', () => {
  const error = `not-found：记忆 ${'界'.repeat(5000)} 不存在`, output = boundedToolError(error)
  expect(output).toMatchObject({ ok: false, errorTruncated: true })
  expect(output.error).toContain('not-found')
  expect(output.error).toContain('已截断')
  expect(output.tokensUsed).toBe(assetOutputTokens(output))
  expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
  expect(output).not.toHaveProperty('id')
  expect(error).toContain('界'.repeat(5000))
})

it('控制字符、引号和反斜杠按序列化后成本裁剪', () => {
  const output = boundedToolError(`invalid-args：expiresAt=${'\u0000"\\\n'.repeat(4000)} 不是 ISO 时间`)
  expect(output.errorTruncated).toBe(true)
  expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
  expect(output.tokensUsed).toBe(assetOutputTokens(output))
})

it('能整体容纳的长错误保持完整，只有 JSON 包装真的超额才裁剪', () => {
  const fitting = 'x'.repeat(11000), overflowing = 'x'.repeat(12000)
  expect(boundedToolError(fitting)).toEqual({ ok: false, error: fitting })
  expect(boundedToolError(overflowing).errorTruncated).toBe(true)
  expect(assetOutputTokens(boundedToolError(overflowing))).toBeLessThanOrEqual(3000)
})

it('截断 emoji 也不留下半个代理对，结果可无损往返 JSON', () => {
  const output = boundedToolError(`invalid-args：${'🗝️'.repeat(10000)}`)
  expect(output.error).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  expect(assetOutputTokens(output)).toBeLessThanOrEqual(3000)
})
