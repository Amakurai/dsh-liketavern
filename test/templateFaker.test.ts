/** 将真实 Faker 官方结果与隔离模板逐项对照，覆盖语言回退、完整模块、种子时钟、构造器和恶意回调边界。 */
import { describe,expect,it } from 'vitest'
import * as official from '@faker-js/faker'
import type { Faker } from '@faker-js/faker'
import { isolated } from '../src/node/isolated.js'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'

const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1735689600000,seed:31415,phase:'generate',...patch})
const render=async(text:string,patch:Partial<TemplateContext>={})=>(await isolated('template',{context:context(patch),texts:[text]})).texts[0]!
const sampleFaker=(f:Faker)=>[
  f.airline.airport(),f.animal.cat(),f.book.title(),f.color.rgb(),f.commerce.product(),f.company.name(),
  f.database.type(),f.datatype.boolean(),f.date.future().toISOString(),f.finance.accountNumber(),f.food.dish(),
  f.git.commitSha(),f.hacker.phrase(),f.helpers.shuffle(['a','b','c']),f.image.url(),
  f.internet.email(),f.location.city(),f.lorem.sentence(),f.music.genre(),f.number.int({min:-100,max:100}),
  f.person.fullName(),f.phone.number(),f.science.chemicalElement(),f.string.uuid(),f.system.mimeType(),
  f.vehicle.vehicle(),f.word.noun(),
]

describe('Faker 完整库兼容',()=>{
  it('保留全部 namespace 导出与 77 种语言，各区域的回退数据与官方一致',async()=>{
    expect(JSON.parse(await render('<%- JSON.stringify(Object.keys(faker).sort()) %>'))).toEqual(Object.keys(official).sort())
    const metadata=JSON.parse(await render('<%- JSON.stringify(Object.fromEntries(Object.keys(faker.allFakers).map(code=>[code,faker.allFakers[code].getMetadata()]))) %>'))
    expect(metadata).toEqual(Object.fromEntries(Object.entries(official.allFakers).map(([code,f])=>[code,f.getMetadata()])))
    expect(JSON.parse(await render('<%- JSON.stringify([faker.faker===faker.fakerEN,faker.allFakers.en===faker.fakerEN,faker.allLocales.zh_CN===faker.zh_CN,faker.fakerEN_AU_ocker.rawDefinitions.location.country]) %>')))
      .toEqual([true,true,true,official.fakerEN_AU_ocker.rawDefinitions.location.country])
  })
  it('27 个公开数据模块在真实 QuickJS 中产生与官方完全相同的英文和中文结果',async()=>{
    for(const code of ['en','zh_CN'] as const){
      const instance=official.allFakers[code]
      instance.seed(context().seed);instance.setDefaultRefDate(context().now)
      const result=JSON.parse(await render(`<% const sample=${sampleFaker.toString()}; %><%- JSON.stringify(sample(faker.allFakers[${JSON.stringify(code)}])) %>`))
      expect(result).toEqual(sampleFaker(instance))
    }
  })
  it('默认种子、日期和跨模板调用确定；不同轮种子产生不同结果',async()=>{
    const script='<%- JSON.stringify([faker.fakerEN.person.fullName(),faker.fakerZH_CN.person.fullName(),faker.fakerEN.date.soon().getTime(),faker.simpleFaker.string.uuid()]) %>'
    const first=await render(script)
    expect(await render(script)).toBe(first)
    expect(await render(script,{seed:27182})).not.toBe(first)
    const dates=JSON.parse(first) as [string,string,number,string]
    expect(dates[2]).toBeGreaterThan(context().now)
    expect(dates[2]).toBeLessThanOrEqual(context().now+86400000)
    const sequential=await isolated('template',{context:context(),texts:['<%- faker.fakerEN.number.int() %>','<%- faker.fakerEN.number.int() %>']})
    const f=official.fakerEN;f.seed(context().seed)
    expect(sequential.texts).toEqual([String(f.number.int()),String(f.number.int())])
  })
  it('公开构造器、自定义 locale、显式重置种子和参考日期继续使用真实 API',async()=>{
    const script=`<%
      const f=new faker.Faker({locale:[{person:{first_name:{generic:['唯一姓名']}}},faker.zh_CN,faker.en,faker.base]});
      f.seed([42,17]);f.setDefaultRefDate('2001-01-01T00:00:00Z');
      const first=[f.person.firstName(),f.person.lastName(),f.date.past().toISOString()];
      f.seed([42,17]);
      print(JSON.stringify([first,[f.person.firstName(),f.person.lastName(),f.date.past().toISOString()]]));
    %>`
    const result=JSON.parse(await render(script)) as unknown[][]
    expect(result[0]).toEqual(result[1])
    expect(result[0]![0]).toBe('唯一姓名')
    const f=new official.Faker({locale:[{person:{first_name:{generic:['唯一姓名']}}},official.zh_CN,official.en,official.base]})
    f.seed([42,17]);f.setDefaultRefDate('2001-01-01T00:00:00Z')
    expect(result[0]).toEqual([f.person.firstName(),f.person.lastName(),f.date.past().toISOString()])
  })
  it('JWT 的中文、补充平面字符和不配对代理项以标准 UTF-8 编码，编码器不暴露宿主权限',async()=>{
    const payload={name:'中文😀',invalid:'\ud800'}
    const f=official.fakerEN;f.seed(context().seed)
    expect(await render(`<%- faker.fakerEN.internet.jwt({payload:${JSON.stringify(payload)}}) %>`)).toBe(f.internet.jwt({payload}))
    expect(JSON.parse(await render('<%- JSON.stringify([typeof Buffer,typeof process,typeof require,typeof fetch,faker.Faker.constructor("return typeof process")()]) %>')))
      .toEqual(['undefined','undefined','undefined','undefined','undefined'])
  })
  it('用户自定义随机源仍在隔离 worker 中运行，无限循环明确失败',async()=>{
    await expect(render('<% const f=new faker.Faker({locale:[faker.en],randomizer:{seed(){},next(){while(true){}}}}); f.number.int(); %>'))
      .rejects.toThrow(/interrupt|超时/)
  })
})
