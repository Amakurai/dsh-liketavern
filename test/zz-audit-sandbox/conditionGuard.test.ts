/**
 * A1 修复验证：@@if 只读守卫不再依赖模板可命名的 __conditionState。
 * 宿主侧直接读取内部绑定并在主线程比较，模板替换同名全局也无法伪造“状态未变”；
 * 命令入口同时被 defineProperty 冻结（不可写、不可配置）。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { TemplateSandbox } from '../../src/node/templateSandbox.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})

it('A1：@@if 条件写变量会被拒绝，替换 __conditionState 也无效', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    // 真正的只读条件照常通过（不能出现误报）。
    expect(sandbox.condition(`getvar('missing')===undefined`)).toBe(true)
    expect(sandbox.condition(`1+1===2`)).toBe(true)

    // 旧绕过：先抓真实状态，写变量，再把全局替换成返回旧状态的桩。
    const forged = `1) %><% const _s=__conditionState(); setvar('pwn',1); globalThis.__conditionState=()=>_s; %><% Boolean(1`
    expect(() => sandbox.condition(forged)).toThrow(/只读/)
    expect(sandbox.variables().message.pwn).toBe(1)

    // 直接替换命令入口（冻结后严格模式抛错、宽松模式静默失败）同样不能掩盖写入。
    const replace = `1) %><% globalThis.__conditionState=()=>'{}'; setvar('pwn2',1); %><% Boolean(1`
    expect(() => sandbox.condition(replace)).toThrow(/只读|Cannot assign|read only|readonly|不可写|EJS 模板失败/)
    expect(sandbox.variables().message.pwn2).toBe(1)
  } finally { sandbox.dispose() }
}, 30_000)

it('A1：变量对象挂 toJSON 冻结快照也不能掩盖 @@if 写入', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const forged = `1) %><% variables.toJSON=()=>({}); setvar('pwn3',1); %><% Boolean(1`
    expect(() => sandbox.condition(forged)).toThrow(/只读|toJSON/)
  } finally { sandbox.dispose() }
}, 30_000)
