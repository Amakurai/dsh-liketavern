/** GENERATE 上下文兼容：验证完整模拟序列、顺序缓冲、装饰器定位、重组冻结以及实文本预算与隔离失败。 */
import {describe,expect,it} from 'vitest'
import {defaultPreset} from '../src/core/assemble.js'
import {normalizeTemplateLore} from '../src/core/templateLore.js'
import {parseTemplatePlacement} from '../src/core/templatePlacement.js'
import {emptyTemplateScopes} from '../src/core/template.js'
import {DEFAULT_WI_SETTINGS,EMPTY_TIMER_STATE,type ChatMessage} from '../src/core/types.js'
import type {ComputeJobs} from '../src/node/computeWorker.js'
import {isolated} from '../src/node/isolated.js'
import {parseLorebook} from '../src/state/lorebook.js'

function request(lore:Record<string,unknown>[],main='MAIN|',history:ChatMessage[]=[{role:'user',content:'USER|'}]):ComputeJobs['assemble']['input'] {
  const entries=parseLorebook({entries:lore.map((entry,index)=>({uid:index+1,constant:true,...entry}))},{source:'character',sourceRef:'card'})
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>['main','worldInfoBefore','chatHistory'].includes(entry.identifier))
  preset.entries.find(entry=>entry.identifier==='main')!.content=main
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},
    templates:{variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries,presets:preset.entries,history,now:1000,seed:42,phase:'generate'},
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,
      contextWindowTokens:100000,reservedTokens:0,seed:42}}
}

describe('GENERATE 顺序上下文',()=> {
  it('完整原始序列包含预设和历史，buffer 按全局前置、消息前置、正文、消息后置顺序推进',async()=> {
    const input=request([
      {comment:'global-before',content:'@@generate_before\n<% setvar("raw",generateData);setvar("globalBefore",generateBuffer) %>G|'},
      {comment:'index-before',content:'@@generate_before 0\n<% setvar("indexBefore",generateBuffer) %>B0|'},
      {comment:'index-after',content:'@@generate_after 0\n<% setvar("indexAfter",generateBuffer) %>A0|'},
      {comment:'last-after',content:'@@generate_after -1\n<% setvar("lastAfter",generateBuffer) %>A1|'},
      {comment:'global-after',content:'@@generate_after\n<% setvar("globalAfter",generateBuffer) %>END'},
    ],'<% setvar("mainBuffer",generateBuffer) %>MAIN|',[{role:'user',content:'<% setvar("userBuffer",generateBuffer) %>USER|'}])
    const original=structuredClone(input)
    const result=await isolated('assemble',input)
    expect(result.messages.map(message=>message.content)).toEqual(['G|B0|MAIN|A0|','USER|A1|END'])
    expect(result.templateVariables?.message).toMatchObject({globalBefore:'',indexBefore:'G|',mainBuffer:'G|B0|',
      indexAfter:'G|B0|MAIN|',userBuffer:'G|B0|MAIN|A0|',lastAfter:'G|B0|MAIN|A0|USER|',globalAfter:'G|B0|MAIN|A0|USER|A1|'})
    expect(result.templateVariables?.message.raw).toEqual([
      {role:'system',content:original.preset.entries[0]!.content},
      {role:'user',content:original.history[0]!.content},
    ])
    expect(result.standing).toBe('')
    expect(result.turnContext).toContain('G|B0|MAIN|A0|')
    expect(result.turnContext).toContain('A1|')
    expect(result.turnContext).not.toContain('USER|')
    expect(result.history).toEqual([{role:'user',content:'USER|'}])
    expect(input).toEqual(original)
  })

  it('装饰器的下标与正则参数保留语义，坏参数不能悄悄变成全局注入',async()=> {
    const parsed=request([{comment:'x',content:'@@generate_after -1\nTAIL'}]).templates!.entries[0]!
    expect(parseTemplatePlacement(normalizeTemplateLore(parsed).comment)).toEqual({kind:'content',mode:'index',index:-1,at:'after'})
    const result=await isolated('assemble',request([
      {comment:'before',content:'@@generate_before REGEX:^user\n<%- matched_message_role %>:<%- matched_message_index %>|'},
      {comment:'after',content:'@@generate_after REGEX:^user\nEND|'},
      {comment:'unused',content:'@@generate_before 20\n<% throw Error("unused") %>'},
    ]))
    expect(result.messages.map(message=>message.content)).toEqual(['MAIN|','user:1|USER|END|'])
    expect(result.log.some(line=>line.detail.includes('未找到目标消息'))).toBe(true)
    for(const argument of ['1.5','9007199254740992','REGEX:','bad']) {
      await expect(isolated('assemble',request([{comment:'bad',content:`@@generate_before ${argument}\nX`}]))).rejects.toThrow(/参数|下标|模式/)
    }
  })

  it('来源按消息位置执行，声明空输出保留副作用且不留下空消息',async()=> {
    const input=request([{comment:'before',content:'@@generate_before\n<% define("echo",()=>"defined") %>'}],
      '<% incvar("mainRuns");define("fromMain",()=>"main") %>',
      [{role:'user',content:'<%- echo() %>|<%- fromMain() %>'}])
    const result=await isolated('assemble',input)
    expect(result.messages).toEqual([{role:'user',content:'defined|main'}])
    expect(result.templateVariables?.message.mainRuns).toBe(1)
    expect(result.standing+result.turnContext).not.toContain('tavern-source:')
  })

  it('activewi 重组不重复写入或改动旧来源的原始序列和缓冲，JSON 回放仍能恢复闭包',async()=> {
    const input=request([
      {comment:'activate',content:'@@generate_after\n<% incvar("afterRuns");await activewi("extra");define("saved",()=>generateData.length+":"+generateBuffer) %>'},
      {comment:'extra',constant:false,key:['never'],content:'<% incvar("extraRuns") %>EXTRA|'},
    ],'<% incvar("mainRuns");setvar("firstData",generateData);setvar("firstBuffer",generateBuffer) %>MAIN|')
    const result=await isolated('assemble',input)
    expect(result.templateVariables?.message).toMatchObject({mainRuns:1,afterRuns:1,extraRuns:1,firstBuffer:''})
    expect((result.templateVariables?.message.firstData as unknown[]).length).toBe(2)
    expect(result.messages).toHaveLength(3)
    const replay=JSON.parse(JSON.stringify(result.templateReplay)) as NonNullable<typeof result.templateReplay>
    const rendered=await isolated('template',{context:{...input.templates!,variables:result.templateVariables!,phase:'render'},
      replay,texts:['<%- saved() %>']})
    expect(rendered.texts).toEqual(['2:MAIN|USER|'])
  })

  it('generate 正则先于 EJS，新增代码会执行，被删除的代码不执行，重组不重复正则回调',async()=> {
    const generated=await isolated('assemble',request([
      {comment:'regex',content:'@@generate_before\n<% activateRegex(/TOKEN/g,()=>{incvar("regexRuns");return "<"+"% incvar(\\\"ejsRuns\\\") %"+">OK"},{generate:true}); %>'},
      {comment:'activate',content:'@@generate_after\n<% await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'EXTRA'},
    ],'TOKEN'))
    expect(generated.messages[0]!.content).toBe('OK')
    expect(generated.templateVariables?.message).toEqual({regexRuns:1,ejsRuns:1})
    const self=await isolated('assemble',request([
      {comment:'register',content:'@@generate_before\n<% activateRegex(/MARK/g,()=>{incvar("sourceRegexRuns");return "VALUE"},{generate:true,worldinfo:true}); %>'},
      {comment:'self',content:'<% incvar("sourceRuns");await activewi("self") %>MARK'},
    ],''))
    expect(self.templateVariables?.message).toEqual({sourceRegexRuns:1,sourceRuns:1})
    const removed=await isolated('assemble',request([
      {comment:'remove',content:'@@generate_before\n<% activateRegex(new RegExp("<"+"%[\\\\s\\\\S]*?%"+">","g"),"",{generate:true}); %>'},
    ],'<% throw Error("removed main must not execute") %>MAIN',
      [{role:'user',content:'<% throw Error("removed history must not execute") %>USER'}]))
    expect(removed.messages.map(message=>message.content)).toEqual(['MAIN','USER'])
  })

  it('世界书合并消息按全文匹配，跨来源捕获替换与原生 replace 一致',async()=> {
    const pattern='(?<first>alpha)\\s+(beta)',replacement='$2:$<first>:$1:$$:$&'
    const input=request([
      {comment:'register',content:`@@generate_before\n<% activateRegex(new RegExp(${JSON.stringify(pattern)},"g"),${JSON.stringify(replacement)},{generate:true,worldinfo:true}) %>`},
      {comment:'a',content:'alpha'},
      {comment:'b',content:'beta'},
    ],'')
    const result=await isolated('assemble',input)
    const raw='【世界书·常驻】\nalpha\n\nbeta'
    expect(result.messages[0]!.content).toBe(raw.replace(new RegExp(pattern,'g'),replacement))
    expect(result.standing).toBe('')
    expect(result.turnContext).toContain('beta:alpha:alpha:$:alpha')
    expect(JSON.stringify(result.templateReplay)).not.toContain('tavern-source:')
  })

  it('全文锚点与跨来源生成的 EJS 生效，重组和 JSON 回放不重复正则或代码副作用',async()=> {
    const input=request([
      {comment:'register',content:'@@generate_before\n<% activateRegex(/^【世界书·常驻】\\nalpha\\s+beta$/,()=>{incvar("crossRegexRuns");return "<"+"% incvar(\\\"crossEjsRuns\\\");define(\\\"crossSaved\\\",()=>generateBuffer) %"+">JOIN"},{generate:true,worldinfo:true}) %>'},
      {comment:'a',content:'alpha'},
      {comment:'b',content:'beta'},
      {comment:'activate',content:'@@generate_after\n<% await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'<% incvar("extraRuns") %>EXTRA'},
    ],'HEAD')
    const result=await isolated('assemble',input)
    expect(result.messages.some(message=>message.content==='JOIN')).toBe(true)
    expect(result.templateVariables?.message).toMatchObject({crossRegexRuns:1,crossEjsRuns:1,extraRuns:1})
    const replay=JSON.parse(JSON.stringify(result.templateReplay)) as NonNullable<typeof result.templateReplay>
    const rendered=await isolated('template',{context:{...input.templates!,variables:result.templateVariables!,phase:'render'},
      replay,texts:['<%- crossSaved() %>']})
    expect(rendered.texts).toEqual(['HEAD'])
    expect(rendered.variables.message).toMatchObject({crossRegexRuns:1,crossEjsRuns:1,extraRuns:1})
  })

  it('跨来源删除完整 EJS 不执行已删除代码，重组也不补执行旧代码',async()=> {
    const pattern='<%[\\s\\S]*?%>REMOVE_A\\s+<%[\\s\\S]*?%>REMOVE_B'
    // 拆分 EJS 分隔符，正则字面内容不能提前结束注册模板。
    const encoded=JSON.stringify(pattern).replaceAll('<%','<"+"%').replaceAll('%>','%"+">')
    const input=request([
      {comment:'register',content:`@@generate_before\n<% activateRegex(new RegExp(${encoded},"g"),"",{generate:true,worldinfo:true}) %>`},
      {comment:'a',content:'<% incvar("mustNotRunA") %>REMOVE_A'},
      {comment:'b',content:'<% incvar("mustNotRunB") %>REMOVE_B'},
      {comment:'activate',content:'@@generate_after\n<% await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'EXTRA'},
    ],'')
    const result=await isolated('assemble',input)
    expect(result.templateVariables?.message.mustNotRunA).toBeUndefined()
    expect(result.templateVariables?.message.mustNotRunB).toBeUndefined()
    expect(result.messages.some(message=>message.content.includes('EXTRA'))).toBe(true)
    expect(JSON.stringify(result.messages)).not.toContain('REMOVE_')
  })

  it('整包 basic 先处理再关闭，generate 正则接续，重组新增来源使用原 basic 快照',async()=> {
    const result=await isolated('assemble',request([
      {comment:'register',content:'@@generate_before\n<% activateRegex(/TOKEN/g,"BASIC",{worldinfo:true});activateRegex(/BASIC/g,"READY",{generate:true,worldinfo:true}) %>'},
      {comment:'ordinary',content:'TOKEN'},
      {comment:'writer',content:'<% activateRegex(/READY/g,"WRONG",{basic:true,worldinfo:true});await activewi("extra");incvar("writerRuns") %>TOKEN'},
      {comment:'extra',constant:false,key:['never'],content:'TOKEN'},
    ],''))
    const text=result.messages.map(message=>message.content).join('\n')
    expect(text.match(/READY/g)).toHaveLength(3)
    expect(text).not.toMatch(/TOKEN|BASIC|WRONG/)
    expect(result.templateVariables?.message.writerRuns).toBe(1)
  })

  it('宏嵌套来源保留完整父 EJS 作用域，全文 lookahead 可跨父子来源而不重复执行',async()=> {
    const input=request([
      {comment:'register',content:'@@generate_before\n<% activateRegex(new RegExp("alpha(?=<"+"%)","g"),"ALPHA",{generate:true}) %>'},
      {comment:'nested',position:7,outletName:'nested',content:'<% incvar("nestedRuns") %>beta'},
      {comment:'activate',content:'@@generate_after\n<% await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'EXTRA'},
    ],'<% incvar("parentRuns");if(true){ %>alpha{{outlet::nested}}<% } %>')
    const result=await isolated('assemble',input)
    expect(result.messages[0]!.content).toBe('ALPHAbeta')
    expect(result.templateVariables?.message).toMatchObject({parentRuns:1,nestedRuns:1})
  })

  it('宏嵌套原文服从父条件与循环，共享词法变量，重组不重复旧树且仍加入新来源',async()=> {
    const input=request([
      {comment:'hidden',position:7,outletName:'hidden',content:'<% throw Error("false parent must skip child") %>'},
      {comment:'nested',position:7,outletName:'nested',content:'<% incvar("nestedRuns") %><%- label+i %>'},
      {comment:'activate',content:'@@generate_after\n<% incvar("afterRuns");setvar("afterBuffer",generateBuffer);await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'<% incvar("extraRuns") %>EXTRA'},
    ],'<% incvar("parentRuns");const label="L";if(false){ %>{{outlet::hidden}}<% }for(let i=0;i<3;i++){ %>{{outlet::nested}}<% } %>')
    const result=await isolated('assemble',input)
    expect(result.messages[0]!.content).toBe('L0L1L2')
    expect(result.templateVariables?.message).toEqual({parentRuns:1,nestedRuns:3,afterRuns:1,afterBuffer:'L0L1L2USER|',extraRuns:1})
    expect(result.turnContext).toContain('EXTRA')
    expect(JSON.stringify(result.messages)).not.toContain('tavern-source:')
  })

  it('正则创建与删除的嵌套 EJS 仍服从父作用域，重复循环不重复正则回调，重组保留首次结果',async()=> {
    const result=await isolated('assemble',request([
      {comment:'register',content:'@@generate_before\n<% activateRegex(/TOKEN/g,()=>{incvar("nestedRegexRuns");return "<"+"% incvar(\\\"generatedRuns\\\") %"+"><"+"%- i %"+">"},{generate:true});activateRegex(new RegExp("<"+"% throw Error\\\\(\\\"removed child\\\"\\\\) %"+">"),"",{generate:true}) %>'},
      {comment:'nested',position:7,outletName:'nested',content:'TOKEN<% throw Error("removed child") %>'},
      {comment:'activate',content:'@@generate_after\n<% await activewi("extra") %>'},
      {comment:'extra',constant:false,key:['never'],content:'EXTRA'},
    ],'<% incvar("parentRuns");for(let i=0;i<2;i++){ %>{{outlet::nested}}<% } %>'))
    expect(result.messages[0]!.content).toBe('01')
    expect(result.templateVariables?.message).toEqual({parentRuns:1,nestedRegexRuns:1,generatedRuns:2})
    expect(result.turnContext).toContain('EXTRA')
  })

  it('原始模板长而结果短仍按结果预算；输出增长和递归灾难不会被来源占位隐藏',async()=> {
    const short=request([],`<% /* ${'comment'.repeat(500)} */ %>ok`,[{role:'user',content:'last'}])
    short.budget.maxTokens=20
    const result=await isolated('assemble',short)
    expect(result.messages.map(message=>message.content)).toEqual(['ok','last'])
    expect(result.stats.tokensAfter).toBeLessThan(20)
    const expanded=request([{comment:'after',content:'@@generate_after\n<%- "界".repeat(1000) %>'}],'')
    expanded.budget.maxTokens=50
    await expect(isolated('assemble',expanded)).rejects.toThrow(/超过可用窗口/)
    await expect(isolated('assemble',request([{comment:'after',content:'@@generate_after\n<%- "x".repeat(1100000) %>'}]))).rejects.toThrow(/1 MiB/)
    await expect(isolated('assemble',request([{comment:'regex',content:'@@generate_before REGEX:(a+)+$\nX'}],'',
      [{role:'user',content:'a'.repeat(100)+'!'}]))).rejects.toThrow(/超时/)
  })
})
