/** 设置变量备份的纯函数边界：旧备份兼容、无副作用校验、删除语义和单次原子恢复预算。 */
import {describe,it,expect} from 'vitest'
import {parseHelperVariableBackup,helperVariableRestoreChanges} from '../src/core/helperVariableBackup.js'
import {HELPER_MAX_BYTES,helperTable} from '../src/core/helperRuntime.js'

describe('设置变量备份',()=>{
  it('兼容原卡内备份，保留消息和脚本作用域',()=>{
    const scopes={'["chat",""]':{hp:7},'["message",2]':{flag:true},'["script","dice"]':{n:3}}
    expect(parseHelperVariableBackup(JSON.stringify({version:1,scopes}))).toEqual(scopes)
  })
  it.each(['{}','{"version":1,"scopes":{"bad":{}}}','{"version":1,"scopes":{"[\"chat\",\"\"]":[]}}','{"version":1,"scopes":{},"__proto__":{}}'])('拒绝无效备份而不产生提交计划：%s',text=>{
    expect(()=>parseHelperVariableBackup(text)).toThrow()
  })
  it('备份超限在 JSON 解析前拒绝',()=>expect(()=>parseHelperVariableBackup(' '.repeat(2*1024*1024))).toThrow(/1 MiB/))
  it('接近持久化上限的合法变量可以带封装导出后再导入',()=>{
    const scopes={'["chat",""]':{text:'x'.repeat(HELPER_MAX_BYTES-40)}}
    expect(()=>helperTable(scopes)).not.toThrow()
    const text=JSON.stringify({version:1,scopes})
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(HELPER_MAX_BYTES)
    expect(parseHelperVariableBackup(text)).toEqual(scopes)
    expect(()=>parseHelperVariableBackup(JSON.stringify({version:1,scopes:{'["chat",""]':{text:'x'.repeat(HELPER_MAX_BYTES)}}}))).toThrow()
  })
  it('旧版 current 消息变量映射到所选消息，冲突别名明确拒绝',()=>{
    const old={'["message","current"]':{hp:7}}
    expect(parseHelperVariableBackup(JSON.stringify({version:1,scopes:old}),3)).toEqual({'["message",3]':{hp:7}})
    expect(old['["message","current"]']).toEqual({hp:7})
    expect(()=>parseHelperVariableBackup(JSON.stringify({version:1,scopes:{...old,'["message",3]':{hp:8}}}),3)).toThrow(/冲突/)
  })
  it('缺失旧表恢复为空，未改变的表不提交，携带原值检查并发修改',()=>{
    const before={'["chat",""]':{a:1,b:2},'["character",""]':{old:true}}
    expect(helperVariableRestoreChanges(before,{'["chat",""]':{b:2,a:1}})).toEqual([{key:'["character",""]',before:{old:true},value:{}}])
    expect(before['["character",""]']).toEqual({old:true})
  })
  it('超过 64 张变化表整批拒绝，不拆成可能部分成功的恢复',()=>{
    const next=Object.fromEntries(Array.from({length:65},(_,i)=>[JSON.stringify(['message',i]),{value:1}]))
    expect(()=>helperVariableRestoreChanges({},next)).toThrow(/64/)
  })
})
