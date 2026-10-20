/**
 * 审计回归（C1 修复后）：灾难性回溯静态闸必须识别非捕获组 / 命名组写法。
 * 对照：捕获组的同一构造在修复前就会被拒绝；`(?:a|a)+$` 在修复前放行并指数回溯
 * （审计报告里已用隔离子进程实测 SIGTERM），修复后必须在编译前被拒。
 */
import { expect, it } from 'vitest'
import { applyRegexRules, findUnsafeRegexConstruct } from '../../src/core/regex.js'
import type { RegexRule } from '../../src/core/types.js'

it('捕获组、非捕获组、命名组的交叠分支都被拒绝', () => {
  for (const source of ['(a|a)+', '(a|aa)+', '(?:a|a)+', '(?:a|aa)+', '(?<n>a|a)+']) {
    expect(findUnsafeRegexConstruct(source), source).not.toBeNull()
  }
})

it('嵌套量词与合法 pattern 的口径不变', () => {
  expect(findUnsafeRegexConstruct('(?:a+)+')).not.toBeNull()
  expect(findUnsafeRegexConstruct('(?:cat|c)+')).not.toBeNull() // 保守误伤面保留
  expect(findUnsafeRegexConstruct('(?:cat|dog)+')).toBeNull()
  expect(findUnsafeRegexConstruct('^[a-z]{1,3}$')).toBeNull()
  expect(findUnsafeRegexConstruct('(?<word>[A-Za-z]+)')).toBeNull()
})

it('灾难构造现在被 applyRegexRules 拒绝并记 error，不再挂死主线程', () => {
  const rule = (find: string): RegexRule => ({
    id: 'r', name: 'r', find, replace: 'x', enabled: true, scopes: ['output'], timing: ['render'],
    minDepth: null, maxDepth: null, substituteRegex: 0, source: 'card',
  })
  const text = `${'a'.repeat(40)}!`
  const result = applyRegexRules(text, [rule('/(?:a|a)+$/g')], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' })
  expect(result.errors.map((error) => error.ruleId)).toEqual(['r'])
  expect(result.errors[0]?.message).toContain('灾难性回溯')
  expect(result.text).toBe(text)

  // 对照：不含灾难构造的同类规则照常生效
  const ok = applyRegexRules('<axb>', [rule('/<(.+?)>/g')], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' })
  expect(ok.errors).toEqual([])
  expect(ok.applied).toEqual(['r'])
})
