/** 重放结构共享的容量与恢复边界：千次非前缀历史/消息快照只新增变动页，并拒绝拓扑损坏和展开炸弹。 */
import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { TemplateReplayJsonWriter,templateReplaySharedReader } from '../src/core/templateReplayShared.js'
import { measureTemplateReplayWork,parseTemplateReplayShared,templateReplayData,type TemplateReplay,type TemplateReplayShared } from '../src/core/templateReplay.js'
import { emptyTemplateScopes } from '../src/core/template.js'

const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const fixture=()=> {
  const shared:TemplateReplayShared[]=[]
  return {shared,writer:new TemplateReplayJsonWriter(shared,digest,()=>{})}
}

describe('有序 JSON 分页共享',()=> {
  it('一千轮消息快照追加与非前缀历史仅新增变化页，旧快照及原对象键序逐字节恢复',()=> {
    const {shared,writer}=fixture(),snapshots:Record<string,unknown>={}
    const history=Array.from({length:150},(_,index)=>({role:'assistant',content:`消息 ${index} `+'正文'.repeat(400)}))
    const samples:Array<{ref:number;json:string}>=[]
    let inlineChars=0
    for(let turn=0;turn<1000;turn++) {
      snapshots['m'+String(turn).padStart(4,'0')]={values:{note:'消息变量'.repeat(128),turn},initialized:true}
      const value={messageVariables:{version:1,snapshots},generateData:[{role:'system',content:'本轮变化提示词 '+turn},...history]}
      const json=JSON.stringify(value),ref=writer.write(value,json)
      inlineChars+=json.length
      if(turn===0 || turn===63 || turn===500 || turn===999) samples.push({ref,json})
    }
    const bytes=JSON.stringify(shared).length
    expect(bytes).toBeLessThan(inlineChars/50)
    const reader=templateReplaySharedReader(parseTemplateReplayShared(JSON.parse(JSON.stringify(shared))))
    for(const {ref,json} of samples) {
      expect(JSON.stringify(reader.expand(ref))).toBe(json)
      expect(reader.sizes[ref]).toBe(json.length)
    }
    // 冷恢复后的写入仍复用旧节点，而不是每次从空索引再写一套。
    const restored=new TemplateReplayJsonWriter(shared,digest,()=>{}),count=shared.length
    expect(restored.write(JSON.parse(samples.at(-1)!.json))).toBe(samples.at(-1)!.ref)
    expect(shared.length).toBe(count)
  },30000)

  it('分页对象保留插入顺序、整数键序、空值和 JSON 转义，不把键排序当作相等',()=> {
    const {shared,writer}=fixture()
    const value=Object.fromEntries(Array.from({length:145},(_,index)=>['key-'+index,{b:'\\"\n😀'+index,a:null}]))
    Object.assign(value,{'10':{a:1},'2':{a:2}})
    const first=writer.write(value),json=JSON.stringify(value)
    const reversed=Object.fromEntries(Object.entries(value).reverse()),second=writer.write(reversed)
    const reader=templateReplaySharedReader(shared)
    expect(JSON.stringify(reader.expand(first))).toBe(json)
    expect(JSON.stringify(reader.expand(second))).toBe(JSON.stringify(reversed))
    expect(first).not.toBe(second)
  })

  it('按随机消息 ID 排序插入时由键决定页边界，不让插入位置之后的所有页移动',()=> {
    const {shared,writer}=fixture(),entries=Array.from({length:1024},(_,index)=>[digest('original-'+index),{text:'快照'.repeat(200)}] as const)
    writer.write(Object.fromEntries([...entries].sort(([a],[b])=>a.localeCompare(b))))
    const initial=JSON.stringify(shared).length
    let latest=0,expected=''
    for(let index=0;index<150;index++) {
      entries.push([digest('inserted-'+index),{text:'快照'.repeat(200)}])
      const value=Object.fromEntries([...entries].sort(([a],[b])=>a.localeCompare(b)))
      expected=JSON.stringify(value);latest=writer.write(value,expected)
    }
    expect(JSON.stringify(shared).length-initial).toBeLessThan(700_000)
    expect(JSON.stringify(templateReplaySharedReader(shared).expand(latest))).toBe(expected)
  },15000)

  it.each([
    ['前向引用',[{jsonArray:[1]},{value:'later'}]],
    ['自引用',[{jsonArray:[0]}]],
    ['重复键',[{value:0},{jsonObject:[['x',0],['x',0]]}]],
    ['禁止原型键',[{value:0},{jsonObject:[['__proto__',0]]}]],
    ['分页重复键',[{value:0},{jsonObject:[['x',0]]},{jsonObjectPages:[1,1]}]],
    ['分页类型',[{value:0},{jsonArray:[0]},{jsonObjectPages:[1,1]}]],
    ['空分页',[{jsonArray:[]},{jsonArrayPages:[0,0]}]],
    ['前缀被作为子树',[{text:['a']},{jsonArray:[0]}]],
    ['未知形状',[{jsonMissing:[]}]],
  ])('拒绝%s',(_label,shared)=> {
    expect(()=>parseTemplateReplayShared(shared)).toThrow()
  })

  it('很小的恶意图不能指数展开超大对象或隐藏超过限制的逻辑深度',()=> {
    const repeated:TemplateReplayShared[]=[{value:'x'.repeat(1000)}]
    for(let index=1;index<28;index++) repeated.push({jsonArray:[index-1,index-1]})
    expect(()=>parseTemplateReplayShared(repeated)).toThrow(/展开容量/)
    const nested:TemplateReplayShared[]=[{value:0}]
    for(let index=1;index<70;index++) nested.push({jsonArray:[index-1]})
    expect(()=>parseTemplateReplayShared(nested)).toThrow(/展开容量/)
  })

  it('压缩引用按逻辑展开量授予重放预算，入参恢复保持原字段顺序',()=> {
    const {shared,writer}=fixture(),value=Array.from({length:1000},()=>({text:'abc'.repeat(500)}))
    const ref=writer.write(value),hash='0'.repeat(64)
    const replay:TemplateReplay={version:2,formatterVersion:2,context:{variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1,seed:1,phase:'generate'},
      variables:emptyTemplateScopes(),messageVariablesHash:hash,shared,operations:[{kind:'render',text:'',data:{before:1,large:null,after:2},refs:{large:ref},hash}]}
    expect(JSON.stringify(replay).length).toBeLessThan(20_000)
    expect(measureTemplateReplayWork(replay)).toBeGreaterThan(JSON.stringify(value).length)
    expect(JSON.stringify(templateReplayData(replay)(replay.operations[0] as Extract<TemplateReplay['operations'][number],{kind:'render'}>)))
      .toBe(JSON.stringify({before:1,large:value,after:2}))
  })

  it('多个各自合法的图合计超过一次调用容量时，在分配展开对象前拒绝',()=> {
    const shared:TemplateReplayShared[]=[{value:'x'.repeat(1024)},{jsonArray:Array(64).fill(0)},
      {jsonArray:Array(64).fill(1)},{jsonArray:Array(16).fill(2)}]
    expect(()=>parseTemplateReplayShared(shared)).not.toThrow()
    const operation={kind:'render' as const,text:'',data:{first:null,second:null},refs:{first:3,second:3},hash:'0'.repeat(64)}
    const expand=templateReplayData({shared,operations:[operation]})
    expect(()=>expand(operation)).toThrow(/操作超过展开容量/)
  })
})
