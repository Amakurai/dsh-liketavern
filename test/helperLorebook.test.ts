/** 旧世界书字段行为：格式往返、局部更新、额外字段保留与失败边界，直接验证原生引擎可读产物。 */
import {expect,it} from 'vitest'
import {createHelperLorebookCodec} from '../src/core/helperLorebook.js'
import {helperJson} from '../src/core/helperRuntime.js'
import {parseHelperWorldbook} from '../src/core/helperWorldbook.js'
import {readHelperWorldbook,writeHelperWorldbook} from '../src/state/helperWorldbook.js'
import {parseLorebook} from '../src/state/lorebook.js'
const codec=createHelperLorebookCodec(helperJson)
it('旧字段转换后写入原生世界书，深度角色、继承开关、递归、排序和计分均保留',()=>{
  const input=[{uid:7,comment:'旧卡条目',display_index:12,position:'at_depth_as_assistant',depth:2,keys:['门'],filters:['钥匙'],logic:'and_all',case_sensitive:true,match_whole_words:'same_as_global',use_group_scoring:false,delay_until_recursion:true,group:'g',group_prioritized:true,group_weight:75,automation_id:'action',content:'正文',sticky:3}]
  const converted=parseHelperWorldbook(codec.replace(input)),stored=writeHelperWorldbook(converted),native=parseLorebook(stored,{source:'global',sourceRef:'book'})[0]!
  expect(native).toMatchObject({uid:'7',role:2,position:4,depth:2,caseSensitive:true,matchWholeWords:null,useGroupScoring:false,delayUntilRecursion:1,groupOverride:true,groupWeight:75,automationId:'action',sticky:3})
  expect(codec.toLegacy(readHelperWorldbook(stored).entries[0]!)).toMatchObject({...input[0],delay_until_recursion:1})
})
it('按 UID 局部更新保留其它条目、未指定字段及现代额外数据，不存在或重复 UID 整批拒绝',()=>{
  const original=parseHelperWorldbook([{uid:4,name:'原名',content:'旧',position:{type:'outlet'},extra:{outletName:'status',custom:{value:1},ignoreBudget:true}},{uid:9,content:'另一条'}])
  const changed=parseHelperWorldbook(codec.patch([{uid:4,content:'新'}],original))
  expect(changed[0]).toMatchObject({uid:4,name:'原名',content:'新',position:{type:'outlet'},extra:{outletName:'status',custom:{value:1},ignoreBudget:true}})
  expect(changed[1]).toEqual(original[1]);expect(original[0]?.content).toBe('旧')
  expect(()=>codec.patch([{uid:4,content:'不会写'},{uid:3}],original)).toThrow(/不存在/)
  expect(()=>codec.patch([{uid:4},{uid:4}],original)).toThrow(/重复/)
})
it('完全替换恢复缺省字段但保留同 UID 的现代额外字段，新条目使用有界缺省值',()=>{
  const original=parseHelperWorldbook([{uid:2,name:'旧名',enabled:false,strategy:{keys:['旧键']},extra:{custom:'保留'}}])
  const result=parseHelperWorldbook(codec.replace([{uid:2,content:'新内容'},{}],original))
  expect(result[0]).toMatchObject({uid:2,name:'',enabled:true,content:'新内容',strategy:{keys:[]},extra:{custom:'保留'}})
  expect(new Set(result.map(entry=>entry.uid)).size).toBe(2)
})
it('非法继承开关、旧枚举、函数、访问器和超量输入在修改前拒绝',()=>{
  for(const value of [{use_group_scoring:'yes'},{position:'invented'},{delay_until_recursion:-1},{automation_id:2},{uid:-1},{depth:'2'},{unknown:true}])expect(()=>codec.replace([value])).toThrow()
  let invoked=false
  expect(()=>codec.replace([{get content(){invoked=true;throw Error('不可执行')}}])).toThrow(/非法字段/)
  expect(invoked).toBe(false)
  expect(()=>codec.replace([{content:()=>{}}])).toThrow(/JSON/)
  expect(()=>codec.replace(Array.from({length:2001},()=>({})))).toThrow(/2000/)
})
it('原始角色书的组计分和展示顺序经现代与旧接口往返不丢失',()=>{
  const raw={entries:[{id:'legacy-string',keys:['x'],content:'角色书',extensions:{use_group_scoring:true,display_index:8}}]}
  const modern=readHelperWorldbook(raw).entries,legacy=codec.toLegacy(modern[0]!)
  expect(legacy).toMatchObject({use_group_scoring:true,display_index:8})
  const inherited=readHelperWorldbook({entries:[{keys:['x'],content:'inherit',extensions:{use_group_scoring:null,useGroupScoring:true}}]}).entries[0]!
  expect(codec.toLegacy(inherited).use_group_scoring).toBe('same_as_global')
  const result=writeHelperWorldbook(codec.replace([{...legacy,content:'已改'}],modern),raw)
  expect(parseLorebook(result,{source:'character',sourceRef:'card'})[0]).toMatchObject({uid:'legacy-string',useGroupScoring:true,content:'已改'})
})

it('旧查询过滤只比较指定字段，数组按完整内容匹配；删除 UID 拒绝稀疏或错误类型',()=>{
  const entries=parseHelperWorldbook([{uid:1,name:'target',strategy:{keys:['x']}},{uid:2,name:'other',strategy:{keys:['x','y']}}]).map(codec.toLegacy)
  expect(codec.filter(entries,{comment:'target'}).map(entry=>entry.uid)).toEqual([1])
  expect(codec.filter(entries,{keys:['x']}).map(entry=>entry.uid)).toEqual([1])
  expect(codec.filter(entries,'none')).toEqual(entries)
  expect(()=>codec.ids(new Array(1))).toThrow()
  expect(()=>codec.ids(['1'])).toThrow(/UID/)
})
