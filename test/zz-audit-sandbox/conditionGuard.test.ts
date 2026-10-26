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

// 伪造的 toJSON 精确返回写入前的序列化：快照比较本身看不出差异，只能靠 toJSON 检查拦下。
const replayBefore = `const snap=JSON.parse(JSON.stringify({scopes,variables})); setvar('pwn',1);`

it('A1：toJSON 返回写入前快照时由 toJSON 检查拒绝，而非静默通过', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const own = `1) %><% ${replayBefore} scopes.toJSON=()=>snap.scopes; variables.toJSON=()=>snap.variables; %><% Boolean(1`
    expect(() => sandbox.condition(own)).toThrow(/toJSON/)
  } finally { sandbox.dispose() }
}, 30_000)

it('A1：原型链上不可枚举的 toJSON 同样被发现', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const proto = `1) %><% ${replayBefore} Object.defineProperty(Object.prototype,'toJSON',{configurable:true,
      value(){return this===scopes?snap.scopes:this===variables?snap.variables:Object.assign({},this)}}); %><% Boolean(1`
    expect(() => sandbox.condition(proto)).toThrow(/toJSON/)
  } finally { sandbox.dispose() }
}, 30_000)

it('A1：替换 Object/JSON/Array 全局不能让 toJSON 检查漏判', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const blind = `1) %><% ${replayBefore} scopes.toJSON=()=>snap.scopes; variables.toJSON=()=>snap.variables;
      Object.keys=()=>[]; Object.entries=()=>[]; Object.getPrototypeOf=()=>null; Array.isArray=()=>false;
      Reflect.get=()=>undefined; %><% Boolean(1`
    expect(() => sandbox.condition(blind)).toThrow(/toJSON/)
  } finally { sandbox.dispose() }
}, 30_000)

it('大型 MVU 状态下的大量只读 @@if 在默认期限内完成', async () => {
  await TemplateSandbox.prepare()
  const stat: Record<string, unknown> = {}
  for (let index = 0; index < 1000; index++) stat[`角色${index}`] = { 好感: index, 状态: '正常', 位置: { x: index, y: index } }
  const sandbox = await TemplateSandbox.create({ ...context(), variables: { global: {}, local: { stat_data: stat }, message: {} } }, false)
  try {
    // 每次快照要序列化整份状态；旧版每条条件取两次并逐节点往返句柄，几十条就会耗尽 750ms 期限。
    for (let index = 0; index < 40; index++) expect(sandbox.condition(`getvar('stat_data.角色${index}.好感') === ${index}`)).toBe(true)
    expect(() => sandbox.condition(`setvar('stat_data.角色1.好感', 9)`)).toThrow(/只读/)
  } finally { sandbox.dispose() }
}, 30_000)

it('连续条件复用上一条的末态快照，中间有求值时重新读取', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    // 计数 getter 不改状态值，只记录快照读取次数：每次快照经 dump 与 toJSON 检查各读一次。
    sandbox.render(`<% globalThis.probeReads=0; Object.defineProperty(variables,'probe',{enumerable:true,get(){globalThis.probeReads++;return 1}}) %>`)
    const reads = () => Number(sandbox.render('<%- globalThis.probeReads %>'))
    const start = reads()
    for (let index = 0; index < 5; index++) expect(sandbox.condition('true')).toBe(true)
    // 首条取起点与末态，其后四条只取末态：共 6 次快照。
    expect(reads() - start).toBe(12)
    // reads() 本身是一次求值，下一条条件必须重新取起点。
    const afterRender = reads()
    expect(sandbox.condition('true')).toBe(true)
    expect(reads() - afterRender).toBe(4)
  } finally { sandbox.dispose() }
}, 30_000)
