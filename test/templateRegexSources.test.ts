/** 来源映射正则与原生 replace 对照；覆盖捕获、零宽 Unicode、回调缓存身份、重注册和明确失败上限。 */
import {describe,expect,it} from 'vitest'
import {emptyTemplateScopes,type TemplateContext} from '../src/core/template.js'
import {isolated} from '../src/node/isolated.js'
import type {TemplateRegexSource} from '../src/node/templateRegexSources.js'

const context=():TemplateContext=>({variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],now:1000,seed:42,phase:'generate'})
const call=(parts:TemplateRegexSource[],namespace='test')=>`__applyTemporaryRegexSources(${JSON.stringify(parts)},'generate',{role:'system',worldinfo:true,depth:0},${JSON.stringify(namespace)}).map(part=>part.text).join('')`

describe('全文正则来源映射',()=> {
  it('跨段命名/数字捕获与完整替换符保持原生字符串语义',async()=> {
    const parts=[{key:'a',text:'[alpha',start:0},{key:'join',text:'\n',start:0},{key:'b',text:'beta]',start:0}]
    const source=parts.map(part=>part.text).join(''),pattern='(?<first>alpha)\\s+(beta)(z)?'
    const replacements=['$&|$1|$2|$3|$<first>|$<missing>','$$|$0|$01|$10|$12|$99',"$`-$&-$'",'$<unterminated']
    const result=await isolated('template',{context:context(),texts:replacements.map((replacement,index)=>
      `<% activateRegex(new RegExp(${JSON.stringify(pattern)},'g'),${JSON.stringify(replacement)},{uuid:'same',generate:true,worldinfo:true}); %><%- ${call(parts,'case'+index)} %>` )})
    expect(result.texts).toEqual(replacements.map(replacement=>source.replace(new RegExp(pattern,'g'),replacement)))
  })

  it('零宽 Unicode 全局匹配、lookahead 和多条规则顺序与原生一致',async()=> {
    const parts=[{key:'a',text:'😀a',start:0},{key:'b',text:'b',start:0}],source='😀ab'
    const patterns=[['(?:)','gu'],['(?=a|b)','g'],['(a)(b)','']]
    const result=await isolated('template',{context:context(),texts:patterns.map(([pattern,flags])=>
      `<% activateRegex(new RegExp(${JSON.stringify(pattern)},${JSON.stringify(flags)}),'[$1]',{uuid:'same',generate:true,worldinfo:true}); %><%- ${call(parts)} %>` )})
    expect(result.texts).toEqual(patterns.map(([pattern,flags])=>source.replace(new RegExp(pattern!,flags),'[$1]')))
  })

  it('新增前文只执行新匹配，既有匹配回放首次回调；同 uuid 重注册会建立新匹配',async()=> {
    const old=[{key:'a',text:'foo',start:0},{key:'join',text:'\n',start:0},{key:'b',text:'bar',start:0}]
    const expanded=[{key:'new',text:'foo\nbar|',start:0},...old]
    const result=await isolated('template',{context:context(),texts:[
      `<% activateRegex(/foo\\nbar/g,()=>incvar('calls'),{uuid:'same',generate:true,worldinfo:true}); %><%- ${call(old)} %>`,
      `<%- ${call(expanded)} %>`,
      `<% activateRegex(/foo\\nbar/g,()=>incvar('calls'),{uuid:'same',generate:true,worldinfo:true}); %><%- ${call(old)} %>`,
      `<% __beginTemplateGeneration(); %><%- ${call(old)} %>`,
    ]})
    expect(result.texts).toEqual(['1','2|1','3','4'])
    expect(result.variables.message.calls).toBe(4)
  })

  it('错误来源、过多零宽匹配、异步回调和扩张输出明确失败',async()=> {
    await expect(isolated('template',{context:context(),texts:[`<%- ${call([{key:'bad',text:'x',start:-1}])} %>`]})).rejects.toThrow(/来源/)
    await expect(isolated('template',{context:context(),texts:[`<% activateRegex(/(?:)/g,'x',{generate:true,worldinfo:true}) %><%- ${call([{key:'a',text:'x'.repeat(4100),start:0}])} %>`]})).rejects.toThrow(/4096/)
    await expect(isolated('template',{context:context(),texts:[`<% activateRegex(/x/g,async()=>"y",{generate:true,worldinfo:true}) %><%- ${call([{key:'a',text:'x',start:0}])} %>`]})).rejects.toThrow(/同步/)
    await expect(isolated('template',{context:context(),texts:[`<% activateRegex(/x/g,()=>"y".repeat(1100000),{generate:true,worldinfo:true}) %><%- ${call([{key:'a',text:'x',start:0}])} %>`]})).rejects.toThrow(/1 MiB/)
  })
})
