/** 服务端卡面注册集成：真实宿主 Session 与临时剧情文件验证租约身份、乱序连接、绑定复核及有界断开记录。 */
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {SessionId,SessionStore,type Session} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import type {SessionBinding} from '../src/core/binding.js'
import type {HelperFrameLease,HelperFrameOpen} from '../src/core/helperFrame.js'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {sessionFile} from '../src/node/paths.js'
import {closeHelperFrame,helperFrameWriteGuard,openHelperFrame} from '../src/node/helperFrameLease.js'

type FrameRequest=HelperFrameOpen
let root:string,state:TavernState,ctx:Context,source:Session,binding:SessionBinding,messageId:number,userMessageId:number,interactiveCards:boolean
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-frame-registry-'));interactiveCards=true
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({interactiveCards}))
  await state.init();const cardId=(await state.createCharacter('注册工厂角色')).cardId
  ctx=new Context();new SessionStore(ctx);source=ctx.sessions.create(SessionId('registry-story'))
  source.append('turn/start',{turn:1})
  userMessageId=source.append('user/message',createUserMessage({content:[{type:'text',text:'用户台词'}],source:{kind:'user'}}),{surfaceOp:'append'}).seq
  messageId=source.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'角色回复'}],source:{provider:'factory',model:'factory'}})},{surfaceOp:'append'}).seq
  source.append('turn/end',{turn:1,reason:{kind:'completed'}})
  await state.saveBinding({sessionId:source.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'factory'})
  binding=(await state.loadBinding(source.id,true))!
})
afterEach(async()=>{vi.restoreAllMocks();await ctx?.fiber.dispose();await rm(root,{recursive:true,force:true})})
const request=(changes:Partial<FrameRequest>={}):FrameRequest=>({sessionId:source.id,messageId,storyId:binding.storyId!,frameId:'frame-factory-000',runtimeId:'runtime-factory-1',epoch:1,readOnly:false,...changes})
const lease=(input:FrameRequest,token:string):HelperFrameLease=>({frameId:input.frameId,runtimeId:input.runtimeId,epoch:input.epoch,token})
function guard(input:FrameRequest,token:string,scope={sessionId:input.sessionId,messageId:input.messageId,storyId:input.storyId}){
  return helperFrameWriteGuard(state,scope,lease(input,token))!
}

it('有效租约绑定实际剧情及宿主消息；伪造任一身份拒绝，可信面板入口仍无需租约',async()=>{
  const input=request(),{token}=await openHelperFrame(ctx,state,input),check=guard(input,token)
  expect(token).toMatch(/^[a-f0-9-]{36}$/);expect(()=>check(binding)).not.toThrow()
  expect(helperFrameWriteGuard(state,{sessionId:source.id})).toBeUndefined()
  for(const scope of [{sessionId:'another-session',messageId,storyId:input.storyId},{sessionId:source.id,messageId:messageId+1,storyId:input.storyId},{sessionId:source.id,messageId,storyId:'wrong-story'}]){
    expect(()=>guard(input,token,scope)(binding)).toThrow('租约已失效')
  }
  for(const change of [{frameId:'frame-forged-000'},{runtimeId:'runtime-forged-1'},{epoch:2},{token:'forged-token'}]){
    const forged={...lease(input,token),...change}
    expect(()=>helperFrameWriteGuard(state,{sessionId:source.id,messageId,storyId:input.storyId},forged)!(binding)).toThrow('租约已失效')
  }
  expect(()=>check({...binding,storyId:'wrong-story'})).toThrow('租约已失效')
  const otherState=new TavernState(state.paths,()=>resolveConfig({}))
  expect(()=>helperFrameWriteGuard(otherState,{sessionId:source.id,messageId},lease(input,token))!(binding)).toThrow('租约已失效')
})

it('较新 epoch 入站即撤旧令牌；慢旧连接晚返回不能替换已完成的新连接',async()=>{
  const first=request(),old=await openHelperFrame(ctx,state,first),oldGuard=guard(first,old.token)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),readBinding=state.loadBindingUnwaited.bind(state)
  vi.spyOn(state,'loadBindingUnwaited').mockImplementationOnce(async(...args)=>{const current=await readBinding(...args);entered.resolve();await release.promise;return current})
  const middle=request({epoch:2,runtimeId:'runtime-factory-2'}),pending=openHelperFrame(ctx,state,middle).then(value=>({value}),error=>({error:String(error)}))
  // 不等待服务端绑定读结束，新请求同步替换记录已经撤销旧许可。
  expect(()=>oldGuard(binding)).toThrow('租约已失效');await entered.promise
  const latest=request({epoch:3,runtimeId:'runtime-factory-3'}),current=await openHelperFrame(ctx,state,latest),currentGuard=guard(latest,current.token)
  expect(()=>currentGuard(binding)).not.toThrow();release.resolve()
  expect(await pending).toMatchObject({error:expect.stringContaining('连接已失效')})
  expect(()=>currentGuard(binding)).not.toThrow();expect(()=>oldGuard(binding)).toThrow('租约已失效')
})

it('失败的新连接保留撤销墓碑；乱序低 epoch 与旧断开不能恢复或覆盖新许可',async()=>{
  const first=request(),old=await openHelperFrame(ctx,state,first)
  await expect(openHelperFrame(ctx,state,request({epoch:2,storyId:'wrong-story',runtimeId:'runtime-failed-2'}))).rejects.toThrow('绑定已经改变')
  expect(()=>guard(first,old.token)(binding)).toThrow('租约已失效')
  await expect(openHelperFrame(ctx,state,first)).rejects.toThrow('连接已失效')
  const latest=request({epoch:3,runtimeId:'runtime-factory-3'}),current=await openHelperFrame(ctx,state,latest),check=guard(latest,current.token)
  await expect(openHelperFrame(ctx,state,request({epoch:2,runtimeId:'runtime-factory-2'}))).rejects.toThrow('连接已失效')
  closeHelperFrame(state,{...first,token:old.token});expect(()=>check(binding)).not.toThrow()
  for(const change of [{sessionId:'another-session'},{messageId:messageId+1},{frameId:'frame-another-000'},{runtimeId:'runtime-another-1'},{epoch:2},{token:'wrong-token'}]){
    closeHelperFrame(state,{...latest,token:current.token,...change});expect(()=>check(binding)).not.toThrow()
  }
  closeHelperFrame(state,{...latest,token:current.token});expect(()=>check(binding)).toThrow('租约已失效')
})

it('连接仍在读取时可以无 token 断开；迟到 open 必须拒绝且后续更高 epoch 可以重连',async()=>{
  const input=request(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),readBinding=state.loadBindingUnwaited.bind(state)
  vi.spyOn(state,'loadBindingUnwaited').mockImplementationOnce(async(...args)=>{const current=await readBinding(...args);entered.resolve();await release.promise;return current})
  const pending=openHelperFrame(ctx,state,input).then(value=>({value}),error=>({error:String(error)}))
  await entered.promise;closeHelperFrame(state,input);release.resolve()
  expect(await pending).toMatchObject({error:expect.stringContaining('连接已失效')})
  const newer=request({epoch:2}),{token}=await openHelperFrame(ctx,state,newer)
  expect(()=>guard(newer,token)(binding)).not.toThrow()
})

it('连接期间持久化绑定改变拒绝发 token；现有许可对任何绑定修订也失效',async()=>{
  const first=request(),old=await openHelperFrame(ctx,state,first),readBinding=state.loadBindingUnwaited.bind(state)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  vi.spyOn(state,'loadBindingUnwaited').mockImplementationOnce(readBinding).mockImplementationOnce(async(...args)=>{entered.resolve();await release.promise;return readBinding(...args)})
  const pending=openHelperFrame(ctx,state,request({epoch:2})).then(value=>({value}),error=>({error:String(error)}))
  await entered.promise;await state.saveBinding({...binding,authorNote:'期间修订'});binding=(await readBinding(source.id,true))!;release.resolve()
  expect(await pending).toMatchObject({error:expect.stringContaining('连接期间绑定已经改变')})
  expect(()=>guard(first,old.token)(binding)).toThrow('租约已失效')
  const next=request({epoch:3}),{token}=await openHelperFrame(ctx,state,next)
  expect(()=>guard(next,token)(binding)).not.toThrow()
  await state.saveBinding({...binding,authorNote:'再次修订'});binding=(await readBinding(source.id,true))!
  expect(()=>guard(next,token)(binding)).toThrow('租约已失效')
})

it('关闭交互卡、非 assistant/不可见消息和错误剧情都拒绝连接，不降级成可信许可',async()=>{
  interactiveCards=false
  await expect(openHelperFrame(ctx,state,request())).rejects.toThrow('交互卡已关闭');interactiveCards=true
  await state.saveBinding({...binding,interactiveCards:false})
  await expect(openHelperFrame(ctx,state,request({epoch:2}))).rejects.toThrow('交互卡已关闭')
  await state.saveBinding(binding)
  for(const [index,id] of [userMessageId,0,source.seq+100].entries()){
    await expect(openHelperFrame(ctx,state,request({frameId:'frame-hidden-'+index,messageId:id}))).rejects.toThrow('消息不在当前剧情中')
  }
  await expect(openHelperFrame(ctx,state,request({epoch:3,storyId:'wrong-story'}))).rejects.toThrow('绑定已经改变')
  const input=request({epoch:4}),{token}=await openHelperFrame(ctx,state,input),check=guard(input,token)
  interactiveCards=false;expect(()=>check(binding)).toThrow('租约已失效');interactiveCards=true
  expect(()=>check({...binding,interactiveCards:false})).toThrow('租约已失效')
})

it('损坏绑定 JSON 与实际 I/O 故障拒绝新连接，旧 token 不会作为失败回退',async()=>{
  const input=request(),{token}=await openHelperFrame(ctx,state,input),file=sessionFile(state.paths,source.id),before=await readFile(file,'utf8')
  await writeFile(file,'{broken JSON')
  await expect(openHelperFrame(ctx,state,request({epoch:2}))).rejects.toThrow('绑定已经改变')
  expect(()=>guard(input,token)(binding)).toThrow('租约已失效')
  await rm(file);await mkdir(file)
  await expect(openHelperFrame(ctx,state,request({epoch:3}))).rejects.toThrow()
  expect(()=>guard(input,token)(binding)).toThrow('租约已失效')
  await rm(file,{recursive:true});await writeFile(file,before)
  const next=request({epoch:4}),current=await openHelperFrame(ctx,state,next)
  expect(()=>guard(next,current.token)(binding)).not.toThrow()
})

it('无效数字和过短/过长运行时标识在读绑定前拒绝，不撤销合法现有许可',async()=>{
  const input=request(),{token}=await openHelperFrame(ctx,state,input),read=vi.spyOn(state,'loadBindingUnwaited')
  for(const changes of [{sessionId:''},{messageId:-1},{messageId:0.5},{messageId:NaN},{epoch:0},{epoch:1.5},{epoch:2147483648},{frameId:'short'},{frameId:'f'.repeat(97)},{runtimeId:'short'},{runtimeId:'r'.repeat(97)}]){
    await expect(openHelperFrame(ctx,state,request(changes))).rejects.toThrow('身份无效')
  }
  expect(read).not.toHaveBeenCalled();expect(()=>guard(input,token)(binding)).not.toThrow()
  await expect(openHelperFrame(ctx,state,request({sessionId:'another-session',epoch:2}))).rejects.toThrow('连接已失效')
  await expect(openHelperFrame(ctx,state,request({messageId:userMessageId,epoch:2}))).rejects.toThrow('连接已失效')
  expect(read).not.toHaveBeenCalled();expect(()=>guard(input,token)(binding)).not.toThrow()
})

it('只读候选能注册但不能取得写许可；同运行时更高 epoch 可显式升级，旧只读 token 继续失效',async()=>{
  const input=request({readOnly:true}),{token}=await openHelperFrame(ctx,state,input)
  expect(()=>guard(input,token)(binding)).toThrow('租约已失效')
  const writable=request({epoch:2}),current=await openHelperFrame(ctx,state,writable)
  expect(()=>guard(writable,current.token)(binding)).not.toThrow();expect(()=>guard(input,token)(binding)).toThrow('租约已失效')
})

it('1024 条记录预算拒绝溢出并保留活动许可；断开墓碑满 15 分钟后回收且不影响其它活动卡面',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
  const frames:FrameRequest[]=[],tokens:string[]=[]
  for(let index=0;index<1024;index++){
    const input=request({frameId:'frame-budget-'+String(index).padStart(4,'0')})
    frames.push(input);tokens.push((await openHelperFrame(ctx,state,input)).token)
  }
  const first=frames[0]!,last=frames.at(-1)!,extra=request({frameId:'frame-budget-extra'})
  await expect(openHelperFrame(ctx,state,extra)).rejects.toThrow('1024')
  expect(()=>guard(first,tokens[0]!)(binding)).not.toThrow();expect(()=>guard(last,tokens.at(-1)!)(binding)).not.toThrow()
  closeHelperFrame(state,{...first,token:tokens[0]!})
  await expect(openHelperFrame(ctx,state,extra)).rejects.toThrow('1024')
  now+=15*60*1000;await expect(openHelperFrame(ctx,state,extra)).rejects.toThrow('1024')
  now++;const current=await openHelperFrame(ctx,state,extra)
  expect(()=>guard(extra,current.token)(binding)).not.toThrow();expect(()=>guard(first,tokens[0]!)(binding)).toThrow('租约已失效')
  expect(()=>guard(last,tokens.at(-1)!)(binding)).not.toThrow()
},60_000)

it('失败连接墓碑也有总记录预算与定时回收；另一 TavernState 的正常连接不受影响',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now)
  for(let index=0;index<1024;index++){
    await expect(openHelperFrame(ctx,state,request({frameId:'frame-failed-'+String(index).padStart(4,'0'),storyId:'wrong-story'}))).rejects.toThrow('绑定已经改变')
  }
  const extra=request({frameId:'frame-after-failure'})
  await expect(openHelperFrame(ctx,state,extra)).rejects.toThrow('1024')
  const otherState=new TavernState(state.paths,()=>resolveConfig({})),other=await openHelperFrame(ctx,otherState,extra)
  expect(()=>helperFrameWriteGuard(otherState,{sessionId:source.id,messageId,storyId:extra.storyId},lease(extra,other.token))!(binding)).not.toThrow()
  now+=15*60*1000+1;const current=await openHelperFrame(ctx,state,extra)
  expect(()=>guard(extra,current.token)(binding)).not.toThrow()
},60_000)
