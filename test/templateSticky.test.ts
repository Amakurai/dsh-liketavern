/** sticky 纯生命周期：真实 QuickJS 验证三类独立正则、注入倒计时、闭包身份与重建墓碑，不执行宿主脚本。 */
import { describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { hasTemplateStickyClosures, parseTemplateStickyState, type TemplateStickyState } from '../src/core/templateSticky.js'
import { isolated } from '../src/node/isolated.js'

const context:TemplateContext={variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1000,seed:1,phase:'generate'}
const helpers=`const apply=(text,stage='generate')=>__applyTemporaryRegex(text,stage,{role:'assistant',worldinfo:false,depth:0});const state=()=>JSON.parse(__exportTemplateStickyState());`
async function run<T=unknown>(script:string):Promise<T> {
  const result=await isolated('template',{context,texts:[`<% ${helpers} ${script} %>`]})
  return JSON.parse(result.texts[0]!) as T
}

describe('sticky 注册与生命周期',()=>{
  it('默认 UUID 按模式及替换内容去重，同 UUID 各阶段独立覆盖并重设计数',async()=>{
    expect(await run(`activateRegex(/x/g,'x!');activateRegex(/x/g,'x!');print(JSON.stringify(apply('x')))`)).toBe('x!')
    expect(await run(`activateRegex(/x/g,()=> 'x!',{message:true});activateRegex(/x/g,()=> 'x!',{message:true});print(JSON.stringify(apply('x','message')))`)).toBe('x!')
    const result=await run(`
      activateRegex(/x/g,'b',{uuid:'shared',basic:true,sticky:99});
      activateRegex(/b/g,'g',{uuid:'shared',generate:true,sticky:2});
      activateRegex(/x/g,'m',{uuid:'shared',message:true,sticky:2});
      activateRegex(/x/g,'n',{uuid:'shared',message:true,sticky:4});
      print(JSON.stringify([apply('x'),apply('x','basic'),apply('x','message'),state()]));
    `) as [string,string,string,TemplateStickyState]
    expect(result.slice(0,3)).toEqual(['g','b','n'])
    expect(result[3].regex.generate[0]?.sticky).toBe(2)
    expect(result[3].regex.message[0]?.sticky).toBe(4)
  })
  it('prompt 在生成结束递减到负数才删除，支持有限负数和小数',async()=>{
    expect(await run(`
      for(const sticky of [0,1,2,-1,0.5]) injectPrompt('p',String(sticky),100,sticky);
      const out=[];out.push(getPromptsInjected('p'));__beginTemplateGeneration();out.push(getPromptsInjected('p'));
      for(let i=0;i<3;i++){__finishTemplateGeneration();out.push(getPromptsInjected('p'));}
      print(JSON.stringify(out));
    `)).toEqual(['0\n1\n2\n-1\n0.5','0\n1\n2\n-1\n0.5','1\n2','2',''])
  })
  it('generate 结束和 message 开始各自递减到零删除，basic 不理会 sticky',async()=>{
    const result=await run(`
      for(const sticky of [0,1,2]) activateRegex(/x/g,'v',{uuid:String(sticky),generate:true,message:true,sticky});
      activateRegex(/x/g,'b',{basic:true,sticky:999});
      __finishTemplateGeneration();const finished=state();
      apply('x','message');apply('x','message');const rendered=state();
      __beginTemplateGeneration();const started=state();
      print(JSON.stringify([finished,rendered,started]));
    `) as TemplateStickyState[]
    expect(result[0]?.regex.basic).toEqual([])
    expect(result[0]?.regex.generate.map(rule=>[rule.uuid,rule.sticky])).toEqual([['2',1]])
    expect(result[0]?.regex.message.map(rule=>rule.sticky)).toEqual([0,1,2])
    expect(result[1]).toEqual(result[0])
    expect(result[2]?.regex.message.map(rule=>[rule.uuid,rule.sticky])).toEqual([['2',1]])
  })
  it('deactivate UUID 忽略选择旗标、空选择器无操作，count=0 和负数保留真实算术语义',async()=>{
    const result=await run(`
      activateRegex(/x/g,'y',{uuid:'same',basic:true,generate:true,message:true,sticky:3});
      const initial=state();__deactivateTemplateRegex({});const unchanged=state();
      __deactivateTemplateRegex({uuid:'same',basic:false,generate:false,message:false},1);const selected=state();
      __deactivateTemplateRegex({message:true},-2);const extended=state();
      activateRegex(/a/g,'b',{uuid:'zero',generate:true,sticky:0});__deactivateTemplateRegex({generate:true},0);
      print(JSON.stringify([initial,unchanged,selected,extended,state()]));
    `) as TemplateStickyState[]
    expect(result[1]).toEqual(result[0])
    expect(result[2]?.regex.basic).toEqual([])
    expect(result[2]?.regex.generate[0]?.sticky).toBe(2)
    expect(result[2]?.regex.message[0]?.sticky).toBe(2)
    expect(result[3]?.regex.message[0]?.sticky).toBe(4)
    expect(result[4]?.regex.generate.map(rule=>rule.uuid)).toEqual(['same'])
  })
  it('同 uid 注入覆盖正文和剩余次数，显式重新注册会清除墓碑',async()=>{
    const result=await run(`
      injectPrompt('p','old',100,0,'same');__finishTemplateGeneration();const expired=state();
      injectPrompt('p','new',3,2,'same');__finishTemplateGeneration();print(JSON.stringify([expired,state(),getPromptsInjected('p')]));
    `) as [TemplateStickyState,TemplateStickyState,string]
    expect(result[0].tombstones.prompts).toEqual([{key:'p',uid:'same'}])
    expect(result[1].prompts).toEqual([{key:'p',uid:'same',prompt:'new',order:3,sticky:1}])
    expect(result[1].tombstones.prompts).toEqual([])
    expect(result[2]).toBe('new')
  })
  it('basic 分界保留首次规则供重组使用，后注册 basic 不混入本轮 generate',async()=>{
    expect(await run(`
      activateRegex(/x/g,'old');__prepareTemplateBasicRegex();__clearTemplateBasicRegex();
      activateRegex(/x/g,'late');__prepareTemplateBasicRegex();
      const basic=apply('x','basic'),generate=apply('x');__beginTemplateGeneration();
      print(JSON.stringify([basic,generate,apply('x','basic')]));
    `)).toEqual(['old','x','late'])
  })
})

describe('sticky 快照与词法闭包',()=>{
  it('闭包跨阶段共享状态，导出只含引用身份；原 VM 恢复计数不会重建或回退词法变量',async()=>{
    const result=await run(`
      let n=0;const callback=()=>String(++n);activateRegex(/x/g,callback,{uuid:'counter',generate:true,message:true,sticky:3});
      const first=apply('x'),second=apply('x','message'),snapshot=state();__finishTemplateGeneration();
      __restoreTemplateStickyState(snapshot);const third=apply('x','message');
      print(JSON.stringify([first,second,third,snapshot,__hasLiveTemplateClosures()]));
    `) as [string,string,string,TemplateStickyState,boolean]
    expect(result.slice(0,3)).toEqual(['1','2','3'])
    expect(result[4]).toBe(true)
    expect(hasTemplateStickyClosures(parseTemplateStickyState(result[3]))).toBe(true)
    expect(JSON.stringify(result[3])).not.toContain('++n')
    expect(result[3].regex.generate[0]?.replacement).toEqual(result[3].regex.message[0]?.replacement.kind==='callback'
      ? expect.objectContaining({kind:'callback',id:result[3].regex.message[0]!.replacement.id}) : null)
  })
  it('全量恢复删除 preload 重建出来的过期条目，并覆盖重建重置的剩余计数',async()=>{
    const registration=`injectPrompt('p','expired',0,0,'dead');injectPrompt('p','alive',1,2,'live');activateRegex(/x/g,'old',{uuid:'dead',message:true,sticky:0});activateRegex(/x/g,'kept',{uuid:'live',message:true,sticky:2});`
    const saved=await run<TemplateStickyState>(`${registration}__finishTemplateGeneration();__beginTemplateGeneration();print(__exportTemplateStickyState());`)
    const result=await run(`${registration}__restoreTemplateStickyState(${JSON.stringify(saved)});print(JSON.stringify([state(),getPromptsInjected('p'),apply('x','message')]));`) as [TemplateStickyState,string,string]
    expect(result).toEqual([saved,'alive','kept'])
    expect(saved.regex.message[0]?.sticky).toBe(1)
    expect(saved.tombstones.message).toEqual(['dead'])
  })
  it('新 VM 没有执行日志对应回调时明确拒绝，碰巧相同 id 但身份不同也不能恢复',async()=>{
    const saved=await run<TemplateStickyState>(`activateRegex(/x/g,()=> 'original',{uuid:'id',message:true,sticky:2});print(__exportTemplateStickyState())`)
    await expect(run(`__restoreTemplateStickyState(${JSON.stringify(saved)});print('null')`)).rejects.toThrow(/执行日志重建/)
    expect(await run(`activateRegex(/x/g,()=> 'wrong',{uuid:'id',message:true,sticky:2});let error='';try{__restoreTemplateStickyState(${JSON.stringify(saved)})}catch(cause){error=String(cause)}print(JSON.stringify([error,apply('x','message')]));`)).toEqual([expect.stringContaining('身份'),'wrong'])
    expect(await run(`activateRegex(/x/g,()=> 'original',{uuid:'id',message:true,sticky:99});__restoreTemplateStickyState(${JSON.stringify(saved)});print(JSON.stringify([apply('x','message'),state()]));`)).toEqual(['original',saved])
  })
  it('最后存活的闭包到期后可安全丢弃重放日志；墓碑仍可恢复而不要求函数',async()=>{
    const saved=await run<TemplateStickyState>(`activateRegex(/x/g,()=> 'callback',{message:true,sticky:1});__beginTemplateGeneration();if(__hasLiveTemplateClosures())throw Error('live');print(__exportTemplateStickyState())`)
    expect(hasTemplateStickyClosures(parseTemplateStickyState(saved))).toBe(false)
    expect(await run(`__restoreTemplateStickyState(${JSON.stringify(saved)});print(JSON.stringify([__hasLiveTemplateClosures(),state()]));`)).toEqual([false,saved])
  })
  it('损坏、重复、非有限状态拒绝；失败恢复保持已有注入和正则',async()=>{
    const saved=await run<TemplateStickyState>(`injectPrompt('p','ok');activateRegex(/x/g,'ok',{message:true});print(__exportTemplateStickyState())`)
    for(const mutate of [(s:TemplateStickyState)=>{s.prompts.push(s.prompts[0]!)},(s:TemplateStickyState)=>{s.regex.message[0]!.sticky=Infinity},(s:TemplateStickyState)=>{s.tombstones.message.push(s.regex.message[0]!.uuid)}]) {
      const bad=structuredClone(saved);mutate(bad);expect(()=>parseTemplateStickyState(bad)).toThrow()
    }
    const bad=structuredClone(saved);bad.regex.message[0]!.flags='invalid'
    expect(await run(`injectPrompt('p','untouched');activateRegex(/x/g,'untouched',{message:true});let rejected=false;try{__restoreTemplateStickyState(${JSON.stringify(bad)})}catch{rejected=true}print(JSON.stringify([rejected,getPromptsInjected('p'),apply('x','message')]))`)).toEqual([true,'untouched','untouched'])
    await expect(run(`injectPrompt('x','x',0,Infinity);print('null')`)).rejects.toThrow(/有限/)
    await expect(run(`activateRegex(/x/,'x',{sticky:NaN});print('null')`)).rejects.toThrow(/有限/)
  })
})
