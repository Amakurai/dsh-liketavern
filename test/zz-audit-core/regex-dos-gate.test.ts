/**
 * 审计回归（C1 修复后）：灾难性回溯静态闸必须识别非捕获组 / 命名组写法。
 * 对照：捕获组的同一构造在修复前就会被拒绝；`(?:a|a)+$` 在修复前放行并指数回溯
 * （审计报告里已用隔离子进程实测 SIGTERM），修复后必须在编译前被拒。
 */
import { expect, it } from 'vitest'
import { applyRegexRules, compileRegexScripts, findUnsafeRegexConstruct } from '../../src/core/regex.js'
import { isolated } from '../../src/node/isolated.js'
import type { RegexRule } from '../../src/core/types.js'

it('捕获组、非捕获组、命名组的交叠分支都被拒绝', () => {
  for (const source of ['(a|a)+', '(a|aa)+', '(?:a|a)+', '(?:a|aa)+', '(?<n>a|a)+']) {
    expect(findUnsafeRegexConstruct(source), source).not.toBeNull()
  }
})

it('嵌套量词与合法 pattern 的口径不变', () => {
  expect(findUnsafeRegexConstruct('(?:a+)+')).not.toBeNull()
  // 仅前缀相同的分支每次迭代边界唯一，线性匹配，不再误伤。
  expect(findUnsafeRegexConstruct('(?:cat|c)+')).toBeNull()
  expect(findUnsafeRegexConstruct('(?:cat|dog)+')).toBeNull()
  expect(findUnsafeRegexConstruct('^[a-z]{1,3}$')).toBeNull()
  expect(findUnsafeRegexConstruct('(?<word>[A-Za-z]+)')).toBeNull()
})

it('仍拒绝可在迭代间切分的教科书构造', () => {
  for (const source of ['(\\w+\\s*)*$', '(\\d+,?)+$', '(\\s*\\w+)+$', '(.*)+$', '((?:<br>)+)+', '(a|b|ab)+$',
    '(x+x*){2,}', '(?<n>\\w+\\s?)+$', '(\\u0041+)+$', '([^<]*)*<']) {
    expect(findUnsafeRegexConstruct(source), source).not.toBeNull()
  }
})

it('迭代边界由必需内容固定的常见展示正则不再被拒', () => {
  for (const source of ['(<br>\\s*)+', '(\\s*\\n)+', '(\\n\\s*){2,}', '(<p>.*?<\\/p>)+', '((?:<br\\s*\\/?>\\s*)+)',
    '([^\\n]*\\n)+', '(\\w+\\s+)+', '(?:cat|c)+', '(a+)?b', '(a+){1}', '(?=(?:ab)+)', '(\\s|\\n)+', '([a-z]|a)+']) {
    expect(findUnsafeRegexConstruct(source), source).toBeNull()
  }
})

it('放行后真遇病态输入时由 worker 期限终止，下一任务照常', async () => {
  const rules = compileRegexScripts([{ id: 'lines', scriptName: 'lines', findRegex: '/(\\s*\\n)+x/g', replaceString: '', placement: [2], disabled: false }],
    { source: 'card', sourceRef: 'factory' })
  const macroCtx = { char: 'A', user: 'B' }
  await expect(isolated('render', { text: `${'\n'.repeat(40)}y`, rules, macroCtx }, 300)).rejects.toThrow(/超时/)
  const normal = await isolated('render', { text: '甲\n\nx乙', rules, macroCtx })
  expect(normal.errors).toEqual([])
  expect(normal.text).toBe('甲乙')
}, 15_000)

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
