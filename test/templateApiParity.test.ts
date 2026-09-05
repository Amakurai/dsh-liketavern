/** API 兼容回归：真实隔离 worker 验证命名去重、定义路径和正则阶段，失败不返回部分变量。 */
import { describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context = (patch: Partial<TemplateContext> = {}): TemplateContext => ({
  variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],
  now:1000,seed:42,phase:'generate',...patch,
})
const render=(text:string,patch:Partial<TemplateContext>={})=>isolated('template',{texts:[text],context:context(patch)})

function generate(script:string) {
  const history=[{role:'system' as const,content:'token'},{role:'user' as const,content:'token'},{role:'assistant' as const,content:'token'}]
  const entries=parseLorebook({entries:[{uid:1,comment:'registrations',content:`@@only_preload\n<% ${script} %>`}]},{source:'character',sourceRef:'card'})
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>entry.identifier==='chatHistory')
  const request:ComputeJobs['assemble']['input']={preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},
    templates:context({history,entries}),wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:100000,reservedTokens:0,seed:42}}
  return isolated('assemble',request)
}
function reply(script:string,text='token') {
  const entries=parseLorebook({entries:[{uid:1,comment:'[RENDER:BEFORE]',content:`<% ${script} %>`}]},{source:'character',sourceRef:'card'})
  return isolated('template',{texts:[text],decorateOutput:true,context:context({phase:'render',entries})})
}

describe('命名提示词与共享定义',()=> {
  it('同组同正文的默认 uid 替换顺序，显式 uid 更新正文，不同组独立',async()=> {
    const result=await render(`<%
      injectPrompt('rules','same',100); injectPrompt('rules','middle',50); injectPrompt('rules','same',10);
      injectPrompt('other','same',0); injectPrompt('rules','old',20,0,'explicit'); injectPrompt('rules','new',30,0,'explicit');
      print(JSON.stringify([getPromptsInjected('rules'),getPromptsInjected('other'),hasPromptsInjected('missing')]));
    %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual(['same\nnew\nmiddle','same',false])
  })
  it('聚合上限与后处理膨胀明确失败，替换既有 uid 释放旧内容预算',async()=> {
    const result=await render(`<%
      injectPrompt('a','x'.repeat(800000),0,0,'replace'); injectPrompt('a','short',0,0,'replace');
      injectPrompt('b','x'.repeat(800000)); print(getPromptsInjected('a'));
    %>`)
    expect(result.texts).toEqual(['short'])
    await expect(render(`<% injectPrompt('a','x'.repeat(600000)); injectPrompt('b','x'.repeat(600000)); %>`)).rejects.toThrow(/总量/)
    await expect(render(`<% injectPrompt('a','x'); getPromptsInjected('a',[{search:'x',replace:'x'.repeat(1100000)}]); %>`)).rejects.toThrow(/上限/)
  })
  it('define 支持路径、返回旧值、根数组拼接和对象内数组替换',async()=> {
    const result=await render(`<%
      define('status.hp',3); const old=define('status.hp',4);
      define('items',['a']); define('items',['b'],true);
      define('state',{nested:{a:1},list:[1,2]}); const previous=define('state',{nested:{b:2},list:[3]},true);
      define('labels["a.b"]','literal');
      print(JSON.stringify({old,hp:status.hp,items,state,previous,literal:labels['a.b']}));
    %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual({old:3,hp:4,items:['a','b'],state:{nested:{a:1,b:2},list:[3]},previous:{nested:{a:1},list:[1,2]},literal:'literal'})
  })
  it('定义的嵌套函数读取当前 locals，跨嵌套模板重新绑定但保留闭包',async()=> {
    const result=await render(`<%
      const suffix='!';
      define('helpers',{show:function(){return this.label+suffix+this.char;}});
      const nested='<'+'%- helpers.show() %'+'>';
      print(await evalTemplate(nested,{label:'outer'}));
      print('|',await evalTemplate(nested,{label:'inner'}));
      define('validator',z.string().min(2)); print('|',validator.parse('ok'));
    %>`)
    expect(result.texts).toEqual(['outer!Alice|inner!Alice|ok'])
  })
  it('定义拒绝原型路径与循环树，已有定义保持可用',async()=> {
    const result=await render(`<%
      define('safe.value',3); let errors=0;
      for(const key of ['__proto__.polluted','safe["constructor"].x','safe.prototype.x']) {
        try {define(key,1);} catch {errors++;}
      }
      const cycle={};cycle.next=cycle;try {define('bad',cycle);} catch {errors++;}
      print(JSON.stringify([errors,safe.value,({}).polluted]));
    %>`)
    expect(JSON.parse(result.texts[0]!)).toEqual([4,3,null])
  })
})

describe('临时正则的选择和文本阶段',()=> {
  it('message 模式默认不作用于生成，显式 basic 可以同时处理用户和角色历史',async()=> {
    const message=await generate(`activateRegex(/token/g,'changed',{message:true,sticky:2});`)
    expect(message.history.map(m=>m.content)).toEqual(['token','token','token'])
    expect(message.templateRegexRules?.[0]?.options).toMatchObject({message:true,basic:false,before:true,after:false})
    const both=await generate(`activateRegex(/token/g,'changed',{message:true,basic:true});`)
    expect(both.history.map(m=>m.content)).toEqual(['token','changed','changed'])
  })
  it('未选模式默认 basic，generate 默认包含 system 并允许显式排除',async()=> {
    expect((await generate(`activateRegex(/token/g,'changed');`)).history.map(m=>m.content)).toEqual(['token','changed','changed'])
    expect((await generate(`activateRegex(/token/g,'changed',{generate:true});`)).history.map(m=>m.content)).toEqual(['changed','changed','changed'])
    expect((await generate(`activateRegex(/token/g,'changed',{generate:true,system:false,user:false});`)).history.map(m=>m.content)).toEqual(['token','token','changed'])
  })
  it('after 在正文 EJS 后执行并读取其变量，不误用 before 阶段',async()=> {
    const result=await reply(`activateRegex(/token/g,function(){return 'hp='+this.getvar('hp')},{message:true,after:true});`,'<% setvar("hp",4) %>token')
    expect(result.texts[0]?.trim()).toBe('hp=4')
    expect(result.variables.message).toEqual({hp:4})
  })
  it('before 和 after 可同时启用，显式停用所有回复阶段保持正文',async()=> {
    const result=await reply(`activateRegex(/token/g,'token!',{message:true,before:true,after:true,maxDepth:-1});`)
    expect(result.texts[0]?.trim()).toBe('token!!')
    expect((await reply(`activateRegex(/token/g,'changed',{message:true,before:false,after:false});`)).texts[0]?.trim()).toBe('token')
  })
  it('纯 basic 拒绝回调，明确 generate 回调仍可执行并保留角色范围',async()=> {
    await expect(render(`<% activateRegex(/token/g,()=> 'changed'); %>`)).rejects.toThrow(/basic/)
    const result=await generate(`activateRegex(/token/g,()=> 'changed',{generate:true,system:false,assistant:false});`)
    expect(result.history.map(m=>m.content)).toEqual(['token','changed','token'])
  })
  it('非法阶段开关和 after 回调失败不返回部分变量',async()=> {
    await expect(render(`<% activateRegex(/x/g,'y',{system:'yes'}); %>`)).rejects.toThrow(/布尔值/)
    await expect(reply(`activateRegex(/token/g,()=>{setvar('partial',1);throw Error('after failed')},{message:true,after:true});`)).rejects.toThrow(/after failed/)
    await expect(reply(`activateRegex(/token/g,async()=> 'changed',{message:true,after:true});`)).rejects.toThrow(/同步/)
  })
})
