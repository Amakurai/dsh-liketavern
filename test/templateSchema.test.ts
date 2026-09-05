/** 使用真实 Zod 与 QuickJS 验证变量 schema：类型、转换、默认值、删除原子性和恶意校验器隔离。 */
import { describe, expect, it } from 'vitest'
import { isolated } from '../src/node/isolated.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1000,seed:1,phase:'generate',...patch})
const render=(text:string,patch:Partial<TemplateContext>={})=>isolated('template',{context:context(patch),texts:[text]})

describe('变量 schema',()=> {
  it('完整 Lodash 的链式/集合 API 与宽松 JSON 可用于 schema 前的数据处理',async()=> {
    const result=await render(`<%
      const repaired=parseJSON("{hp:'12', items:['sword',], /* model output */}");
      setVariableSchema({hp:z.coerce.number(),items:z.array(z.string())});
      setvar(null,repaired);
      setvar('stats',_.chain([{name:'A',score:2},{name:'B',score:5}]).filter(x=>x.score>2).map('name').value());
      setvar('sum',_.sumBy([{n:2},{n:3}],'n'));
    %>`)
    expect(result.variables.message).toEqual({hp:12,items:['sword'],stats:['B'],sum:5})
    await expect(render('<%- parseJSON("{ x: (()=>{throw 1})() }") %>')).rejects.toThrow()
  })
  it('Lodash 捕获冻结时钟与随机源，不能恢复 Node 权限',async()=> {
    const script='<%- JSON.stringify([_.now(),_.random(1,1000000),_.sample([1,2,3]),_.template("value: ${typeof process}")({})]) %>'
    const first=await render(script),second=await render(script)
    expect(first.texts).toEqual(second.texts)
    expect(JSON.parse(first.texts[0]!)[0]).toBe(1000)
    expect(JSON.parse(first.texts[0]!)[3]).toBe('value: undefined')
  })
  it('真实 Zod 处理联合、数组、默认值与转换，未知根字段保留',async()=> {
    const result=await render(`<%
      setVariableSchema(z.object({
        hp:z.coerce.number().int().min(0).max(100),
        mode:z.enum(['normal','combat']).default('normal'),
        items:z.array(z.union([z.string(),z.number()])).default([]),
        name:z.string().trim().default('Alice'),
      }));
      setvar(null,{hp:'10',name:' Alice ',extra:42});
      insvar('items','sword');
    %><%- z.string().startsWith('A').parse(variables.name) %>`)
    expect(result.texts).toEqual(['Alice'])
    expect(result.variables.message).toEqual({hp:10,mode:'normal',items:['sword'],name:'Alice',extra:42})
    expect((await render('<% setVariableSchema(z.looseObject({hp:z.number()}).transform(({obsolete,...rest})=>rest)); setvar(null,{hp:10,obsolete:1,extra:2}); %>')).variables.message).toEqual({hp:10,extra:2})
  })
  it('失败写入、删除和批量补丁均保持旧变量，校验返回错误可以由模板捕获',async()=> {
    const result=await render(`<%
      setvar(null,{hp:10,bag:['apple']});
      setVariableSchema({hp:z.number().min(0),bag:z.array(z.string())});
      let rejected=0;
      for(const operation of [()=>setvar('hp',-1),()=>delvar('hp'),()=>insvar('bag',2),
        ()=>patchVariables(null,[{op:'replace',path:'/hp',value:2},{op:'replace',path:'/bag/0',value:false}])]) {
        try {operation();} catch {rejected++;}
      }
      setvar('rejected',rejected);
    %>`)
    expect(result.variables.message).toEqual({hp:10,bag:['apple'],rejected:4})
  })
  it('默认值和转换只写入目标作用域，不复制其它作用域的资产',async()=> {
    const result=await render(`<%
      setGlobalVar('globalOnly',1); setLocalVar('localOnly',2);
      setVariableSchema({hp:z.coerce.number(),name:z.string().default('Alice')});
      setMessageVar('hp','8');
    %>`)
    expect(result.variables).toEqual({global:{globalOnly:1},local:{localOnly:2},message:{hp:8,name:'Alice'}})
    expect((await render('<% setVariableSchema({hp:z.number().transform(n=>n+1).pipe(z.number().max(10))}); setvar("hp",9); %>')).variables.message).toEqual({hp:10})
  })
  it('自定义 refinement 在沙箱内执行，循环、异步校验、非 JSON 输出均明确失败',async()=> {
    await expect(render('<% setVariableSchema({hp:z.number().refine(()=>{while(true){}})}); setvar("hp",1); %>')).rejects.toThrow(/interrupt|超时/)
    await expect(render('<% setVariableSchema({hp:z.number().refine(async()=>true)}); setvar("hp",1); %>')).rejects.toThrow(/Promise|async|同步/)
    await expect(render('<% setVariableSchema({hp:z.number().transform(()=>Infinity)}); setvar("hp",1); %>')).rejects.toThrow(/JSON/)
  })
  it('validator 的嵌套写入与引用修改不能污染状态，导出也会拦截绕过 setter 的坏值',async()=> {
    const result=await render(`<%
      setvar('hp',10);
      setVariableSchema({hp:z.number().refine(()=>{setvar('bad',1);return true})});
      try {setvar('hp',1);} catch {}
      setVariableSchema({hp:z.number().refine(()=>{getMessageVar(null).bad=2;return true})});
      try {setvar('hp',1);} catch {}
      setVariableSchema({hp:z.number().min(0)});
    %>`)
    expect(result.variables.message).toEqual({hp:10})
    await expect(render('<% setvar("hp",1); setVariableSchema({hp:z.number().min(0)}); getMessageVar(null).hp=-1; %>')).rejects.toThrow()
  })
  it('预加载 schema 在生成与渲染中重建；只读加载不落盘',async()=> {
    const entries=parseLorebook({entries:[{uid:1,comment:'schema',content:'@@only_preload\n<% const limit=20; setVariableSchema({hp:z.number().max(limit)}); %>'}]},{source:'character',sourceRef:'card'})
    expect((await render('preview',{entries})).variables).toEqual(emptyTemplateScopes())
    expect((await render('<% setvar("hp",10); %>',{entries})).variables.message).toEqual({hp:10})
    await expect(render('<% setvar("hp",30); %>',{entries,phase:'render'})).rejects.toThrow()
  })
})
