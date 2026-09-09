/** MVU 初值的来源优先级、开场白替代、初始化回执与纯数据边界；测试只注入本地 YAML 解析器，不执行卡片代码。 */
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { createHelperMvuInitialData, type HelperMvuInitialSource } from '../src/core/helperMvuInitial.js'
import { helperJson, helperRecord } from '../src/core/helperRuntime.js'

const entry = (uid: string | number, content: string, comment = '[initvar] 初始变量') => ({ uid, comment, content })
const book = (name: string, entries: HelperMvuInitialSource['entries'], role: HelperMvuInitialSource['role'] = 'global'): HelperMvuInitialSource => ({ name, role, entries })
const initial = (sources: HelperMvuInitialSource[], greeting = '', existing: Record<string, unknown> = {}) => createHelperMvuInitialData(sources, greeting, existing, parseYaml, helperJson)

it('全局先于角色、组内保持原顺序，跨书和已有状态保留整个顶层值', () => {
  const sources = [
    book('角色', [entry(3, 'same: character\nprofile: {character: true}\ncharOnly: yes')], 'character'),
    book('全局甲', [entry(1, 'same: first\nprofile: {global: true}\nfirstOnly: 1')]),
    book('全局乙', [entry(2, 'same: second\nsecondOnly: 2')]),
  ]
  const existing = { stat_data: { profile: { user: true }, old: 9 }, custom: { kept: true }, display_data: { old: 'display' } }
  const before = structuredClone({ sources, existing })
  expect(initial(sources, '', existing)).toEqual({
    stat_data: { same: 'first', profile: { user: true }, firstOnly: 1, secondOnly: 2, charOnly: 'yes', old: 9 },
    initialized_lorebooks: { 全局甲: [1], 全局乙: [2], 角色: [3] }, display_data: { old: 'display' }, delta_data: {}, custom: { kept: true },
  })
  expect({ sources, existing }).toEqual(before)
})

it('同书条目递归合并对象，后条目覆盖标量，筛选注释大小写且忽略 enabled', () => {
  const disabled = { ...entry('a', 'profile: {hp: 10, nested: {left: 1}}\ntext: before'), enabled: false }
  const result = initial([book('书', [
    entry('ignored', '<% throw new Error() %>', '普通条目'), disabled,
    entry('b', 'profile: {mp: 3, nested: {right: 2}}\ntext: after', '前缀 [INITVAR] 后缀'),
    entry('b', 'profile: {hp: 12}'),
  ]), book('空书', [])])
  expect(result.stat_data).toEqual({ profile: { hp: 12, mp: 3, nested: { left: 1, right: 2 } }, text: 'after' })
  expect(result.initialized_lorebooks).toEqual({ 书: ['a', 'b'], 空书: [] })
})

it('支持 JSON/YAML 围栏和 initvar 包装，单条数组与经典模板元数据保留给初始化钩子', () => {
  const result = initial([book('书', [entry(1, '<INITVAR>\n```yaml\n$meta: {extensible: true}\nhp: [10, 生命]\nbag: [$__META_EXTENSIBLE__$, {$arrayMeta: true, $meta: {template: {name: 无名}}}]\n```\n</INITVAR>'), entry(2, '```json\n{"text":"中文"}\n```')])], '', { schema: { type: 'object', properties: {} } })
  expect(result.stat_data).toEqual({ $meta: { extensible: true }, hp: [10, '生命'], bag: ['$__META_EXTENSIBLE__$', { $arrayMeta: true, $meta: { template: { name: '无名' } } }], text: '中文' })
  expect(result.schema).toEqual({ type: 'object', properties: {} })
})

it('开场白所有 initvar 块替代角色书和旧状态，全局初值仍补缺省值', () => {
  const result = initial([
    book('角色', [entry('c', '<% 未展开角色模板 %>')], 'character'),
    book('全局', [entry('g', 'hp: 100\nworld: {day: 1}\nshared: {global: true}')]),
  ], '剧情 <initvar>\n```yaml\nhp: 8\nshared: {opening: true}\nprofile: {a: 1}\n```\n</initvar> 后续 <INITVAR>{"profile":{"b":2}}</INITVAR>', {
    stat_data: { old: true }, initialized_lorebooks: { 全局: ['old'], 角色: ['old'], 旧书: [] }, schema: '没有用别管这个',
  })
  expect(result.stat_data).toEqual({ hp: 8, world: { day: 1 }, shared: { opening: true }, profile: { a: 1, b: 2 } })
  expect(result.initialized_lorebooks).toEqual({ 全局: ['g'], 角色: ['c'] })
  expect(result.schema).toBe('没有用别管这个')
})

it('无 initvar 的开场白不当作数据解析；旧书名数组归一化且已初始化书不重新执行', () => {
  const sources = [book('旧书', [entry(1, '<% 不能再次执行 %>')]), book('新书', [entry(2, 'new: true')])]
  const result = initial(sources, '<div>普通 HTML 和 <% 剧情模板 %></div>', { initialized_lorebooks: ['旧书'], stat_data: { hp: 12 } })
  expect(result.stat_data).toEqual({ hp: 12, new: true })
  expect(result.initialized_lorebooks).toEqual({ 旧书: [], 新书: [2] })
  expect(initial(sources, '', result)).toEqual(result)
})

it('重叠数组语义未适配时明确拒绝，相同数组或跨书保留已有顶层数组仍可用', () => {
  expect(() => initial([book('书', [entry(1, 'hp: [1, 生命]'), entry(2, 'hp: [2, 生命]')])])).toThrow(/重叠数组/)
  expect(() => initial([], '<initvar>list: [1]</initvar><initvar>list: [2]</initvar>')).toThrow(/重叠数组/)
  expect(initial([book('甲', [entry(1, 'list: [1]'), entry(2, 'list: [1]')]), book('乙', [entry(3, 'list: [2]')])]).stat_data).toEqual({ list: [1] })
})

it('后条目解析失败时不修改任何输入或提前写初始化回执', () => {
  const existing = { stat_data: { hp: 3 }, initialized_lorebooks: { 旧书: [1] } }
  const sources = [book('书', [entry(2, 'next: true'), entry(3, 'bad: [')])], before = structuredClone({ existing, sources })
  expect(() => initial(sources, '', existing)).toThrow(/JSON\/YAML 解析失败/)
  expect({ existing, sources }).toEqual(before)
})

it.each(['<% const x = 1 %>\nhp: 10', 'hp: "<%= _.get(data, \'hp\') %>"', '```yaml\nhp: "<%- x %>"\n```'])('拒绝未展开 EJS 初值而不作为普通字符串伪成功：%s', content => {
  expect(() => initial([book('书', [entry(1, content)])])).toThrow(/EJS/)
  expect(() => initial([], '<initvar>' + content + '</initvar>')).toThrow(/EJS/)
})

it.each(['<initvar>hp: 1', '</initvar>', '<initvar><initvar>hp: 1</initvar></initvar>', '<initvar data-x="1">hp: 1</initvar>', '<initvar'])('拒绝未闭合、嵌套或带属性的 initvar：%s', content => {
  expect(() => initial([], content)).toThrow(/initvar/)
})

it.each(['', 'hello', '[]', 'null', 'true', '```js\nhp: 1\n```', '```yaml\nhp: 1'])('空值、非对象和不完整围栏不能标成成功初始化：%s', content => {
  expect(() => initial([book('书', [entry(1, content)])])).toThrow(/初值/)
})

it('拒绝污染键、内部字段、非普通 JSON、循环和访问器，不执行 toJSON/getter', () => {
  for (const content of ['__proto__: {polluted: true}', 'obj: {constructor: 1}', '$internal: {}', 'nested: {$internal: {x: 1}}']) {
    expect(() => initial([book('书', [entry(1, content)])])).toThrow(/非法字段|内部状态/)
  }
  expect(() => initial([book('__proto__', [])])).toThrow(/来源/)
  expect(() => initial([], '', { initialized_lorebooks: ['constructor'] })).toThrow(/旧初始化/)
  let evaluated = false
  const getter = Object.defineProperty({}, 'stat_data', { enumerable: true, get: () => { evaluated = true; return {} } })
  expect(() => initial([], '', getter)).toThrow(/非法字段/)
  expect(evaluated).toBe(false)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => initial([], '', cyclic)).toThrow(/循环/)
  expect(() => createHelperMvuInitialData([book('书', [entry(1, 'test')])], '', {}, () => new Date(), helperJson)).toThrow(/普通 JSON/)
})

it('输入、每个解析结果和合并输出各受 1 MiB 预算，所有数据深度最多 64 层', () => {
  expect(() => initial([], 'x'.repeat(1024 * 1024))).toThrow(/预算/)
  const source = [book('书', [entry(1, 'x: small')])]
  expect(() => createHelperMvuInitialData(source, '', {}, () => ({ x: 'x'.repeat(1024 * 1024) }), helperJson)).toThrow(/预算/)
  const repeat = [book('书', [entry(1, 'first'), entry(2, 'second')])]
  expect(() => createHelperMvuInitialData(repeat, '', {}, () => ({ value: 'x'.repeat(530_000) }), helperJson)).toThrow(/解析结果.*预算/)
  expect(() => createHelperMvuInitialData(source, '', { stat_data: { old: 'x'.repeat(530_000) } }, () => ({ next: 'x'.repeat(530_000) }), helperJson)).toThrow(/预算/)
  let deep: unknown = 1
  for (let index = 0; index < 65; index++) deep = { nested: deep }
  expect(() => createHelperMvuInitialData(source, '', {}, () => deep, helperJson)).toThrow(/64 层/)
})

it('整个入口可序列化注入无模块作用域的沙箱，仅调用提供的解析与 JSON 复制器', () => {
  const context = createContext({ TextEncoder })
  const result = runInContext(`
    const HELPER_MAX_BYTES = 1024 * 1024;
    const helperRecord = (${helperRecord.toString()});
    const helperJson = (${helperJson.toString()});
    const initialize = (${createHelperMvuInitialData.toString()});
    initialize([{name:'书',entries:[{uid:1,comment:'[initvar]',content:'{"hp":10}'}]}], '', {}, JSON.parse, helperJson);
  `, context)
  expect(JSON.parse(JSON.stringify(result))).toEqual({ stat_data: { hp: 10 }, initialized_lorebooks: { 书: [1] }, display_data: {}, delta_data: {} })
})
