/** 设置备份边界审查：大量小字段的已接受变量使用紧凑 JSON 导出后可直接恢复，普通卡面没有管理节点。 */
import {runInNewContext} from 'node:vm'
import {expect,it} from 'vitest'
import {installCardVariables} from '../src/core/cardVariables.js'
import {parseHelperVariableBackup} from '../src/core/helperVariableBackup.js'

it('接受的多字段变量导出后可直接恢复，不因缩进超过自身恢复预算',()=>{
  const children:unknown[]=[]
  const api={} as {replaceVariables(value:unknown):unknown;getVariables():unknown}
  runInNewContext(`(${installCardVariables.toString()})({title:'备份',note:'',backup:'导出',text:'内容'})`,{
    window:api,TextEncoder,document:{readyState:'complete',body:{children}},
  })
  const variables=Object.fromEntries(Array.from({length:50_000},(_,index)=>[`field${index}`,'']))
  expect(()=>api.replaceVariables(variables)).not.toThrow()
  const exported=JSON.stringify({version:1,scopes:{'["chat",""]':api.getVariables()}},null,0)
  expect(parseHelperVariableBackup(exported)['["chat",""]']).toEqual(variables)
  expect(children).toHaveLength(0)
})
