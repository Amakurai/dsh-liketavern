/** MVU 命令的业务语义与失败边界：普通状态/VWD、JSON Patch、字面量保真、原子拒绝和可序列化沙箱工厂。 */
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'
import { createHelperMvuCommandCodec, type HelperMvuCommand } from '../src/core/helperMvuCommands.js'
import { helperJson, helperRecord } from '../src/core/helperRuntime.js'

const codec = createHelperMvuCommandCodec(helperJson)
const apply = (stat: Record<string, unknown>, text: string) => codec.apply(stat, codec.parse(text))
const patch = (operations: unknown[]) => '<JSON_Patch>\n```json\n' + JSON.stringify(operations) + '\n```\n</JSON_Patch>'

it('按正文顺序提取命令和 JSON Patch，保留字面量参数与注释原因并归一化别名', () => {
  const text = `正文\n_.set('hp', 10, 12);//治疗\n${patch([{ op: 'delta', path: '/hp', value: 2 }])}\n_.assign('bag', {name:'药水', count:1});\n_.unset('flag');`
  const commands = codec.parse(text)
  expect(commands.map(item => item.type)).toEqual(['set', 'add', 'insert', 'delete'])
  expect(commands[0]).toEqual({ type: 'set', args: ["'hp'", '10', '12'], reason: '治疗', full_match: "_.set('hp', 10, 12);//治疗" })
  expect(commands[1]?.args).toEqual(['["hp"]', '2'])
  expect(commands[2]?.args).toEqual(["'bag'", "{name:'药水', count:1}"])
})

it('字符串中的逗号、括号、命令样例、转义斜杠与引号都是数据，不被拆成额外指令', () => {
  const text = `_.set('text', 'x, ); _.set("fake", 99); \\n \\' quoted'); // 原因中 _.delete('hp');\n_.set('list', [{中文键:'第一项', other:[true,null,-1.5e2,],}, 'C:\\\\dir',]);`
  const commands = codec.parse(text), result = codec.apply({ text: '', list: [] }, commands)
  expect(commands).toHaveLength(2)
  expect(result.stat_data).toEqual({ text: 'x, ); _.set("fake", 99); \n \' quoted', list: [{ 中文键: '第一项', other: [true, null, -150] }, 'C:\\dir'] })
})

it('set 支持普通 JSON、旧值装饰参数、默认 VWD 与可空数值，批次不改输入', () => {
  const before = { hp: 10, pair: [10, '生命值'], flag: false, profile: { name: '旧名' } }, saved = structuredClone(before)
  const result = apply(before, `_.set('hp', 999, '12'); _.set('pair', null); _.set('flag', true); _.set('profile', {name:'新名'});`)
  expect(result.stat_data).toEqual({ hp: 12, pair: [null, '生命值'], flag: true, profile: { name: '新名' } })
  expect(result.delta_data).toEqual({ hp: '10->12 ', pair: '10->null ', flag: 'false->true ', profile: '{"name":"旧名"}->{"name":"新名"} ' })
  expect(before).toEqual(saved)
  expect(apply({ pair: [1, '描述'] }, `_.set('pair','3');`).stat_data.pair).toEqual([3, '描述'])
})

it('add 累加有限数字并消除常见浮点误差，支持 VWD；日期与字符串不被误加', () => {
  const result = apply({ plain: 0.1, pair: [5, '分数'] }, `_.add('plain',0.2); _.add('pair',-2);`)
  expect(result.stat_data).toEqual({ plain: 0.3, pair: [3, '分数'] })
  expect(result.delta_data.pair).toBe('5->3 ')
  expect(() => apply({ date: '2026-09-06T00:00:00Z' }, `_.add('date',1000);`)).toThrow(/日期/)
  expect(() => apply({ value: '5' }, `_.add('value',1);`)).toThrow(/有限数字/)
  expect(() => apply({ value: 1 }, `_.add('value','1');`)).toThrow(/有限数字/)
})

it('insert 数组 push/splice 与对象深合并只操作当前容器，点号对象键保留字面量', () => {
  const result = apply({ bag: [{ old: true }], obj: { nest: { x: 1, values: [1, 2] } }, empty: null },
    `_.insert('bag',{name:'药'}); _.insert('bag',0,'前'); _.insert('bag',-1,'倒数'); _.insert('obj',{nest:{y:2,values:[9]}}); _.insert('obj','a.b',{v:3}); _.insert('empty','x',true);`)
  expect(result.stat_data).toEqual({ bag: ['前', { old: true }, '倒数', { name: '药' }], obj: { nest: { x: 1, y: 2, values: [9, 2] }, 'a.b': { v: 3 } }, empty: { x: true } })
  expect(result.delta_data.obj).toContain("key 'a.b'")
  expect(() => apply({ bag: [] }, `_.insert('bag','0','x');`)).toThrow(/位置必须/)
  expect(() => apply({ obj: {} }, `_.insert('missing','x',1);`)).toThrow(/路径不存在/)
})

it('delete 删除对象键、数组下标及首个深相等值，数组保持连续', () => {
  const result = apply({ bag: ['x', { name: '药' }, { name: '药' }, 'y'], obj: { 'a.b': 1, keep: 2 }, gone: true },
    `_.delete('bag', {name:'药'}); _.delete('bag[0]'); _.delete('obj','a.b'); _.delete('gone');`)
  expect(result.stat_data).toEqual({ bag: [{ name: '药' }, 'y'], obj: { keep: 2 } })
  expect(() => apply({ obj: { first: 1 } }, `_.delete('obj',0);`)).toThrow(/属性序号/)
  expect(() => apply({ bag: [1] }, `_.delete('bag',2);`)).toThrow(/目标不存在/)
})

it('JSON Pointer 的点、方括号、斜杠、波浪与空键都按原分段处理', () => {
  const before = { 'a.b': { 'x[y]': { 'slash/key': { '~': { '': 1 } } } } }
  const result = apply(before, patch([{ op: 'replace', path: '/a.b/x[y]/slash~1key/~0/', value: 2 }]))
  expect(result.stat_data).toEqual({ 'a.b': { 'x[y]': { 'slash/key': { '~': { '': 2 } } } } })
  expect(before['a.b']['x[y]']['slash/key']['~']['']).toBe(1)
})

it('Unicode 正文大小写不改变标签位置，值内结束标签和命令样例保持字符串原样', () => {
  const text = 'İ 中文 ' + patch([{ op: 'replace', path: '/text', value: '</JSON_Patch> _.set(\'fake\',9);' }])
  expect(apply({ text: '' }, text).stat_data.text).toBe('</JSON_Patch> _.set(\'fake\',9);')
})

it('JSON Patch add/replace/remove/test/copy/move 遵守数组插入和先删除再移动语义', () => {
  const result = apply({ list: ['a', 'b', 'c'], obj: { n: 1 } }, patch([
    { op: 'test', path: '/obj', value: { n: 1 } }, { op: 'add', path: '/list/1', value: 'new' },
    { op: 'move', from: '/list/0', path: '/list/3' }, { op: 'add', path: '/list/-', value: 'tail' },
    { op: 'copy', from: '/obj', path: '/copy' }, { op: 'replace', path: '/copy/n', value: 2 },
    { op: 'remove', path: '/list/1' },
  ]))
  expect(result.stat_data).toEqual({ list: ['new', 'c', 'a', 'tail'], obj: { n: 1 }, copy: { n: 2 } })
})

it('JSON Patch replace 保留值类型且不把两项数组当 VWD，根替换仍要求普通对象', () => {
  const result = apply({ hp: 1, tuple: [1, 'text'] }, patch([
    { op: 'replace', path: '/hp', value: '2' }, { op: 'replace', path: '/tuple', value: [3, 'new'] },
  ]))
  expect(result.stat_data).toEqual({ hp: '2', tuple: [3, 'new'] })
  expect(apply({ old: 1 }, patch([{ op: 'add', path: '', value: { next: 2 } }])).stat_data).toEqual({ next: 2 })
  expect(() => apply({ old: 1 }, patch([{ op: 'replace', path: '', value: [] }]))).toThrow(/根必须/)
  expect(() => apply({ old: 1 }, patch([{ op: 'remove', path: '' }]))).toThrow(/删除.*根对象/)
})

it('JSON Patch delta 翻译成数值 add，文本 move 可直接迁移节点', () => {
  expect(apply({ hp: 10 }, '[{"op":"delta","path":"/hp","value":-3}]').stat_data.hp).toBe(7)
  expect(apply({ old: { n: 1 }, list: [] }, `_.move('old','list[0]');`).stat_data).toEqual({ list: [{ n: 1 }] })
  expect(apply({ obj: { n: 1 } }, `_.move('obj','obj');`).stat_data).toEqual({ obj: { n: 1 } })
})

it('JSON Patch 失败、越界、非法指针和子路径移动拒绝整批，不留下先前成功步骤', () => {
  const before = { hp: 1, list: ['a'], obj: { n: 1 } }, snapshot = structuredClone(before)
  for (const operation of [
    { op: 'test', path: '/hp', value: 999 }, { op: 'replace', path: '/missing', value: 2 },
    { op: 'add', path: '/list/2', value: 'x' }, { op: 'add', path: '/list/01', value: 'x' },
    { op: 'remove', path: '/list/-' }, { op: 'move', from: '/obj', path: '/obj/child' },
  ]) {
    expect(() => apply(before, patch([{ op: 'replace', path: '/hp', value: 2 }, operation]))).toThrow()
    expect(before).toEqual(snapshot)
  }
  expect(() => codec.parse(patch([{ op: 'replace', path: 'hp', value: 2 }]))).toThrow(/JSON Pointer/)
  expect(() => codec.parse(patch([{ op: 'replace', path: '/bad~2', value: 2 }]))).toThrow(/转义/)
  expect(() => codec.parse(patch([{ op: 'replace', path: '/hp' }]))).toThrow(/缺少 value/)
  expect(() => codec.parse(patch([{ op: 'execute', path: '/hp' }]))).toThrow(/不支持/)
})

it('显示基线与被 hook 修改后的 stat_data 可以分开，未触及字段保留原显示值', () => {
  const result = codec.apply({ hp: 10, flag: true }, codec.parse(`_.add('hp',1); // 治疗`), { hp: 10, flag: false })
  expect(result.stat_data).toEqual({ hp: 11, flag: true })
  expect(result.display_data).toEqual({ hp: '10->11 (治疗)', flag: false })
  expect(result.delta_data).toEqual({ hp: '10->11 (治疗)' })
})

it('监听改写的 args 可以是实际安全 JSON 值，但函数、访问器和污染值从不被求值', () => {
  const commands = codec.parse(`_.set('hp',1); _.set('obj',{});`)
  ;(commands[0]!.args as unknown[])[1] = 3
  ;(commands[1]!.args as unknown[])[1] = { value: true }
  expect(codec.apply({ hp: 1, obj: {} }, commands).stat_data).toEqual({ hp: 3, obj: { value: true } })
  let called = 0
  const data: Record<string, unknown> = {}; Object.defineProperty(data, 'hp', { enumerable: true, get: () => { called++; return 1 } })
  expect(() => codec.apply(data, [])).toThrow()
  ;(commands[0]!.args as unknown[])[1] = () => { called++ }
  expect(() => codec.apply({ hp: 1, obj: {} }, commands)).toThrow()
  expect(called).toBe(0)
})

it.each([
  `_.set('hp', globalThis.secret);`, `_.set('hp', Math.max(1,2));`, `_.set('hp', (()=>1)());`,
  `_.set('hp', {get value(){return 1}});`, `_.set('hp', 1+2);`, `_.set('hp', undefined);`,
  `_.set('hp', {value:process.exit()});`, `_.set('hp', 1e999);`, `_.set('hp', anything(), 3);`,
])('不求值不支持的命令字面量：%s', text => {
  const before = { hp: 1 }
  expect(() => apply(before, text)).toThrow()
  expect(before.hp).toBe(1)
})

it('格式错误不是静默忽略；普通方括号叙述仍可提取后续命令', () => {
  for (const text of [`_.set('hp',1)`, `_.set('hp',1;`, `_.set('hp',,1);`, `_.set('hp', [1});`, '<jsonpatch>[]']) expect(() => codec.parse(text)).toThrow()
  expect(codec.parse('[她叹了口气]\n_.set("hp",2);')).toHaveLength(1)
  expect(codec.parse('没有更新命令')).toEqual([])
  expect(() => apply({ hp: 1 }, '_.set("hp",`value ${Math.random()}`);')).toThrow(/模板字符串/)
})

it('污染路径与未实现的经典元数据在初值和新值中均拒绝', () => {
  for (const text of [`_.set('__proto__.polluted',true);`, `_.insert('obj','constructor',{});`, `_.set('obj', {'prototype':{}});`]) expect(() => apply({ obj: {} }, text)).toThrow()
  expect(() => apply({ obj: {} }, patch([{ op: 'add', path: '/__proto__/polluted', value: true }]))).toThrow()
  for (const initial of [{ $meta: {} }, { nested: { $arrayMeta: true } }, { array: ['$__META_EXTENSIBLE__$'] }, { $internal: {} }]) expect(() => codec.apply(initial, [])).toThrow(/元数据|内部/)
  expect(() => apply({ obj: {} }, `_.set('obj', {$meta:{extensible:true}});`)).toThrow(/元数据/)
  expect(() => apply({ obj: {} }, `_.insert('obj','x','$__META_EXTENSIBLE__$');`)).toThrow(/元数据/)
  expect(Object.prototype).not.toHaveProperty('polluted')
})

it('文本、命令数、路径层数、字面量深度和总输出都有预算，超量不改原状态', () => {
  expect(() => codec.parse('字'.repeat(90000))).toThrow(/256 KiB/)
  expect(() => codec.parse(`_.set('hp',1);`.repeat(257))).toThrow(/256 个命令/)
  expect(() => apply({}, `_.set('${Array(65).fill('x').join('.')}',1);`)).toThrow(/64 层/)
  expect(() => apply({ value: [] }, `_.set('value',${'['.repeat(65)}0${']'.repeat(65)});`)).toThrow(/64 层/)
  const before = { payload: 'a'.repeat(440000), bag: [] }
  expect(() => apply(before, `_.insert('bag',${JSON.stringify('b'.repeat(200000))});`)).toThrow(/预算/)
  expect(before.bag).toEqual([])
  const command: HelperMvuCommand = { type: 'set', args: ["'value'", JSON.stringify('x'.repeat(256 * 1024))], full_match: '', reason: '' }
  expect(() => codec.apply({ value: '' }, [command])).toThrow(/256 KiB/)
})

it('工厂 toString 后只依赖显式 json 参数，在独立 realm 内保持相同语义', () => {
  const context = createContext({ TextEncoder })
  const result = runInContext(`const HELPER_MAX_BYTES=1024*1024; const helperRecord=(${helperRecord.toString()}); const json=(${helperJson.toString()}); const codec=(${createHelperMvuCommandCodec.toString()})(json); codec.apply({hp:2},codec.parse("_.add('hp',3);"))`, context)
  expect(result.stat_data).toEqual({ hp: 5 })
  expect(result.delta_data).toEqual({ hp: '2->5 ' })
})
