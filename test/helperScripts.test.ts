/** 脚本资产兼容测试：新旧格式、文件夹开关、脚本身份、失败预算及模块正文转义。 */
import {expect,it} from 'vitest'
import {characterHelperScripts,enabledHelperScripts,parseHelperScriptTrees,importHelperScriptFile,exportHelperScriptTrees} from '../src/core/helperScripts.js'
import {helperScriptHtml,isNativeMvuFramework} from '../src/core/cardScript.js'

it('现代角色卡与键值对设置保留脚本正文、数据和按钮，文件夹开关决定运行集',()=>{
  const trees=[{type:'folder',id:'folder',enabled:false,scripts:[{id:'s',enabled:true,content:'window.ran=true',data:{n:1},button:{buttons:[{name:'执行',visible:true}]}}]},
    {type:'script',id:'standalone',enabled:true,content:'await Promise.resolve()'}]
  const parsed=characterHelperScripts({tavern_helper:[['scripts',trees]]})
  expect(enabledHelperScripts(parsed).map(script=>script.id)).toEqual(['standalone'])
  expect(parsed[0]).toMatchObject({scripts:[{content:'window.ran=true',data:{n:1},button:{enabled:true,buttons:[{name:'执行',visible:true}]}}]})
  expect(characterHelperScripts({tavern_helper:{scripts:trees}})).toEqual(parsed)
})
it('旧版 value 包装和按钮迁移，缺省 ID 按位置稳定且不会执行正文',()=>{
  const extensions={TavernHelper_scripts:[{type:'script',value:{enabled:true,name:'旧脚本',content:'throw Error("不执行")',buttons:[{name:'开始',visible:true}]}},
    {type:'folder',id:'old-folder',value:[{id:'child',enabled:true,content:'x()'}]}]}
  const parsed=characterHelperScripts(extensions)
  expect(parsed).toEqual(characterHelperScripts(extensions))
  expect(enabledHelperScripts(parsed).map(script=>script.id)).toEqual(['imported-0','child'])
  expect(parsed[0]).toMatchObject({button:{buttons:[{name:'开始',visible:true}]}})
})
it('非法和超预算脚本明确失败，不截断或悄悄丢弃',()=>{
  expect(()=>parseHelperScriptTrees([{id:'same'},{id:'same'}])).toThrow(/重复/)
  expect(()=>parseHelperScriptTrees([{content:'x'.repeat(256*1024+1)}])).toThrow(/预算/)
  expect(()=>parseHelperScriptTrees([{enabled:'true'}])).toThrow(/布尔/)
  expect(()=>parseHelperScriptTrees([{type:'folder',scripts:[{type:'folder',scripts:[]}]}])).toThrow(/嵌套/)
  expect(()=>characterHelperScripts({tavern_helper:[['__proto__',{}]]})).toThrow(/无效/)
  expect(()=>parseHelperScriptTrees([{button:{buttons:[{name:'x'},{name:'x'}]}}])).toThrow(/重复/)
})
it('模块正文的结束标签被 JSON 编码，保留模块语法而不注入主文档元素',()=>{
  const html=helperScriptHtml('import "https://example.invalid/script.js"; const html="</script><img>"; await Promise.resolve()')
  expect(html.match(/<\/script>/g)).toHaveLength(1)
  expect(html).toContain("type='module'")
  expect(html).toContain('\\u003c/script>')
  expect(html).not.toContain('<img>')
})
it('脚本文件导入识别单脚本和脚本库，导出遵守数据及按钮排除设置',()=>{
  expect(()=>importHelperScriptFile({unrelated:true})).toThrow(/不是/)
  const trees=importHelperScriptFile({scripts:[{id:'s',content:'x()',data:{privateValue:'excluded'},button:{buttons:[{name:'hidden export',visible:true}]},export_with:{data:false,button:false}}]})
  expect(importHelperScriptFile(trees[0])).toEqual(trees)
  const exported=exportHelperScriptTrees(trees)
  expect(JSON.stringify(exported)).not.toContain('excluded')
  expect(JSON.stringify(exported)).not.toContain('hidden export')
  expect(importHelperScriptFile(exported)[0]).toMatchObject({content:'x()',data:{},button:{buttons:[]}})
  expect(trees[0]).toMatchObject({data:{privateValue:'excluded'}})
})

it('仅纯官方 MVU 导入接管为原生框架，自定义代码和伪造地址不改写',()=>{
  const entry="import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';"
  expect(isNativeMvuFramework(entry)).toBe(true)
  expect(helperScriptHtml(entry)).toContain("waitGlobalInitialized('Mvu')")
  for(const code of [entry+' customRule()',entry.replace('testingcf.jsdelivr.net','attacker.invalid'),entry.replace('bundle.js','bundle.js?variant=1'),'// customized\n'+entry]){
    expect(isNativeMvuFramework(code)).toBe(false)
    expect(helperScriptHtml(code)).toContain('bundle.js')
  }
})
