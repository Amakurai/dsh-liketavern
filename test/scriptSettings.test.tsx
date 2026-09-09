/** 脚本设置入口回归：未绑定会话也能管理三类资产，读取失败不打开编辑器，后台运行器保持隐藏。 */
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import type {ReactNode} from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {publishScriptStatus,clearScriptStatus,scriptStatusStore} from '../src/client/helperScriptStatus.js'
import {ScriptSettings} from '../src/client/panel/scripts.js'
import {HelperScriptEditor} from '../src/client/helperScriptEditor.js'
import {Btn,Select} from '../src/client/util.js'
import type {TavernRemote} from '../src/client/types.js'
import {notifyHelperScriptAssets,watchHelperScriptAssets} from '../src/client/helperScriptNotifications.js'
vi.mock('../src/client/helperScriptEditor.js',()=>({HelperScriptEditor:()=>null}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:(p:{children?:ReactNode})=><button>{p.children}</button>,Menu:()=>null,
  Tooltip:(p:{children?:ReactNode})=><>{p.children}</>,IconChevronDownOutline14:()=>null,
}))
let view:ReactTestRenderer|undefined
afterEach(async()=>{if(view)await act(async()=>view!.unmount());view=undefined})
it('无需会话参数即可读取全局、指定角色和指定预设脚本；失败保留错误',async()=>{
  const get=vi.fn(async({target})=>({ok:true,value:{target,revision:'v1',trees:[]}}))
  const remote={listCharacters:async()=>({ok:true,value:{items:[{cardId:'card-key',name:'角色名称'}]}}),
    listPresets:async()=>({ok:true,value:{items:[{id:'preset-key',name:'预设名称'}]}}),getHelperScriptLibrary:get} as unknown as TavernRemote
  await act(async()=>{view=create(<ScriptSettings remote={remote}/>)})
  const buttons=()=>view!.root.findAllByType(Btn)
  expect(buttons()[1]!.props.disabled).toBe(true)
  await act(async()=>buttons()[0]!.props.onClick())
  expect(get).toHaveBeenLastCalledWith({target:{type:'global'}})
  await act(async()=>view!.root.findByType(HelperScriptEditor).props.onClose())
  await act(async()=>view!.root.findAllByType(Select)[0]!.props.onChange('card-key'))
  await act(async()=>buttons()[1]!.props.onClick())
  expect(view!.root.findByType(HelperScriptEditor).props.library.target).toEqual({type:'character',cardId:'card-key'})
  await act(async()=>view!.root.findByType(HelperScriptEditor).props.onSaved())
  expect(view!.root.findByType(HelperScriptEditor).props.label).toBe('角色名称')
  await act(async()=>view!.root.findByType(HelperScriptEditor).props.onClose())
  await act(async()=>view!.root.findAllByType(Select)[1]!.props.onChange('preset-key'))
  await act(async()=>buttons()[2]!.props.onClick())
  expect(get).toHaveBeenLastCalledWith({target:{type:'preset',presetId:'preset-key'}})
  await act(async()=>view!.root.findByType(HelperScriptEditor).props.onClose())
  get.mockRejectedValueOnce(new Error('读取失败'))
  await act(async()=>buttons()[0]!.props.onClick())
  expect(view!.root.findAllByType(HelperScriptEditor)).toHaveLength(0)
  expect(JSON.stringify(view!.toJSON())).toContain('读取失败')
})
it('资产通知携带保存目标，卸载的运行器不会收到后续通知',()=>{
  const listener=vi.fn(),stop=watchHelperScriptAssets(listener)
  try{notifyHelperScriptAssets({type:'character',cardId:'card-key'});expect(listener).toHaveBeenCalledWith({type:'character',cardId:'card-key'})}
  finally{stop()}
  notifyHelperScriptAssets({type:'global'});expect(listener).toHaveBeenCalledOnce()
})

it('运行错误在设置可见，旧容器卸载不能清掉新运行器的诊断',async()=>{
  const old=Symbol(),current=Symbol(),status={sessionId:'session',cardId:'card',state:'running' as const,nativeMvu:true,scripts:[{id:'s',name:'Rule',state:'error' as const,error:'sandbox failure',native:false}]}
  publishScriptStatus(old,status);publishScriptStatus(current,status);clearScriptStatus(old,'session')
  const remote={listCharacters:async()=>({ok:true,value:{items:[{cardId:'card',name:'Character'}]}}),listPresets:async()=>({ok:true,value:{items:[]}})} as unknown as TavernRemote
  try{await act(async()=>{view=create(<ScriptSettings remote={remote}/>)});expect(JSON.stringify(view!.toJSON())).toContain('sandbox failure');expect(scriptStatusStore.getSnapshot()).toHaveLength(1)}finally{await act(async()=>clearScriptStatus(current,'session'))}
  expect(scriptStatusStore.getSnapshot()).toHaveLength(0)
})
