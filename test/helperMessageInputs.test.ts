/** 消息读写往返契约：当前页/旧别名更新产生实际规范字段，不支持的页与属性变化整批拒绝。 */
import {expect,it} from 'vitest'
import {normalizeHelperMessageInputs} from '../src/core/helperMessageInputs.js'
const view={message_id:0,name:'灯塔',role:'assistant',is_hidden:false,message:'old',data:{hp:1},extra:{tag:'old'},mes:'old',is_user:false,is_system:false,swipe_id:0,swipes:['old','alternate'],swipes_data:[{hp:1},{}],swipes_info:[{tag:'old'},{}]}
const normalize=(rows:unknown)=>normalizeHelperMessageInputs(rows,id=>id===0||id===-1?structuredClone(view):undefined)
it('完整返回对象可往返，当前页正文、变量和 extra 分别选取有变化的表示',()=>{
  expect(normalize([{...view,data:{hp:2}}])).toMatchObject([{message_id:0,message:'old',data:{hp:2},extra:{tag:'old'}}])
  expect(normalize([{...view,swipes:['new','alternate'],swipes_data:[{hp:3},{}],swipes_info:[{tag:'new'},{}]}])).toMatchObject([{message_id:0,message:'new',data:{hp:3},extra:{tag:'new'}}])
  expect(normalize([{message_id:-1,mes:'legacy new'}])).toMatchObject([{message_id:-1,message:'legacy new'}])
  expect(view.data).toEqual({hp:1})
})
it('完整对象中两种不同新值拒绝；一致新值及顺序不同但等值对象允许',()=>{
  expect(()=>normalize([{...view,message:'one',swipes:['two','alternate']}])).toThrow(/冲突/)
  expect(()=>normalize([{...view,data:{hp:2},swipes_data:[{hp:3},{}]}])).toThrow(/冲突/)
  expect(normalize([{...view,message:'new',mes:'new',swipes:['new','alternate']}])[0]?.message).toBe('new')
  expect(normalize([{message_id:0,data:{a:1,b:2},swipes_data:[{b:2,a:1},{}]}])[0]?.data).toEqual({a:1,b:2})
})
it('只读属性变化仍明确拒绝，保持原值的属性允许往返',()=>{
  for(const row of [{...view,name:'other'},{...view,role:'user'},{...view,is_hidden:true},{...view,is_user:true},{...view,is_system:true}])expect(()=>normalize([row])).toThrow(/不支持/)
  expect(normalize([{message_id:0,name:'灯塔',role:'assistant',is_hidden:false}])).toEqual([])
})
it('空值、访问器、畸形数组、未知字段、别名重复目标和越界在请求之前拒绝',()=>{
  const getter={message_id:0,get data(){throw Error('getter ran')}}
  expect(()=>normalize([getter])).toThrow(/非法字段/)
  for(const rows of [[{...view,data:null}],[{message_id:0,extra:[]}],[{message_id:0,message:''}],[{message_id:0,swipes_data:[,{}]}],[{message_id:0,unknown:1}],[{message_id:0,message:'new'},{message_id:-1,message:'new'}],[{message_id:99,message:'new'}]])expect(()=>normalize(rows)).toThrow()
  expect(normalize([{message_id:0}])).toEqual([])
})

it('新增、修改未选中页和切换完整对象时，旧当前页字段不会覆盖新选中页',()=>{
  const added=normalize([{...view,swipes:['old','changed','third'],swipes_data:[{hp:1},{hp:8},{hp:9}],swipes_info:[{tag:'old'},{tag:'second'},{}]}])[0]!
  expect(added.pages).toEqual({active:0,pages:[{message:'old',data:{hp:1},extra:{tag:'old'}},{message:'changed',data:{hp:8},extra:{tag:'second'}},{message:'third',data:{hp:9},extra:{}}]})
  const switched=normalize([{...view,swipe_id:1}])[0]!
  expect(switched).toMatchObject({message:'alternate',data:{},extra:{},pages:{active:1}})
  expect(switched.pages?.pages[0]).toEqual({message:'old',data:{hp:1},extra:{tag:'old'}})
  const shrunk=normalize([{message_id:0,swipes:['only']}])[0]!
  expect(shrunk.pages?.pages).toHaveLength(1);expect(shrunk.message).toBe('only')
})
it('无正文的新页、空页集合、坏选中下标和超限页集合明确失败',()=>{
  for(const row of [{message_id:0,swipes:[]},{message_id:0,swipes:['old','']},{message_id:0,swipe_id:-1},{message_id:0,swipe_id:9},{message_id:0,swipes_data:[{},{},{}]},{message_id:0,swipes:Array.from({length:65},()=> 'text')}])expect(()=>normalize([row])).toThrow()
})

it('切页时部分参数显式指定旧当前页同值仍会覆盖新页，完整读回对象则保留目标页数据',()=>{
  expect(normalize([{message_id:0,swipe_id:1,data:{hp:1}}])[0]?.data).toEqual({hp:1})
  expect(normalize([{...view,swipe_id:1}])[0]?.data).toEqual({})
  expect(()=>normalize([{message_id:0,swipes_data:[null,{}]}])).toThrow(/普通 JSON 对象/)
  expect(()=>normalize([{message_id:0,swipes_info:[{},null]}])).toThrow(/普通 JSON 对象/)
})
