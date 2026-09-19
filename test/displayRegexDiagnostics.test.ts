/** 展示正则诊断：真实隔离 worker 中失败规则可见、成功规则继续生效，逐片去重且返回体严格有界。 */
import { describe, expect, it } from 'vitest'
import type { RegexRule } from '../src/core/types.js'
import { isolated } from '../src/node/isolated.js'
import { collectDisplayRegexDiagnostics } from '../src/node/templateDisplay.js'

const macroCtx = { char: '角色', user: '用户', outlets: {} }
const rule = (patch: Partial<RegexRule> = {}): RegexRule => ({
  id: 'replace', name: '正常显示', enabled: true, find: '/原文/g', replace: '展示成功',
  scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'card', ...patch,
})

describe('展示正则错误诊断', () => {
  it('逐片执行保留成功规则和 HTML 顺序，失败规则按原始身份去重并附上名称', async () => {
    const rules = [
      rule({ id: 'broken', name: '卡面格式', find: '[' }),
      rule(),
      rule({ id: 'unsafe', name: '嵌套量词', find: '(a+)+$' }),
      rule({ id: 'disabled', name: '已关闭', find: '[', enabled: false }),
      rule({ id: 'prompt', name: '仅入模', find: '[', scopes: ['prompt'] }),
    ]
    const result = await isolated('display', { parts: [
      { kind: 'markdown', text: '前原文' },
      { kind: 'html', text: '<div>原文</div>', title: '状态栏' },
      { kind: 'markdown', text: '后原文' },
    ], rules, macroCtx })
    expect(result.parts).toEqual([
      { kind: 'markdown', text: '前展示成功' },
      { kind: 'html', text: '<div>展示成功</div>', title: '状态栏' },
      { kind: 'markdown', text: '后展示成功' },
    ])
    expect(result.regexDiagnostics?.total).toBe(2)
    expect(result.regexDiagnostics?.errors).toEqual([
      { ruleId: 'broken', ruleName: '卡面格式', message: expect.any(String) },
      { ruleId: 'unsafe', ruleName: '嵌套量词', message: expect.any(String) },
    ])
    expect(result.regexDiagnostics?.errors.every(error => error.message.length > 0)).toBe(true)
  })

  it('普通正文与片段展示使用同一诊断形状，成功时不附加诊断字段', async () => {
    const rules = [rule({ id: 'broken', name: '前端外观', find: '[' }), rule()]
    const result = await isolated('render', { text: '原文', rules, macroCtx })
    expect(result.text).toBe('展示成功')
    expect(collectDisplayRegexDiagnostics(result.errors, rules)).toEqual({ total: 1,
      errors: [{ ruleId: 'broken', ruleName: '前端外观', message: expect.any(String) }] })
    const success = await isolated('display', { parts: [{ kind: 'markdown', text: '原文' }], rules: [rule()], macroCtx })
    expect(success).toEqual({ parts: [{ kind: 'markdown', text: '展示成功' }] })
    expect(collectDisplayRegexDiagnostics([], rules)).toBeUndefined()
  })

  it('诊断最多 64 条且字段限长，实际错误条数保留并在截断字段前去重', async () => {
    const rules = Array.from({ length: 70 }, (_, index) => rule({
      id: 'i'.repeat(300) + index, name: '名'.repeat(300), find: 'a'.repeat(1999) + '[',
    }))
    const result = await isolated('display', { parts: [
      { kind: 'markdown', text: '第一段' }, { kind: 'html', text: '<div>第二段</div>' }, { kind: 'markdown', text: '第三段' },
    ], rules, macroCtx })
    expect(result.regexDiagnostics?.total).toBe(70)
    expect(result.regexDiagnostics?.errors).toHaveLength(64)
    for (const error of result.regexDiagnostics!.errors) {
      expect(error.ruleId).toHaveLength(256)
      expect(error.ruleName).toHaveLength(256)
      expect(error.message).toHaveLength(2000)
    }
    expect(result.parts).toHaveLength(3)
  })

  it('同一规则身份的不同失败原因都保留，不因跨片重复而增加计数', async () => {
    const result = await isolated('display', { parts: [{ kind: 'markdown', text: '一' }, { kind: 'markdown', text: '二' }],
      rules: [rule({ id: 'shared', name: '重复身份', find: '[' }), rule({ id: 'shared', find: '(' })], macroCtx })
    expect(result.regexDiagnostics?.total).toBe(2)
    expect(result.regexDiagnostics?.errors.map(error => error.ruleId)).toEqual(['shared', 'shared'])
    expect(new Set(result.regexDiagnostics?.errors.map(error => error.message)).size).toBe(2)
  })
})
