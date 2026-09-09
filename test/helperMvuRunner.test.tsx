/** 自动 MVU 页面调度：真实 React 验证脚本就绪门槛、消息来源、提交回执、重试不重复执行与暂停。 */
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {ReactNode} from 'react'
import {HelperMvuRunner} from '../src/client/helperMvuRunner.js'
import {Btn} from '../src/client/util.js'
import type {TavernRemote} from '../src/client/types.js'
import type {HelperMvuWork} from '../src/core/helperMvu.js'
import type {HelperSnapshot} from '../src/core/helperRuntime.js'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  IconChevronDownOutline14:()=>null,Menu:()=>null,
  Tooltip:(p:{children?:ReactNode})=><>{p.children}</>,Button:(p:{children?:ReactNode})=><button>{p.children}</button>,
}))
let view:ReactTestRenderer|undefined,events:EventTarget
const source={postMessage:vi.fn()}
const snapshot:HelperSnapshot={storyId:'story',historyRevision:'history',currentMessageId:0,writable:false,
  scopes:{},messages:[{message_id:0,name:'角色',role:'assistant',is_hidden:false,message:'hello',data:{},extra:{}}]}
const work:HelperMvuWork={storyId:'story',enabled:true,status:'pending',token:'lease-token',
  job:{id:'a'.repeat(64),identity:'message-1',seq:3,kind:'initialize',text:'hello',turn:0,floor:'session#t0'},snapshot,base:{}}
const prepare=vi.fn(),commit=vi.fn()
const remote={prepareHelperMvuJob:prepare,commitHelperMvuJob:commit} as unknown as TavernRemote
beforeEach(()=>{
  vi.useFakeTimers();events=new EventTarget();vi.stubGlobal('window',events);source.postMessage.mockReset()
  prepare.mockReset().mockResolvedValue({ok:true,value:structuredClone(work)})
  commit.mockReset().mockResolvedValue({ok:true,value:{storyId:'story',enabled:true,status:'idle'}})
})
afterEach(async()=>{if(view)await act(async()=>view!.unmount());view=undefined;vi.useRealTimers();vi.unstubAllGlobals()})
const component=(ready=true)=><HelperMvuRunner remote={remote} sessionId="session" storyId="story" snapshot={snapshot} ready={ready}/>
async function mount(ready=true){await act(async()=>{view=create(component(ready),{createNodeMock:element=>element.type==='iframe'?{contentWindow:source}:null})})}
async function message(value:Record<string,unknown>,from:unknown=source){await act(async()=>{
  const event=new Event('message');Object.defineProperties(event,{source:{value:from},data:{value:{source:'dsh-tavern-card',runtimeId:'frame-runtime',...value}}});events.dispatchEvent(event)
})}
async function connect(){await message({action:'helperEventConnect'});await message({action:'helperMvuReady'})}
function runs(){return source.postMessage.mock.calls.map(call=>call[0] as Record<string,unknown>).filter(value=>value.action==='helperMvuRun')}
async function result(value:Record<string,unknown>={}){await message({action:'helperMvuResult',requestId:runs().at(-1)?.requestId,ok:true,data:{stat_data:{hp:10}},...value})}
it('脚本就绪之前不认领任务；固定来源和运行时才能启动，得到结果后才提交',async()=>{
  await mount(false);await connect();expect(prepare).not.toHaveBeenCalled()
  await act(async()=>view!.update(component(true)))
  await act(async()=>vi.advanceTimersByTimeAsync(1000))
  expect(runs()).toHaveLength(1);expect(commit).not.toHaveBeenCalled()
  await result({runtimeId:'stale-runtime'});expect(commit).not.toHaveBeenCalled()
  await message({action:'helperMvuResult',requestId:runs()[0]!.requestId,ok:true,data:{stat_data:{hp:20}}},{})
  expect(commit).not.toHaveBeenCalled()
  await result();expect(commit).toHaveBeenCalledTimes(1)
  expect(commit.mock.calls[0]![0]).toMatchObject({sessionId:'session',storyId:'story',jobId:work.job!.id,token:'lease-token',data:{stat_data:{hp:10}}})
})
it('通信失败保留计算结果，用户重试只补交回执，不重跑变量钩子',async()=>{
  commit.mockRejectedValueOnce(new Error('连接中断'))
  await mount();await connect();await result()
  expect(commit).toHaveBeenCalledTimes(1);expect(runs()).toHaveLength(1)
  const button=view!.root.findAllByType(Btn).find(node=>String(node.props.children).includes('Retry')||String(node.props.children).includes('重试'))!
  await act(async()=>button.props.onClick())
  expect(commit).toHaveBeenCalledTimes(2);expect(runs()).toHaveLength(1)
})
it('任务运行中脚本暂停，已计算的迟到结果不能落盘',async()=>{
  await mount();await connect()
  await act(async()=>view!.update(component(false)))
  await result();expect(commit).not.toHaveBeenCalled()
})
it('任务运行中续租保持相同执行，只刷新租约期限',async()=>{
  await mount();await connect()
  await act(async()=>vi.advanceTimersByTimeAsync(21000))
  expect(prepare).toHaveBeenCalledTimes(2);expect(runs()).toHaveLength(1)
})
it('断网后租约已替换，明确重新读取任务并使用新 token，旧结果不冒充新任务结果',async()=>{
  commit.mockRejectedValueOnce(new Error('连接中断'))
  await mount();await connect();await result()
  prepare.mockResolvedValue({ok:true,value:{...structuredClone(work),token:'new-token'}})
  await act(async()=>vi.advanceTimersByTimeAsync(91000))
  expect(commit).toHaveBeenCalledTimes(1);expect(runs()).toHaveLength(1)
  const button=view!.root.findAllByType(Btn).find(node=>String(node.props.children).includes('Reload')||String(node.props.children).includes('重新读取'))!
  expect(button).toBeDefined()
  await act(async()=>button.props.onClick())
  expect(runs()).toHaveLength(2)
  await result();expect(commit.mock.calls[1]![0]).toMatchObject({token:'new-token'})
})
it('提交已成功但回执丢失，租约结束后按任务摘要确认完成，不重复执行或保存',async()=>{
  commit.mockRejectedValueOnce(new Error('回执丢失'))
  await mount();await connect();await result()
  const digest=createHash('sha256').update(JSON.stringify({stat_data:{hp:10}})).digest()
  const digestSpy=vi.spyOn(crypto.subtle,'digest').mockResolvedValue(Uint8Array.from(digest).buffer)
  prepare.mockResolvedValue({ok:true,value:{storyId:'story',enabled:true,status:'idle',completed:[{id:work.job!.id,digest:digest.toString('hex')}]}})
  await act(async()=>vi.advanceTimersByTimeAsync(21000))
  expect(runs()).toHaveLength(1);expect(commit).toHaveBeenCalledTimes(1)
  expect(view!.root.findAllByType(Btn)).toHaveLength(0)
  digestSpy.mockRestore()
})
