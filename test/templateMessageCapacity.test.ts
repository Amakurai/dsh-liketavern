/** 长历史消息变量容量：历史集合随隔离资源预算增长，身份和单条可写快照仍在真实 QuickJS 边界校验。 */
import { describe,expect,it } from 'vitest'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'
import { defaultPreset } from '../src/core/assemble.js'
import { parseTemplateMessageIdentities,parseTemplateMessageVariables,type TemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { isolated } from '../src/node/isolated.js'

function historyContext(length:number,valueSize=0):TemplateContext {
  const history=Array.from({length},(_,index)=>({role:index%2 ? 'assistant' as const : 'user' as const,content:`message ${index}`}))
  const historyIdentities=history.map((_,index)=>({messageId:`m${index}`,hostMessageId:index,swipeId:0 as const}))
  const messageVariables:TemplateMessageVariables={version:1,snapshots:Object.fromEntries(historyIdentities.map(({messageId},index)=>[
    messageId,{values:{index,...(valueSize ? {value:'x'.repeat(valueSize)} : {})},initialized:true},
  ]))}
  return {variables:emptyTemplateScopes(),char:'Factory',user:'User',card:{},entries:[],presets:[],history,historyIdentities,messageVariables,now:0,seed:1,phase:'generate'}
}

describe('长历史消息快照容量',()=> {
  it('超过 4096 条的合法身份和可见快照保持全部稳定身份，头尾历史可在沙箱中读取和修改',async()=> {
    const context=historyContext(4097)
    expect(parseTemplateMessageIdentities(context.historyIdentities,4097)).toHaveLength(4097)
    expect(Object.keys(parseTemplateMessageVariables(context.messageVariables).snapshots)).toHaveLength(4097)
    const result=await isolated('template',{context,texts:[`<% setMessageVar('seen',true,{withMsg:{id:0}}); %><%- getMessageVar('index',{withMsg:{id:0}}) %>/<%- getMessageVar('index',{withMsg:{id:-1}}) %>`]})
    expect(result.texts).toEqual(['0/4096'])
    expect(Object.keys(result.messageVariables.snapshots)).toHaveLength(4097)
    expect(result.messageVariables.snapshots.m0?.values.seen).toBe(true)
    expect(result.messageVariables.snapshots.m4096?.values.index).toBe(4096)
  })

  it('多个小快照组成超过 1 MiB 的可见集合可完整进出隔离器，当前普通变量保持单帧大小',async()=> {
    const context=historyContext(600,2048)
    expect(JSON.stringify(context.messageVariables).length).toBeGreaterThan(1024*1024)
    expect(Object.keys(parseTemplateMessageVariables(context.messageVariables).snapshots)).toHaveLength(600)
    const result=await isolated('template',{context,texts:[`<%- getMessageVar('value',{withMsg:{id:0}}).length %>/<%- getMessageVar('index',{withMsg:{id:-1}}) %>`]})
    expect(result.texts).toEqual(['2048/599'])
    expect(result.messageVariables).toEqual(context.messageVariables)
    expect(result.variables.message).toEqual({index:599,value:'x'.repeat(2048)})
  })

  it('真实 GENERATE 组装超过 4096 条短历史，完整保留首尾消息与可见快照',async()=> {
    const templates=historyContext(4097),preset=defaultPreset()
    preset.entries.find(entry=>entry.identifier==='main')!.content='<% define("historyCount",()=>generateData.length) %>角色'
    preset.entries.find(entry=>entry.identifier==='jailbreak')!.content='<%- historyCount() %>'
    templates.presets=preset.entries
    const result=await isolated('assemble',{templates,preset,card:null,personaDescription:'',history:templates.history,
      wi:null,memories:[],worldDeltas:[],regexRules:[],macroCtx:{char:'Factory',user:'User'},seed:1,
      budget:{maxTokens:1_000_000,reserveForOutput:0}})
    expect(result.history).toEqual(templates.history)
    expect(Object.keys(result.templateMessageVariables!.snapshots)).toHaveLength(4097)
    expect(result.templateMessageVariables!.snapshots.m0?.values.index).toBe(0)
    expect(result.templateMessageVariables!.snapshots.m4096?.values.index).toBe(4096)
    expect(result.messages.at(-1)?.content).toContain('4099')
  })

  it('单条历史快照不能借总容量放宽越过 1 MiB，脚本经历史引用扩张同样拒绝',async()=> {
    const context=historyContext(2)
    context.messageVariables!.snapshots.m0!.values.value='x'.repeat(1024*1024)
    expect(()=>parseTemplateMessageVariables(context.messageVariables)).toThrow(/单条.*1 MiB/)
    expect(()=>parseTemplateMessageVariables(context.messageVariables,'stored')).toThrow(/单条.*1 MiB/)
    await expect(isolated('template',{context:historyContext(2),texts:[`<% findVariables(null,1).value='x'.repeat(1024*1024); %>`]})).rejects.toThrow(/单条.*1 MiB/)
  })

  it('长集合不会跳过末尾重复或非法身份，也不能携带其他剧情的快照',async()=> {
    const context=historyContext(4097),identities=context.historyIdentities!
    expect(()=>parseTemplateMessageIdentities([...identities,{messageId:'m0',swipeId:0}],4098)).toThrow(/重复/)
    expect(()=>parseTemplateMessageIdentities([...identities,{messageId:'bad\nidentity',swipeId:0}],4098)).toThrow(/身份无效/)
    context.messageVariables!.snapshots.sibling={values:{secret:1},initialized:true}
    await expect(isolated('template',{context,texts:['text']})).rejects.toThrow(/不可见/)
  })
})
