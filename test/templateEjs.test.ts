/** 对照官方 EJS 验证编译参数、嵌套上下文和包含器；失败用真实隔离 worker 覆盖，不读取测试机器文件。 */
import { describe,expect,it } from 'vitest'
import { createRequire } from 'node:module'
import { isolated } from '../src/node/isolated.js'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'

const official=createRequire(import.meta.url)('ejs') as {compile:(text:string,options:Record<string,unknown>)=>(data:Record<string,unknown>)=>string|Promise<string>}
const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1000,seed:1,phase:'generate',...patch})
const literal=(value:unknown)=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('%','\\u0025')
const render=async(source:string,patch:Partial<TemplateContext>={})=>(await isolated('template',{context:context(patch),texts:[source]})).texts[0]!
const evaluate=(source:string,data:Record<string,unknown>={},options='{}',patch:Partial<TemplateContext>={})=>render(`<%- await evalTemplate(${literal(source)},${literal(data)},${options}) %>`,patch)
const reference=(source:string,data:Record<string,unknown>,options:Record<string,unknown>={})=>official.compile(source,{async:true,outputFunctionName:'print',escape:(value:unknown)=>String(value??''),...options})(data)

describe('官方 EJS 编译参数',()=>{
  it('定界符、字面标签、注释、空白裁剪与官方结果一致',async()=>{
    const cases:[string,Record<string,unknown>][]=[
      ['[?= value ?]|[?- value ?]',{openDelimiter:'[',delimiter:'?',closeDelimiter:']'}],
      ['<?= value ?>|<?# ignored ?>|<??= value ??>',{delimiter:'?'}],
      ['  a\n\n  <%_ const n=2; _%>\n <%= n %>  \n b  ',{rmWhitespace:true}],
      ['<%%= untouched %%>|<%- value %>\n<%# comment %>',{}],
    ]
    for(const [source,options] of cases) expect(await evaluate(source,{value:'<b>&'},literal(options))).toBe(await reference(source,{value:'<b>&'},options))
  })
  it('strict、localsName、显式解构与context保留官方语义',async()=>{
    const source='<%= value %>|<%= scope.other %>|<%= this.label %>'
    const data={value:'first',other:'second'},options={strict:true,localsName:'scope',destructuredLocals:['value'],context:{label:'ctx'}}
    expect(await evaluate(source,data,literal(options))).toBe(await reference(source,data,options))
    await expect(evaluate('<%= value %>',data,'{strict:true}')).rejects.toThrow(/value/)
    expect(await evaluate('<%= value %>|<%= scope.other %>',data,'{_with:false,localsName:"scope"}')).toBe('first|second')
  })
  it('自定义输出函数与显式同步/异步模式交给官方编译器处理',async()=>{
    const source='<% echo(value); echo("!"); %>'
    expect(await evaluate(source,{value:'echo'},'{outputFunctionName:"echo"}')).toBe(await reference(source,{value:'echo'},{outputFunctionName:'echo'}))
    expect(await evaluate('<%= await Promise.resolve(value) %>',{value:'async'})).toBe('async')
    expect(await evaluate('<%= value %>',{value:'sync'},'{async:false}')).toBe('sync')
    await expect(evaluate('<%= await Promise.resolve(value) %>',{value:'bad'},'{async:false}')).rejects.toThrow(/async|await|compiling/)
  })
  it('生成默认escape保留文本，显式escape和闭包在当前沙箱生效',async()=>{
    expect(await evaluate('<%= value %>|<%- value %>',{value:'<b>&"'})).toBe('<b>&"|<b>&"')
    const source='<%= value %>|<%- value %>',data={value:'<b>'},escape=(value:unknown)=>'escaped('+String(value)+')'
    expect(await evaluate(source,data,'{escape:value=>"escaped("+value+")"}')).toBe(await reference(source,data,{escape}))
    const nested='<%= value %>'
    expect(await render(`<% const prefix='bound:'; print(await evalTemplate(${literal(nested)},{value:'x'},{escape:value=>prefix+value})); %>`)).toBe('bound:x')
  })
  it('嵌套print保持多参数次序，data继承调用上下文且内层输出不串到外层',async()=>{
    const nested='<% print("in:",label); %>'
    const source=`<% print("out:",1,"|"); print(await evalTemplate(${literal(nested)},{label:'nested'})); print("|end"); %>`
    expect(await evaluate(source,{label:'outer'})).toBe('out:1|in:nested|end')
    const inherited='<%= label %>'
    expect(await evaluate(`<%- await evalTemplate(${literal(inherited)}) %>`,{label:'inherited'})).toBe('inherited')
    const defined='<%- helpers.show() %>'
    expect(await render(`<% const suffix='!'; define('helpers',{show:function(){return this.label+suffix}}); print(await evalTemplate(${literal(defined)},{label:'outer'}),'|',await evalTemplate(${literal(defined)},{label:'inner'}),'|',await evalTemplate(${literal(defined)},{helpers:{show:()=> 'override'}})); %>`)).toBe('outer!|inner!|override')
  })
  it('纯沙箱includer返回模板，支持include数据、虚拟路径和嵌套print',async()=>{
    const child='<% print("child",":"); %><%= value %>',source='<%- await include("parts/child",{value:"B"}) %>|<%= value %>'
    expect(await evaluate(source,{value:'A'},`{filename:'/book/start.ejs',includer:(original,parsed)=>({template:${literal(child)},filename:'/virtual/child.ejs'})}`)).toBe('child:B|A')
    const apiChild='<%= char %>|<%= getvar("hp") %>|<%= helpers.show() %>'
    const apiParent=`<% setvar('hp',7); define('helpers',{show:function(){return this.label}}); %><%- await include('child',{label:'included'}) %>`
    expect(await evaluate(apiParent,{label:'parent'},`{includer:()=>({template:${literal(apiChild)}})}`)).toBe('A|7|included')
    expect(await evaluate('<%- include("child",{value:"sync"}) %>',{},`{async:false,includer:()=>({template:${literal('<%= value %>')}})}`)).toBe('sync')
    const absolute='<%- await include("/shared") %>'
    expect(await evaluate(absolute,{},'{includer:(original,parsed)=>({template:original+"|"+parsed})}')).toBe('/shared|/shared.ejs')
    await expect(evaluate('<%- await include("C:/private/data.json") %>')).rejects.toThrow(/include|文件/)
    await expect(evaluate('<%- await include("x") %>',{},'{includer:()=>({filename:"/private/data.json"})}')).rejects.toThrow(/include|文件/)
    await expect(evaluate('<%- await include("x") %>',{},'{includer:async()=>({template:"wrong"})}')).rejects.toThrow(/同步/)
  })
  it('错误选项、恶意escape/includer、超量输出和嵌套递归明确失败',async()=>{
    await expect(evaluate('x',{},'{outputFunctionName:"bad-name"}')).rejects.toThrow(/identifier/)
    await expect(evaluate('x',{},'{localsName:"a.b"}')).rejects.toThrow(/identifier/)
    await expect(evaluate('<%= value %>',{value:'x'},'{escape:()=>{while(true){}}}')).rejects.toThrow(/interrupt|超时/)
    await expect(evaluate('<%- await include("x") %>',{},'{includer:()=>{while(true){}}}')).rejects.toThrow(/interrupt|超时/)
    await expect(evaluate('<%= "x".repeat(1048577) %>')).rejects.toThrow(/1 MiB|memory/)
    const recur='<%- await evalTemplate(next,{next}) %>'
    await expect(evaluate(recur,{next:recur})).rejects.toThrow(/16 层/)
    expect(await evaluate('<%= typeof process %>|<%= typeof require %>|<%= typeof fetch %>')).toBe('undefined|undefined|undefined')
  // 七次独立 worker 启动包含两次刻意耗尽执行预算；保留产品超时，仅为整组断言留出墙钟时间。
  },15_000)
})
