/**
 * 回归护栏：渲染包装走独立求值路径后，仍必须失效“该阶段没有临时正则”的宿主缓存。
 * 否则模板在渲染中 activateRegex 之后，宿主会继续按旧结论跳过正则（本次修复曾踩到）。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { TemplateSandbox } from '../../src/node/templateSandbox.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})

it('渲染中激活的 generate 正则不会被旧的“阶段为空”缓存跳过', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const probe = sandbox as unknown as { hasRegexStage:(stage:string)=>boolean }
    // 先查询一次：此时确实没有规则，宿主侧缓存结论为“空”。
    expect(probe.hasRegexStage('generate')).toBe(false)
    sandbox.render(`<% activateRegex(/P[I]NG/g,'old',{uuid:'audit-generate',generate:true}) %>`)
    // 渲染执行了第三方代码，必须让旧结论失效。
    expect(probe.hasRegexStage('generate')).toBe(true)
  } finally { sandbox.dispose() }
}, 30_000)
