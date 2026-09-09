/** 旧设置与原生设置对应、有界输入和宿主 JSON 边界；不执行第三方回调。 */
import {expect,it} from 'vitest'
import {helperWorldbookSettingsCodec as codec} from '../src/core/helperWorldbookSettings.js'
import {DEFAULT_WI_SETTINGS} from '../src/core/types.js'
import {parseSessionBinding} from '../src/node/bindings.js'
it('完整默认值双向对应，部分覆盖不填入其它全局默认值',()=>{
  const legacy=codec.fromNative(DEFAULT_WI_SETTINGS,['book'])
  expect(legacy).toMatchObject({selected_global_lorebooks:['book'],scan_depth:2,min_activations:0,max_depth:0,insertion_strategy:'character_first'})
  expect(codec.toNative(legacy)).toEqual(DEFAULT_WI_SETTINGS)
  expect(codec.toNative({scan_depth:4,insertion_strategy:'global_first'})).toEqual({scanDepth:4,characterStrategy:2})
})
it('错误字段、范围、函数、访问器与稀疏选择整批拒绝，不运行 getter',()=>{
  for(const input of [{unknown:1},{scan_depth:-1},{scan_depth:1.5},{max_depth:1001},{min_activations:2001},{budget_cap:Infinity},{recursive:'true'},{insertion_strategy:'other'},{selected_global_lorebooks:new Array(1)},{get scan_depth(){throw Error('getter executed')}}])expect(()=>codec.patch(input)).toThrow()
  expect(()=>codec.patch({get scan_depth(){throw Error('getter executed')}})).toThrow(/非法字段/)
  expect(()=>codec.nativePatch({characterStrategy:5})).toThrow()
  expect(()=>codec.nativePatch({bad:true})).toThrow()
})
it('会话绑定只保留校验后的部分覆盖，旧文件不被写入新默认值',()=>{
  const binding={sessionId:'s',cardId:'test-card',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'now'}
  expect(parseSessionBinding(binding).worldInfo).toBeUndefined()
  expect(parseSessionBinding({...binding,worldInfo:{scanDepth:0,minActivations:2}}).worldInfo).toEqual({scanDepth:0,minActivations:2})
  expect(()=>parseSessionBinding({...binding,worldInfo:{scanDepth:1001}})).toThrow()
})
