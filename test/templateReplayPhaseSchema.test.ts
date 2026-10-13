/** 压缩阶段上下文的存储边界：保持旧日志与紧凑引用，提前拒绝不完整上下文、不可见消息和绑定错位。 */
import { describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { templateReplayData, templateReplayGenerationContext } from '../src/core/templateReplay.js'
import { parseTemplateGeneration, parseTemplateReplay, templateGenerationContext } from '../src/state/templateGeneration.js'

const hash='0'.repeat(64)
const initial=():TemplateContext=>({variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],now:1,seed:7,
  phase:'generate',sessionId:'session-a',cardId:'card-a'})
const replay=(operations:unknown[],shared:unknown[]=[])=>({version:2,formatterVersion:2,context:initial(),operations,shared,
  variables:emptyTemplateScopes(),messageVariablesHash:hash})
const phase=(patch:Record<string,unknown>={},refs:Record<string,unknown>={})=>({kind:'phaseData',
  data:{...initial(),phase:'render',now:2,...patch},refs,refreshPreload:false,hash})
const messages=[{role:'user',content:'甲'},{role:'assistant',content:'乙'}]
const identities=[{messageId:'u1',swipeId:0},{messageId:'a1',swipeId:0}]
const shared=[{array:messages},{array:identities}]
const historyRefs={history:[0,2],historyIdentities:[1,2]}
const sharedPhase=(patch:Record<string,unknown>={})=>phase({history:null,historyIdentities:null,...patch},historyRefs)
const prepared=(value:unknown)=>({version:1,status:'prepared',sessionId:'session-a',cardId:'card-a',storyId:'story-00000000-0000-0000-0000-000000000000',turn:2,
  floor:'session-a#t2',replay:value,plan:{standingKey:'test',standing:'',turnContext:'',messages:[],history:[],logLines:[],
    userName:'Bob',personaDescription:'',personaLorebookId:null,wiBudget:{limit:1000,used:0,overflowed:false},
    sampling:{temperature:1,topP:1,maxTokens:null,stop:[],presencePenalty:0,frequencyPenalty:0,thinking:'disabled'},
    assembleLog:[],stats:{tokensBefore:0,tokensAfter:0,trimmedSections:[]}}})

describe('压缩阶段上下文校验',()=> {
  it('逐条展开不同历史前缀并验证，返回日志仍保留占位和引用',()=> {
    const operations=[phase({history:null,historyIdentities:null},{history:[0,1],historyIdentities:[1,1]}),
      sharedPhase({phase:'generate',now:3,messageVariables:{version:1,snapshots:{a1:{values:{seen:true},initialized:true}}}})]
    const raw=replay(operations,shared),parsed=parseTemplateReplay(JSON.parse(JSON.stringify(raw)))
    expect(parsed).toEqual(raw)
    expect(JSON.stringify(parsed.operations)).toBe(JSON.stringify(operations))
    const data=templateReplayData(parsed),first=parsed.operations[0]!,second=parsed.operations[1]!
    if(first.kind!=='phaseData' || second.kind!=='phaseData') throw new Error('工厂阶段类型错误')
    expect(data(first).history).toEqual(messages.slice(0,1))
    expect(data(second).history).toEqual(messages)
    expect(first.data.history).toBeNull()
    expect(templateReplayGenerationContext(parsed)).toMatchObject({phase:'generate',now:3,history:messages})
  })

  it('旧 phase 与新 phaseData 混合时仍选择最近生成上下文，最后 render 不覆盖它',()=> {
    const old={kind:'phase',context:{...initial(),now:2},refreshPreload:true,hash}
    const source=replay([old,phase({phase:'generate',now:3}),phase({phase:'render',now:4})])
    const parsed=parseTemplateReplay(source)
    expect(parsed.operations[0]).toEqual(old)
    expect(templateReplayGenerationContext(parsed).now).toBe(3)
    expect(parseTemplateReplay(replay([old])).operations).toEqual([old])
  })

  it.each([
    ['未知上下文字段',{extra:'unexpected'}],
    ['缺少有限时钟',{now:null}],
    ['错误阶段',{phase:'other'}],
    ['缺少变量作用域',{variables:{global:{},local:{}}}],
    ['无效头像地址',{charAvatar:'javascript:alert(1)'}],
  ])('在存储边界拒绝%s',(_name,patch)=> {
    expect(()=>parseTemplateReplay(replay([phase(patch)]))).toThrow()
  })

  it('共享数组里的消息形状与对象形状同样严格校验',()=> {
    expect(()=>parseTemplateReplay(replay([sharedPhase()],[{array:[messages[0],{role:'assistant',content:12}]},shared[1]]))).toThrow()
    expect(()=>parseTemplateReplay(replay([sharedPhase()],[{array:[messages[0],{...messages[1],extra:'bad'}]},shared[1]]))).toThrow()
    expect(()=>parseTemplateReplay(replay([phase({history:null},{history:[0,1]})],[{text:['not an array']}]))).toThrow()
  })

  it('消息身份仍须长度一致、唯一，当前阶段不能借共享后缀读取未来身份',()=> {
    expect(()=>parseTemplateReplay(replay([phase({history:null,historyIdentities:null},{history:[0,1],historyIdentities:[1,2]})],shared))).toThrow(/文本历史不一致/)
    expect(()=>parseTemplateReplay(replay([sharedPhase()],[shared[0],{array:[identities[0],identities[0]]}]))).toThrow(/身份无效或重复/)
    const invisible=phase({history:null,historyIdentities:null,messageVariables:{version:1,snapshots:{a1:{values:{},initialized:true}}}},
      {history:[0,1],historyIdentities:[1,1]})
    expect(()=>parseTemplateReplay(replay([invisible],shared))).toThrow(/不可见消息变量/)
  })

  it('共享 helperMvu 和消息变量仍按展开后的历史身份检查可见范围',()=> {
    const visible=sharedPhase({helperMvu:null,messageVariables:emptyTemplateMessageVariables()})
    visible.refs={...visible.refs,helperMvu:2}
    expect(()=>parseTemplateReplay(replay([visible],[...shared,{value:{version:1,snapshots:{u1:{hp:2}}}}]))).not.toThrow()
    expect(()=>parseTemplateReplay(replay([visible],[...shared,{value:{version:1,snapshots:{future:{hp:2}}}}]))).toThrow(/MVU 包含不可见消息/)
    expect(()=>parseTemplateReplay(replay([visible],[...shared,{value:{version:1,snapshots:{u1:[]}}}]))).toThrow(/MVU 包含不可见消息/)
  })

  it('错误引用和缺失占位在展开阶段提前拒绝',()=> {
    expect(()=>parseTemplateReplay(replay([phase({history:null},{history:[0,3]})],shared))).toThrow(/引用/)
    expect(()=>parseTemplateReplay(replay([phase({history:[]},{history:[0,1]})],shared))).toThrow(/占位/)
    expect(()=>parseTemplateReplay(replay([phase({history:null},{history:0})],shared))).toThrow(/引用/)
  })

  it('prepared 的剧情身份以最近生成阶段为准，压缩不会退回初始绑定',()=> {
    const source=prepared(replay([sharedPhase({phase:'generate',now:3})],shared))
    const parsed=parseTemplateGeneration(source)
    if(parsed.status!=='prepared') throw new Error('工厂恢复状态错误')
    expect(templateGenerationContext(parsed)).toMatchObject({sessionId:'session-a',cardId:'card-a',now:3,history:messages})
    expect(()=>parseTemplateGeneration(prepared(replay([sharedPhase({phase:'generate',sessionId:'session-other'})],shared)))).toThrow(/剧情绑定不一致/)
    expect(()=>parseTemplateGeneration(prepared(replay([sharedPhase({phase:'generate',cardId:'other-card'})],shared)))).toThrow(/剧情绑定不一致/)
  })
})
