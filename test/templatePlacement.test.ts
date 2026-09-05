/** 消息定位兼容：隔离 worker 验证模拟位置、真实通道映射、脚本重放和失败边界。 */
import { describe, expect, it } from 'vitest'
import { parseTemplatePlacement } from '../src/core/templatePlacement.js'
import { defaultPreset } from '../src/core/assemble.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import { emptyTemplateScopes } from '../src/core/template.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { isolated } from '../src/node/isolated.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'

function input(lore:Record<string,unknown>[],history:ChatMessage[]=[{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'last'}]):ComputeJobs['assemble']['input'] {
  const entries=parseLorebook({entries:lore.map((entry,i)=>({uid:i+1,constant:true,...entry}))},{source:'character',sourceRef:'card'})
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>['chatHistory','worldInfoBefore'].includes(entry.identifier))
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},
    templates:{variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries,presets:[],history,now:1000,seed:42,phase:'generate'},
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:100000,reservedTokens:0,seed:42}}
}
const run=(entries:Record<string,unknown>[])=>isolated('assemble',input(entries))

describe('定位参数解析',()=> {
  it('区分两套下标，保留正则逗号、空格、引号和反斜杠',()=> {
    expect(parseTemplatePlacement('@INJECT [pos=-1,role=assistant,order=3]')).toMatchObject({mode:'pos',pos:-1,role:'assistant',order:3})
    expect(parseTemplatePlacement('@INJECT target=user,index=-2,at=after')).toMatchObject({mode:'target',target:'user',index:-2,at:'after'})
    expect(parseTemplatePlacement('@INJECT regex="a{1,3} \\d+",role=user')).toMatchObject({mode:'regex',regex:'a{1,3} \\d+',role:'user'})
    expect(parseTemplatePlacement('@INJECT regex=a{1,3},role=user')).toMatchObject({mode:'regex',regex:'a{1,3}'})
    expect(parseTemplatePlacement('[GENERATE:0:AFTER] label')).toEqual({kind:'content',mode:'index',index:0,at:'after'})
    expect(parseTemplatePlacement('[GENERATE:REGEX:[ab]]')).toMatchObject({mode:'regex',regex:'[ab]'})
    expect(parseTemplatePlacement('[GENERATE:REGEX:x]')).toMatchObject({mode:'regex',regex:'x'})
    expect(parseTemplatePlacement('ordinary')).toBeNull()
  })
  it.each(['@INJECT','@INJECT pos=1,target=user','@INJECT pos=1,role=tool','@INJECT pos=1,pos=2','@INJECT pos=1,unknown=2','@INJECT pos=1.5','@INJECT pos=9007199254740992','@INJECT pos=1,at=after','@INJECT target=user,at=middle','@INJECT regex="open','[GENERATE:REGEX:]'])('拒绝错误参数 %s',label=> {
    expect(()=>parseTemplatePlacement(label)).toThrow()
  })
})

describe('隔离定位注入',()=> {
  it('位置按原序列批量插入、同位置按 order 排序，角色与负下标准确',async()=> {
    const request=input([
      {comment:'@INJECT pos=0,order=20',content:'front2'},
      {comment:'@INJECT pos=1,role=assistant,order=10',content:'front1'},
      {comment:'@INJECT target=user,index=-1,at=after,role=user',content:'tail'},
      {comment:'@INJECT pos=-1',content:'before-last'},
      {comment:'@INJECT pos=99',content:'end'},
    ])
    const original=structuredClone(request)
    const result=await isolated('assemble',request)
    expect(result.messages.map(m=>m.content)).toEqual(['front1','front2','first','answer','before-last','last','tail','end'])
    expect(result.messages[0]!.role).toBe('assistant')
    expect(result.messages.at(-2)!.role).toBe('user')
    expect(result.turnContext).toContain('before-last')
    expect(result.standing).not.toContain('before-last')
    expect(result.log.some(l=>l.kind==='template-placement'&&l.detail.includes('tavern:turn'))).toBe(true)
    expect(request).toEqual(original)
  })
  it('正则插入在位置插入后匹配第一条，匹配默认区分大小写',async()=> {
    const result=await run([
      {comment:'@INJECT pos=1',content:'NEW'},
      {comment:'@INJECT regex="NEW",at=after,role=assistant',content:'found'},
      {comment:'@INJECT regex="new"',content:'<% throw Error("must skip") %>'},
    ])
    expect(result.messages.map(m=>m.content)).toEqual(['NEW','found','first','answer','last'])
    expect(result.log.some(l=>l.detail.includes('未找到目标'))).toBe(true)
  })
  it('GENERATE 下标追加正文，正则忽略大小写匹配每条且传入局部消息',async()=> {
    const result=await run([
      {comment:'[GENERATE:0:AFTER]',order:1,content:'suffix'},
      {comment:'[GENERATE:REGEX:FIRST|LAST]',order:2,content:'<% incvar("matches") %><%- matched_message_role %>:<%- matched_message_index %>:<%- world_info.uid %>'},
      {comment:'[GENERATE:99:BEFORE]',content:'<% throw Error("must skip") %>'},
    ])
    expect(result.messages.map(m=>m.content)).toEqual(['user:0:2firstsuffix','answer','user:2:2last'])
    expect(result.templateVariables?.message).toEqual({matches:2})
    expect(result.history.map(m=>m.content)).toEqual(['first','answer','last'])
  })
  it('主动激活后移动的正则目标只执行一次，最终正文仍精确定位',async()=> {
    const result=await run([
      {comment:'[GENERATE:REGEX:^first$]',content:'<% incvar("runs"); await activewi("extra") %>prefix'},
      {comment:'extra',constant:false,key:['never'],content:'EXTRA'},
    ])
    expect(result.templateVariables?.message).toEqual({runs:1})
    expect(result.messages.findIndex(m=>m.content==='prefixfirst')).toBe(1)
    expect(result.turnContext).toContain('EXTRA')
  })
  it('禁用与未命中内容不执行，纯文本定位也启动沙箱',async()=> {
    const result=await run([{comment:'@INJECT pos=1',content:'plain'},{comment:'@INJECT pos=1',disable:true,content:'<% throw Error("disabled") %>'}])
    expect(result.messages[0]!.content).toBe('plain')
  })
  it('@INJECT 先执行 generate 正则，新增代码执行、删除代码跳过，主动激活重组不重复回调或模板',async()=> {
    const result=await run([
      {comment:'[GENERATE:BEFORE]',content:'<% activateRegex(/^TOKEN$/,()=>{incvar("injectRegexRuns");return "<"+"% incvar(\\\"injectEjsRuns\\\");await activewi(\\\"extra\\\") %"+">CREATED"},{generate:true,worldinfo:true});activateRegex(new RegExp("<"+"%[\\\\s\\\\S]*?%"+">REMOVE"),"DELETED",{generate:true,worldinfo:true}) %>'},
      {comment:'@INJECT pos=0',content:'TOKEN'},
      {comment:'@INJECT pos=1',content:'<% throw Error("removed inject must not execute") %>REMOVE'},
      {comment:'extra',constant:false,key:['never'],content:'<% incvar("extraRuns") %>EXTRA'},
    ])
    expect(result.messages.slice(0,2).map(message=>message.content)).toEqual(['CREATED','DELETED'])
    expect(result.templateVariables?.message).toEqual({injectRegexRuns:1,injectEjsRuns:1,extraRuns:1})
    expect(result.turnContext).toContain('EXTRA')
    expect(result.turnContext).toContain('CREATED')
  })
  it('坏正则、执行错误和超量输出使整次组装失败',async()=> {
    await expect(run([{comment:'@INJECT regex="("',content:'x'}])).rejects.toThrow(/无效定位正则/)
    await expect(run([{comment:'@INJECT pos=1',content:'<% setvar("partial",1); throw Error("bad inject") %>'}])).rejects.toThrow(/bad inject/)
    await expect(run([{comment:'@INJECT pos=1',content:'<%- "x".repeat(1100000) %>'}])).rejects.toThrow(/上限/)
    const request=input([{comment:'@INJECT pos=1',content:'<%- "界".repeat(1000) %>'}])
    request.budget.maxTokens=100
    await expect(isolated('assemble',request)).rejects.toThrow(/超过可用窗口/)
  })
  it('灾难回溯定位正则由 worker 超时终止',async()=> {
    const request=input([{comment:'@INJECT regex="(a+)+$"',content:'x'}],[{role:'user',content:'a'.repeat(100)+'!'}])
    await expect(isolated('assemble',request)).rejects.toThrow(/超时/)
  })
})
