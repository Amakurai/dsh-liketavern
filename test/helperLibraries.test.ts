/** 三类脚本库的真实文件系统集成：共享资产、修订冲突、预设切换、故障回执与剧情隔离。 */
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {getHelperScriptBundle} from '../src/node/helperRuntime.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {enabledHelperLibraries,type HelperScriptTarget} from '../src/core/helperScripts.js'
let root:string,state:TavernState,cardId:string,ctx:Context
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-libraries-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init();cardId=(await state.createCharacter('工厂角色')).cardId
  await state.savePreset({identifier:'factory',name:'工厂预设',entries:[],helperSettings:{variables:{author:5},other:true,scripts:[]}})
  for(const sessionId of ['a','b'])await state.saveBinding({sessionId,cardId,presetId:'factory',personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const events=[{type:'turn/start',seq:0,time:0,data:{turn:1}},
    {type:'assistant/message',seq:1,time:0,data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'工厂消息'}]})}},
    {type:'turn/end',seq:2,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
  ctx={sessions:{get:()=>({snapshotEvents:()=>events})},get:()=>undefined} as unknown as Context
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
async function save(target:HelperScriptTarget,id:string){const before=await state.getHelperScriptLibrary(target);return state.saveHelperScriptLibrary(target,before.revision,[{id,enabled:true,content:'await Promise.resolve()',data:{n:1}}])}
it('全局、当前预设与角色脚本共同加载，共享源码但快照和运行变量保持剧情隔离',async()=>{
  await save({type:'global'},'g');await save({type:'preset',presetId:'factory'},'p');await save({type:'character',cardId},'c')
  const a=await getHelperScriptBundle(ctx,state,'a'),b=await getHelperScriptBundle(ctx,state,'b')
  expect(enabledHelperLibraries(a.libraries).map(script=>script.id)).toEqual(['g','p','c'])
  expect(a.libraries).toEqual(b.libraries);expect(a.snapshot?.storyId).not.toBe(b.snapshot?.storyId)
  expect(a.snapshot?.scopes).toEqual({});expect(a.messageId).toBe(1)
  await state.savePreset({identifier:'second',name:'另一预设',entries:[],helperSettings:{scripts:[{id:'p2',enabled:true}]}})
  await state.saveBinding({... (await state.loadBinding('a'))!,presetId:'second'})
  expect(enabledHelperLibraries((await getHelperScriptBundle(ctx,state,'a')).libraries).map(script=>script.id)).toEqual(['g','p2','c'])
  state=new TavernState(state.paths,()=>resolveConfig({}));await state.init()
  expect((await state.getHelperScriptLibrary({type:'global'})).trees[0]).toMatchObject({id:'g'})
  expect((await state.loadPreset('factory'))?.helperSettings).toMatchObject({variables:{author:5},other:true,scripts:[{id:'p'}]})
})
it.each(['global','preset'] as const)('%s 脚本库并发编辑只有一份旧修订成功，坏输入和旧修订不覆盖',async(type)=>{
  const target:HelperScriptTarget=type==='global'?{type}:{type,presetId:'factory'},initial=await state.getHelperScriptLibrary(target)
  const results=await Promise.allSettled(['one','two'].map(id=>state.saveHelperScriptLibrary(target,initial.revision,[{id}])))
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  const saved=await state.getHelperScriptLibrary(target)
  await expect(state.saveHelperScriptLibrary(target,initial.revision,[{id:'third'}])).rejects.toThrow(/修改/)
  await expect(state.saveHelperScriptLibrary(target,saved.revision,[{id:'dup'},{id:'dup'}])).rejects.toThrow(/重复/)
  expect(await state.getHelperScriptLibrary(target)).toEqual(saved)
})
it.each(['global','preset'] as const)('%s 写入完成但回执失败后可以幂等重试，不读过期缓存',async(type)=>{
  const target:HelperScriptTarget=type==='global'?{type}:{type,presetId:'factory'},initial=await state.getHelperScriptLibrary(target)
  const original=WorkspaceFs.prototype.writeText
  const spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){await original.call(this,path,text);throw Error('工厂回执故障')})
  await expect(state.saveHelperScriptLibrary(target,initial.revision,[{id:'saved'}])).rejects.toThrow('工厂回执故障')
  spy.mockRestore();const current=await state.getHelperScriptLibrary(target),writes=vi.spyOn(WorkspaceFs.prototype,'writeText')
  expect(current.trees[0]).toMatchObject({id:'saved'})
  expect(await state.saveHelperScriptLibrary(target,initial.revision,[{id:'saved'}])).toEqual(current)
  expect(writes).not.toHaveBeenCalled()
})
it('普通预设编辑保留当前脚本资产，显式重新导入可以替换；删除后旧脚本编辑器不能复活预设',async()=>{
  const old=(await state.loadPreset('factory'))!
  const saved=await save({type:'preset',presetId:'factory'},'new-script')
  await state.savePreset({...old,name:'改名'}, {preserveHelperSettings:true})
  expect((await state.loadPreset('factory'))?.name).toBe('改名')
  expect((await state.getHelperScriptLibrary(saved.target)).trees).toEqual(saved.trees)
  await state.savePreset({...old,name:'重新导入'})
  expect((await state.getHelperScriptLibrary(saved.target)).trees).toEqual([])
  await state.deletePreset('factory')
  await expect(state.saveHelperScriptLibrary(saved.target,saved.revision,[])).rejects.toThrow(/不存在/)
})
it('绑定的预设被删除或损坏后，会话脚本包按没有预设脚本加载，而不是整条渲染链抛错',async()=>{
  await save({type:'global'},'g');await save({type:'preset',presetId:'factory'},'p')
  const binding=(await state.loadBinding('a'))!
  await state.deletePreset('factory')
  const context=await state.getSessionHelperScripts('a',binding.storyId!)
  expect(context.libraries.map(item=>item.type)).toEqual(['global','character'])
  expect(enabledHelperLibraries((await getHelperScriptBundle(ctx,state,'a')).libraries).map(script=>script.id)).toEqual(['g'])
  await writeFile(join(root,'library/presets/factory.json'),'{broken')
  state=new TavernState(state.paths,()=>resolveConfig({}));await state.init()
  expect((await state.getSessionHelperScripts('a',binding.storyId!)).libraries.map(item=>item.type)).toEqual(['global','character'])
  await expect(state.getHelperScriptLibrary({type:'preset',presetId:'factory'})).rejects.toThrow(/不存在|无法读取/)
})
it('跨库启用 ID 冲突返回运行错误但保留管理数据，损坏的全局库不能被当成空库覆盖',async()=>{
  await save({type:'global'},'duplicate');await save({type:'preset',presetId:'factory'},'duplicate')
  const bundle=await getHelperScriptBundle(ctx,state,'a')
  expect(bundle.runtimeError).toMatch(/重复/);expect(bundle.snapshot).toBeUndefined();expect(bundle.libraries).toHaveLength(3)
  const path=join(root,'library/helper-scripts.json');await writeFile(path,'{broken')
  await expect(state.getHelperScriptLibrary({type:'global'})).rejects.toThrow()
  await expect(state.saveHelperScriptLibrary({type:'global'},'old',[])).rejects.toThrow()
  expect(await readFile(path,'utf8')).toBe('{broken')
})
it('加载途中换预设即拒绝旧脚本包，即使剧情 ID 没变也不运行旧预设代码',async()=>{
  const original=state.getHelperScriptLibrary.bind(state)
  vi.spyOn(state,'getHelperScriptLibrary').mockImplementation(async(target)=>{
    const result=await original(target)
    if(target.type==='global')await state.saveBinding({... (await state.loadBinding('a'))!,presetId:null})
    return result
  })
  await expect(getHelperScriptBundle(ctx,state,'a')).rejects.toThrow(/绑定已改变/)
})

it('沙箱写入绑定固定剧情和预设身份，旧绑定令牌与关闭交互卡均拒绝写入',async()=>{
  const binding=(await state.loadBinding('a'))!,context=await state.getSessionHelperScripts('a',binding.storyId!)
  const library=context.libraries.find(item=>item.type==='preset')!
  const request={storyId:context.storyId,bindingRevision:context.bindingRevision,type:'preset' as const,revision:library.revision,trees:[{id:'from-sandbox'}]}
  const saved=await state.commitSessionHelperScripts('a',request)
  expect(saved.trees[0]).toMatchObject({id:'from-sandbox'})
  await state.savePreset({identifier:'other',name:'Other',entries:[]})
  await state.saveBinding({...binding,presetId:'other'})
  await expect(state.commitSessionHelperScripts('a',request)).rejects.toThrow(/绑定已改变/)
  expect((await state.getHelperScriptLibrary({type:'preset',presetId:'other'})).trees).toEqual([])
  await expect(state.getSessionHelperScripts('a',(await state.loadBinding('b'))!.storyId!)).rejects.toThrow(/绑定已改变/)
  await state.saveBinding({...binding,interactiveCards:false})
  await expect(state.commitSessionHelperScripts('a',request)).rejects.toThrow(/关闭/)
})
it('同一个脚本库上的编辑器与沙箱写入共享修订冲突检测',async()=>{
  const context=await state.getSessionHelperScripts('a',(await state.loadBinding('a'))!.storyId!),global=context.libraries.find(item=>item.type==='global')!
  await save({type:'global'},'editor-new')
  await expect(state.commitSessionHelperScripts('a',{storyId:context.storyId,bindingRevision:context.bindingRevision,type:'global',revision:global.revision,trees:[{id:'stale-sandbox'}]})).rejects.toThrow(/修改/)
  expect((await state.getHelperScriptLibrary({type:'global'})).trees[0]).toMatchObject({id:'editor-new'})
})
it('资产写入持有会话绑定锁，换绑等待写入完成，不能在校验后偷换目标预设',async()=>{
  const binding=(await state.loadBinding('a'))!,context=await state.getSessionHelperScripts('a',binding.storyId!),preset=context.libraries.find(item=>item.type==='preset')!
  await state.savePreset({identifier:'other',name:'Other',entries:[]})
  let entered!:()=>void,release!:()=>void
  const arrived=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),original=WorkspaceFs.prototype.writeText
  vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){if(path==='library/presets/factory.json'){entered();await gate}return original.call(this,path,text)})
  const saving=state.commitSessionHelperScripts('a',{storyId:context.storyId,bindingRevision:context.bindingRevision,type:'preset',revision:preset.revision,trees:[{id:'old-preset-only'}]})
  await arrived
  let rebound=false;const rebinding=state.saveBinding({...binding,presetId:'other'}).then(()=>{rebound=true})
  await Promise.resolve();expect(rebound).toBe(false);release();await saving;await rebinding
  expect((await state.getHelperScriptLibrary({type:'preset',presetId:'factory'})).trees[0]).toMatchObject({id:'old-preset-only'})
  expect((await state.getHelperScriptLibrary({type:'preset',presetId:'other'})).trees).toEqual([])
})
