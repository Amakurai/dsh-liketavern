/** 模板资产读取契约：完整角色字段、别名、主世界书和嵌套条目来源，数据读取不会修改冻结资产。 */
import { describe,expect,it } from 'vitest'
import { parseJsonCard } from '../src/state/card.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { templateCardData } from '../src/core/templateAssets.js'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'
import { isolated } from '../src/node/isolated.js'

function context():TemplateContext {
  const card=parseJsonCard({spec:'chara_card_v2',data:{name:'Alice',description:'朋友是 {{user}}',personality:'curious',scenario:'garden',first_mes:'Hello',
    mes_example:'<START>\n{{user}}: Hi\n{{char}}: Yes\n<START>\n{{char}}: Welcome',system_prompt:'stay in character',post_history_instructions:'gentle',
    creator:'Author',creator_notes:'Notes',alternate_greetings:['Good morning'],extensions:{depth_prompt:{prompt:'keep calm',depth:1,role:'system'},custom:{enabled:true}}}})
  return {variables:emptyTemplateScopes(),char:card.name,user:'Bob',card:templateCardData(card),entries:[],presets:[],history:[],now:1000,seed:42,phase:'generate',cardId:'alice-hash'}
}
const render=(text:string,ctx=context())=>isolated('template',{texts:[text],context:ctx})
const book=(source:'character'|'global',sourceRef:string,entries:Record<string,unknown>[])=>parseLorebook({entries},{source,sourceRef})

describe('模板资产兼容',()=> {
  it('完整角色定义包括身份、系统规则、性格、描述、示例与深度提示',async()=> {
    const result=await render('<%- await getchar() %>')
    expect(result.texts[0]).toBe('<Alice>\nSystem: stay in character\nname: Alice\npersonality: curious\ndescription: 朋友是 Bob\nexample:\n```\nBob: Hi\nAlice: Yes\n```\n```\nAlice: Welcome\n```\nSystem: keep calm\n</Alice>')
  })
  it('自定义模板注入角色字段和 data，按当前 cardId/名字/正则查询且别名等价',async()=> {
    const ctx=context()
    ctx.variables.message={format:'<%- name %>|<%- chara_name %>|<%- scenario %>|<%- first_message %>|<%- creator %>|<%- extra %>',greeting:'<%- alternate_greetings[0] %>'}
    const result=await render(`<%- await getchr(characterId,getvar('format'),{extra:42}) %>|<%- await getChara(/Alice/,getvar('greeting')) %>|<%- await getchar('other') %>|<%- await getCharData('other') %>`,ctx)
    expect(result.texts).toEqual(['Alice|Alice|garden|Hello|Author|42|Good morning||'])
  })
  it('getCharData 返回根字段及 data 的独立快照，不泄漏 PNG/raw，修改副本不影响后续读取',async()=> {
    const ctx=context()
    expect(ctx.card).not.toHaveProperty('raw')
    expect(ctx.card).not.toHaveProperty('pngBytes')
    const result=await render(`<% const value=await getCharaData(); value.data.creator='changed'; %><%- JSON.stringify([value.name,(await getCharData(characterId)).data.creator,(await getCharData()).data.extensions.custom]) %>`,ctx)
    expect(JSON.parse(result.texts[0]!)).toEqual(['Alice','Author',{enabled:true}])
  })
  it('省略库名读取主世界书，显式库名可读绑定库，嵌套 getwi 跟随当前条目来源',async()=> {
    const ctx=context()
    ctx.entries=[...book('global','global',[
      {uid:1,comment:'same',content:'GLOBAL'},
      {uid:2,comment:'parent',content:'<%- world_info.world %>/<%- await getwi("same") %>/<%- extra %>'},
    ]),...book('character','primary',[{uid:1,comment:'same',content:'PRIMARY {{char}}'}])]
    const result=await render('<%- await getwi("same") %>|<%- await getWorldInfo("global","parent",{extra:5}) %>|<%- await getwi("missing","same") %>',ctx)
    expect(result.texts).toEqual(['PRIMARY Alice|global/GLOBAL/5|'])
    const active=await render('<%- (await activewi("same")).world %>',ctx)
    expect(active.texts).toEqual(['primary'])
  })
  it('没有主世界书时不退回任意库；显式读取禁用条目不改变其启用状态',async()=> {
    const ctx=context()
    ctx.entries=book('global','global',[{uid:1,comment:'same',disable:true,content:'DATA'}])
    expect((await render('<%- await getwi("same") %>|<%- await getwi("global",1) %>|<%- await activewi("same") %>',ctx)).texts).toEqual(['|DATA|'])
    expect(ctx.entries[0]!.enabled).toBe(false)
  })
  it('RENDER 与预加载条目提供自身 world_info，嵌套读取不会误用主书同名条目',async()=> {
    const ctx=context()
    ctx.entries=[...book('character','primary',[{uid:1,comment:'same',content:'PRIMARY'}]),...book('global','extra',[
      {uid:1,comment:'same',content:'EXTRA'},
      {uid:2,comment:'[RENDER:BEFORE]',content:'<%- world_info.world %>/<%- await getwi("same") %>'},
      {uid:3,comment:'setup',content:'@@only_preload\n<% define("preloadBook",world_info.world) %>'},
    ])]
    const result=await isolated('template',{texts:['<%- preloadBook %>'],decorateOutput:true,context:{...ctx,phase:'render'}})
    expect(result.texts).toEqual(['extra/EXTRA\nextra'])
  })
  it('预设缩写与公开名字等价',async()=> {
    const ctx=context();ctx.presets=[{identifier:'main',name:'Main',content:'<%- value %> {{user}}'}]
    expect((await render('<%- await getprp("main",{value:7}) %>|<%- await getPresetPrompt("Main",{value:8}) %>',ctx)).texts).toEqual(['7 Bob|8 Bob'])
  })
  it('资产嵌套模板按自己的 data 重绑定义，显式覆盖不被继承定义替换',async()=> {
    const ctx=context()
    ctx.entries=book('character','primary',[{uid:1,comment:'read',content:'<%- helpers.label() %>'}])
    ctx.presets=[{identifier:'main',name:'Main',content:'<%- helpers.label() %>'}]
    ctx.variables.message={format:'<%- helpers.label() %>'}
    const result=await render(`<% define('helpers.label',function(){return this.suffix+'!'+this.char}); %><%- await getwi('read',{suffix:'wi'}) %>|<%- await getpreset('main',{suffix:'preset'}) %>|<%- await getchar(undefined,getvar('format'),{suffix:'card'}) %>|<%- await getwi('read',{helpers:{label:()=> 'explicit'}}) %>`,ctx)
    expect(result.texts).toEqual(['wi!Alice|preset!Alice|card!Alice|explicit'])
  })
})
