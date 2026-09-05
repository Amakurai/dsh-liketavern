/** ST 兼容接口的行为验证：真实 QuickJS 隔离执行，覆盖 JSON Patch 原子性、变量作用域、查询与装饰器。 */
import { describe, expect, it } from 'vitest'
import { isolated } from '../src/node/isolated.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { normalizeTemplateLore } from '../src/core/templateLore.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context = (patch: Partial<TemplateContext> = {}): TemplateContext => ({
  variables:emptyTemplateScopes(), char:'Alice', user:'Bob', card:{}, entries:[], presets:[],
  history:[], now:1000, seed:42, phase:'generate', ...patch,
})
const render = (text: string, patch: Partial<TemplateContext> = {}) => isolated('template',{texts:[text],context:context(patch)})
const entries = (content: string, patch: Record<string,unknown> = {}) => parseLorebook({entries:[{uid:1,comment:'rule',content,...patch}]},{source:'character',sourceRef:'card'})

describe('ST 模板兼容接口',()=> {
  it('回复正则回调在隔离器执行，异常与超时拒绝整个结果', async()=> {
    const output=(content:string)=>isolated('template',{context:context({phase:'render',entries:entries('@@render_before\n'+content)}),decorateOutput:true,texts:['text']})
    await expect(output('<% activateRegex(/text/g,()=>{throw Error("callback failed")},{message:true}) %>')).rejects.toThrow(/callback failed/)
    await expect(output('<% activateRegex(/text/g,()=>{while(true){}},{message:true}) %>')).rejects.toThrow(/interrupt|超时/)
    await expect(output('<% activateRegex(/text/g,async()=>"x",{message:true}) %>')).rejects.toThrow(/同步/)
  })
  it('世界书 API 返回 ST 字段，显式激活尊重禁用与 dont_activate', async()=> {
    const lore = parseLorebook({entries:[
      {uid:1,comment:'normal',key:['hello'],keysecondary:['friend'],selective:true,selectiveLogic:3,content:'one'},
      {uid:2,comment:'disabled',disable:true,content:'two'},
      {uid:3,comment:'blocked',content:'@@dont_activate\nthree'},
    ]},{source:'character',sourceRef:'card'})
    const result=await render(`<%- JSON.stringify([
      (await getEnabledWorldInfoEntries()).length,
      (await getWorldInfoActivatedData('card','hello friend')).map(e=>e.uid),
      (await activewi('normal')).key, await activewi('disabled'),
      (await activewi('disabled',true)).uid,await activewi('blocked',true)
    ]) %>`,{entries:lore})
    expect(JSON.parse(result.texts[0]!)).toEqual([3,['1'],['hello'],null,'2',null])
  })
  it('JSON Patch 六种操作支持转义路径、数组插入与移动，不修改输入', async()=> {
    const result = await render(`<%
      const original = {items:['a','b'], 'a/b':{'~key':1}, empty:{}};
      const next = jsonPatch(original,[
        {op:'test',path:'/a~1b/~0key',value:1},
        {op:'add',path:'/items/1',value:'c'},
        {op:'replace',path:'/a~1b/~0key',value:2},
        {op:'copy',from:'/a~1b',path:'/empty/copy'},
        {op:'move',from:'/items/0',path:'/items/-'},
        {op:'remove',path:'/empty/copy/~0key'},
      ]);
      setvar('original',original); setvar('next',next);
      setvar('root',jsonPatch({},[{op:'replace',path:'',value:{'':9}},{op:'test',path:'/',value:9}]));
    %>`)
    expect(result.variables.message).toEqual({
      original:{items:['a','b'],'a/b':{'~key':1},empty:{}},
      next:{items:['c','b','a'],'a/b':{'~key':2},empty:{copy:{}}}, root:{'':9},
    })
  })
  it('失败补丁和非法 JSON 不产生部分修改；拒绝越界、原型路径和自包含移动', async()=> {
    const result = await render(`<%
      setvar('state',{hp:10,items:[1,2]});
      let rejected = 0;
      for (const changes of [
        [{op:'replace',path:'/hp',value:1},{op:'test',path:'/hp',value:2}],
        [{op:'add',path:'/items/4',value:1}],
        [{op:'remove',path:'/missing'}],
        [{op:'copy',from:'/missing',path:'/hp'}],
        [{op:'move',from:'/items',path:'/items/x'}],
        [{op:'add',path:'/__proto__/polluted',value:true}],
        [{op:'add',path:'/bad~2key',value:1}],
        [{op:'add',path:'/items/01',value:1}],
      ]) { try { patchVariables('state',changes); } catch { rejected++; } }
      try { setvar('created.deep.bad',()=>0); } catch { rejected++; }
      setvar('rejected',rejected);
    %>`)
    expect(result.variables.message).toEqual({state:{hp:10,items:[1,2]},rejected:9})
  })
  it('插入删除支持字符串、数组、对象及专属作用域，读改写不串作用域', async()=> {
    const result = await render(`<%
      setLocalVar('items',['local']); setMessageVar('items',['message']);
      insertLocalVar('items','apple',0); delLocalVar('items',1);
      setvar('word','ac'); insvar('word','b',1); delvar('word',0);
      setvar('object',{}); insvar('object',3,'a.b');
      setvar('numbers',[1,2]); incvar('numbers',5,{index:1});
      setvar('old',delvar('word',undefined,'old'));
      insvar('numbers',9,10); delvar('numbers',-1);
      patchVariables('items',[{op:'add',path:'/-',value:'pear'}],{scope:'local'});
    %>`)
    expect(result.variables.local).toEqual({items:['apple','pear']})
    expect(result.variables.message).toEqual({items:['message'],object:{'a.b':3},numbers:[1,7],old:'bc'})
    await expect(render('<% delvar("a",undefined,"initial") %>')).rejects.toThrow(/只读/)
    await expect(render('<% incvar("a",1,{outscope:"missing"}) %>')).rejects.toThrow(/作用域/)
  })
  it('历史数量与区间按角色查询，匹配支持正则及全部/任一条件', async()=> {
    const result = await render(`<%- JSON.stringify([
      getChatMessages(0),getChatMessages(1,'user'),getChatMessages(0,3,'assistant'),
      getChatMessages(-2,4),matchChatMessages(['hello',/rain/g],{start:-4,and:true}),
      matchChatMessages('hello',{role:'assistant'}),matchChatMessages('hello',{start:0,end:1}),
      getChatMessages(-1,'user'),getChatMessage(0,'assistant')
    ]) %>`,{history:[{role:'user',content:'hello'},{role:'assistant',content:'rain'},{role:'user',content:'bye'},{role:'assistant',content:'sun'}]})
    expect(JSON.parse(result.texts[0]!)).toEqual([[],['hello'],['rain','sun'],['bye','sun'],false,false,true,['bye'],'rain'])
  })
  it('命名提示词按顺序与 uid 替换，支持后处理与 sticky 注册', async()=> {
    const result = await isolated('template',{context:context(),texts:[`<%
      injectPrompt('rules','last',200); injectPrompt('rules','old',50,0,'same');
      injectPrompt('rules','first',20,0,'same'); injectPrompt('rules','middle',100);
      define('readRules',function(){ return this.getPromptsInjected('rules'); });
    %><%- hasPromptsInjected('rules') %>|<%- readRules() %>`,
    `<%- getPromptsInjected('rules',[{search:/middle/g,replace:'center'}]) %>`]})
    expect(result.texts).toEqual(['true|first\nmiddle\nlast','first\ncenter\nlast'])
    expect((await render('<% injectPrompt("rules","x",100,1) %><%- getPromptsInjected("rules") %>')).texts).toEqual(['x'])
  })
  it('装饰器仅处理头部，映射位置、优先禁用并保留转义文字',()=> {
    const normalized = normalizeTemplateLore(entries('@@always_enabled\n@@generate_after\n@@activate\n@@if getvar("score") > 5\n正文',{disable:true})[0]!)
    expect(normalized).toMatchObject({enabled:true,constant:true,comment:'[GENERATE:AFTER] rule',content:'正文',templateCondition:'getvar("score") > 5'})
    expect(normalizeTemplateLore(entries('@@always_enabled\n@@dont_activate\n@@render_after\n正文')[0]!).enabled).toBe(false)
    expect(normalizeTemplateLore(entries('@@@activate\n正文')[0]!).content).toBe('@@@activate\n正文')
    expect(normalizeTemplateLore(entries('正文\n@@activate')[0]!).constant).toBe(false)
    expect(normalizeTemplateLore(entries('@@typo\n正文')[0]!).content).toBe('正文')
    expect(()=>normalizeTemplateLore(entries('@@iframe\n正文')[0]!)).toThrow(/iframe/)
  })
  it('预加载重建函数与临时默认值，普通写入才持久化；dont_preload 优先', async()=> {
    const lore = parseLorebook({entries:[
      {uid:1,comment:'definitions',content:'@@only_preload\n<% setvar("hp",10,"nx"); define("hpText",function(){return this.getvar("hp")}); %>',order:1},
      {uid:2,comment:'skip',content:'@@preload\n@@dont_preload\n<% throw Error("skipped") %>'},
    ]},{source:'character',sourceRef:'card'})
    const preview = await render('<%- hpText() %>',{entries:lore})
    expect(preview.texts).toEqual(['10']); expect(preview.variables).toEqual(emptyTemplateScopes())
    const normal = await render('<% incvar("hp",2) %><%- hpText() %>',{entries:lore})
    expect(normal.texts).toEqual(['12']); expect(normal.variables.message).toEqual({hp:12})
    expect((await render('<%- hpText() %>',{entries:lore,variables:normal.variables})).texts).toEqual(['12'])
    await expect(render('x',{entries:entries('@@only_preload\n<% setvar("hp",1,true) %>')})).rejects.toThrow(/预加载/)
  })
  it('回复装饰器在正文更新后判断条件，每条目有独立声明作用域', async()=> {
    const lore = parseLorebook({entries:[
      {uid:1,comment:'before',content:'@@render_before\n<% const label="开头"; print(label); %>'},
      {uid:2,comment:'after',content:'@@render_after\n@@if getvar("hp") === 8\n<% const label="状态"; print(label); %>:<%- getvar("hp") %>'},
      {uid:3,comment:'hidden',content:'@@render_after\n@@if false\n<% throw Error("should not run") %>'},
    ]},{source:'character',sourceRef:'card'})
    const result = await isolated('template',{context:context({entries:lore,phase:'render'}),decorateOutput:true,texts:['<% setvar("hp",8) %>回复']})
    expect(result.texts).toEqual(['开头\n回复\n状态:8'])
    expect(result.variables.message).toEqual({hp:8})
  })
})
