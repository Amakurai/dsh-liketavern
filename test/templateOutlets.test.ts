/** 延迟命名出口兼容：真实隔离 worker 验证收集顺序、嵌套、来源重放、宿主通道与展开预算。 */
import { describe, expect, it } from 'vitest'
import { defaultPreset, type AssembledPrompt } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { containsTemplateOutlet, finalizeTemplateOutlets } from '../src/node/templateOutlets.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context = ():TemplateContext => ({variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],
  history:[],now:1000,seed:42,phase:'generate'})
function input(reader:string,writer:string,extra:Record<string,unknown>[]=[]):ComputeJobs['assemble']['input'] {
  const history:ChatMessage[] = [{role:'user',content:'hello'}]
  const entries = parseLorebook({entries:[{uid:1,comment:'[GENERATE:AFTER]',constant:true,content:writer},
    ...extra.map((entry,index)=>({uid:index+2,constant:true,...entry}))]}, {source:'character',sourceRef:'card'})
  const preset = defaultPreset()
  preset.entries = [
    {identifier:'early-reader',name:'Reader',enabled:true,role:'system',position:'relative',depth:0,order:0,content:reader,marker:false},
    ...preset.entries.filter(entry=>['chatHistory','worldInfoBefore'].includes(entry.identifier)),
  ]
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],macroCtx:{char:'Alice',user:'Bob'},
    seed:42,budget:{maxTokens:100000,reserveForOutput:0},
    templates:{...context(),history,entries,presets:preset.entries},
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,
      contextWindowTokens:100000,reservedTokens:0,seed:42}}
}
const run=(reader:string,writer:string,extra:Record<string,unknown>[]=[])=>isolated('assemble',input(reader,writer,extra))

describe('命名注入读取时机',()=> {
  it('普通模板默认即时，显式 outlet 返回占位符，带后处理即时读取',async()=> {
    const result = await isolated('template',{context:context(),texts:[
      `<%- getPromptsInjected('missing') %>`,
      `<% injectPrompt('list','early'); %><%- getPromptsInjected('list',[],true)==='{{outletPromptsInjected:list}}' %>|<%- getPromptsInjected('list',[{search:'early',replace:'processed'}],true) %>`,
      `<% injectPrompt('missing','late'); %><%- getPromptsInjected('missing') %>`,
    ]})
    expect(result.texts).toEqual(['','true|processed','late'])
  })

  it('生成时先读取后收集仍得到最终列表，按 order 排序且 uid 替换不重复',async()=> {
    const result = await run(`Rules: <%- getPromptsInjected('list') %>`,
      `<% incvar('runs'); injectPrompt('list','tail',200); injectPrompt('list','old',10,0,'same'); injectPrompt('list','head',20,0,'same'); injectPrompt('list','middle',100); %>`)
    expect(result.messages.some(message=>message.content==='Rules: head\nmiddle\ntail')).toBe(true)
    expect(result.turnContext).toContain('Rules: head\nmiddle\ntail')
    expect(result.standing).not.toContain('head')
    expect(result.templateVariables?.message.runs).toBe(1)
    expect(JSON.stringify([result.messages,result.standing,result.turnContext])).not.toContain('{{outletPromptsInjected:')
  })

  it('生成时显式 false 和带后处理读取即时快照，不吸收之后的追加',async()=> {
    const result = await run(`Immediate: <%- getPromptsInjected('list',[],false) %>; Processed: <%- getPromptsInjected('list',[{search:'early',replace:'processed'}],true) %>; Deferred: <%- getPromptsInjected('list') %>`,
      `<% injectPrompt('list','late',200) %>`,[
        {comment:'[GENERATE:BEFORE]',content:`<% injectPrompt('list','early',100) %>`},
      ])
    expect(result.turnContext).toContain('Immediate: early; Processed: processed; Deferred: early\nlate')
  })

  it('原生占位符和嵌套列表支持后收集，未知列表为空且正文不二次执行 EJS',async()=> {
    const result = await run('Direct: {{outletPromptsInjected:outer}}|{{outletPromptsInjected:missing}}',
      `<% injectPrompt('outer','A{{outletPromptsInjected:inner}}Z'); injectPrompt('inner','<'+'% incvar("shouldNotExecute") %'+'>'); %>`)
    expect(result.turnContext).toContain('Direct: A<% incvar("shouldNotExecute") %>Z|')
    expect(result.standing).not.toContain('Direct:')
    expect(result.templateVariables?.message.shouldNotExecute).toBeUndefined()
  })

  it('主动激活重组时收集源只执行一次，最后新增内容被已有出口读取',async()=> {
    const result = await run(`Collected: <%- getPromptsInjected('list') %>`,
      `<% incvar('writerRuns'); await activewi('extra'); injectPrompt('list','base',10); %>`,[
        {comment:'extra',constant:false,key:['never'],content:`<% incvar('extraRuns'); injectPrompt('list','extra',20); %>`},
      ])
    expect(result.turnContext).toContain('Collected: base\nextra')
    expect(result.templateVariables?.message).toEqual({writerRuns:1,extraRuns:1})
  })

  it('定位注入阶段最后收集的正文也会填入早先的出口',async()=> {
    const result = await run(`Outlet: <%- getPromptsInjected('list') %>`,'',[
      {comment:'@INJECT pos=0',content:`<% incvar('placed'); injectPrompt('list','from-position') %>positioned-message`},
    ])
    expect(result.messages[0]!.content).toBe('positioned-message')
    expect(result.messages.some(message=>message.content==='Outlet: from-position')).toBe(true)
    expect(result.turnContext).toContain('Outlet: from-position')
    expect(result.templateVariables?.message.placed).toBe(1)
  })

  it('循环、深度、出口次数与展开体积超限均明确失败',async()=> {
    await expect(run('{{outletPromptsInjected:a}}',`<% injectPrompt('a','{{outletPromptsInjected:b}}'); injectPrompt('b','{{outletPromptsInjected:a}}'); %>`)).rejects.toThrow(/循环/)
    await expect(run('{{outletPromptsInjected:n0}}',`<% for(let i=0;i<40;i++) injectPrompt('n'+i,'{{outletPromptsInjected:n'+(i+1)+'}}'); %>`)).rejects.toThrow(/32 层/)
    await expect(run(`{{outletPromptsInjected:a}}`.repeat(4097),`<% injectPrompt('a','') %>`)).rejects.toThrow(/4096 次/)
    await expect(run('{{outletPromptsInjected:a}}{{outletPromptsInjected:a}}',`<% injectPrompt('a','x'.repeat(600000)) %>`)).rejects.toThrow(/1 MiB/)
  },15000)

  it('最终展开重新计算预算，短占位符不能夹带超量提示词',async()=> {
    const request = input('{{outletPromptsInjected:large}}',`<% injectPrompt('large','界'.repeat(2000)) %>`)
    request.budget.maxTokens=500
    await expect(isolated('assemble',request)).rejects.toThrow(/展开后的提示词超过可用窗口/)
  })
})

describe('出口最终通道映射',()=> {
  it('展开全部模拟与真实通道，后处理产生的动态 standing 保守迁入 turn 并保持输入不变',()=> {
    const token='{{outletPromptsInjected:x}}'
    const assembled:AssembledPrompt = {messages:[{role:'system',content:token},{role:'user',content:token}],history:[{role:'user',content:token}],
      standing:`Standing ${token}`,turnContext:`Turn ${token}`,system:'old',log:[],stats:{tokensBefore:10,tokensAfter:10,trimmedSections:[]}}
    const source=structuredClone(assembled)
    const result=finalizeTemplateOutlets(assembled,{resolveOutlets:text=>text.replaceAll(token,'resolved')},1000)
    expect(result.standing).toBe('')
    expect(result.turnContext).toBe('Standing resolved\n\nTurn resolved')
    expect(result.system).toBe(result.turnContext)
    expect(result.history[0]!.content).toBe('resolved')
    expect(result.messages.map(message=>message.content)).toEqual(['resolved','resolved'])
    expect(result.stats.tokensAfter).toBeGreaterThan(0)
    expect(assembled).toEqual(source)
    expect(containsTemplateOutlet(token)).toBe(true)
    expect(containsTemplateOutlet('{{outlet:x}}')).toBe(false)
  })
})
