/** 服务端卡面租约：新运行时入站立即撤销旧许可；写锁内在提交开始前复核，断开和失败记录有界清理。 */
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionBinding} from '../core/binding.js'
import type {HelperFrameClose,HelperFrameLease,HelperFrameOpen,HelperFrameWriteGuard} from '../core/helperFrame.js'
import {displaySessionEventAt,readDisplaySessionEvents} from './sessionEvents.js'
import type {TavernState} from './state.js'

const MAX_FRAMES=1024
const CLOSED_RETENTION_MS=15*60*1000
interface FrameRecord extends HelperFrameOpen {token?:string;binding?:string;closedAt?:number;closed:boolean}
const records=new WeakMap<TavernState,Map<string,FrameRecord>>()
const bindingKey=(binding:SessionBinding)=>JSON.stringify(binding)
function mapFor(state:TavernState):Map<string,FrameRecord>{
  let map=records.get(state);if(!map){map=new Map();records.set(state,map)}
  for(const [key,value] of map)if(value.closedAt!==undefined&&Date.now()-value.closedAt>CLOSED_RETENTION_MS)map.delete(key)
  return map
}
function identity(request:HelperFrameOpen|HelperFrameClose):void{
  if(!request.sessionId||!Number.isSafeInteger(request.messageId)||request.messageId<0||!Number.isSafeInteger(request.epoch)||request.epoch<1||request.epoch>2147483647
    ||![request.frameId,request.runtimeId].every(value=>typeof value==='string'&&value.length>=8&&value.length<=96))throw new Error('卡面运行时身份无效')
}
export async function openHelperFrame(ctx:Context,state:TavernState,request:HelperFrameOpen):Promise<{token:string}>{
  identity(request)
  const map=mapFor(state),old=map.get(request.frameId)
  if(old&&(old.sessionId!==request.sessionId||old.messageId!==request.messageId||request.epoch<=old.epoch))throw new Error('卡面运行时连接已失效')
  if(!old&&map.size>=MAX_FRAMES)throw new Error('卡面运行时记录超过 1024 个的接口预算，请关闭旧卡面并稍后重试')
  // 先替换记录，不能把失效操作排到旧写入占用的剧情/会话队列之后。
  const record:FrameRecord={...request,closed:false,closedAt:Date.now()};map.set(request.frameId,record)
  try{
    const binding=await state.loadBindingUnwaited(request.sessionId,true)
    if(!binding?.storyId||binding.storyId!==request.storyId)throw new Error('卡面剧情绑定已经改变')
    if(!state.config.interactiveCards||binding.interactiveCards===false)throw new Error('交互卡已关闭')
    // 气泡并发连接只按固定 seq 验证目标，避免每个 iframe 再扫描并复制整份历史。
    const event=displaySessionEventAt(await readDisplaySessionEvents(ctx,request.sessionId),request.messageId)
    if(event?.type!=='assistant/message'||event.surfaceOp!==undefined&&event.surfaceOp!=='append'
      ||!event.data.message.content.some(block=>block.type==='text'&&block.text.trim()))throw new Error('卡面消息不在当前剧情中')
    const current=await state.loadBindingUnwaited(request.sessionId,true)
    if(!current||bindingKey(current)!==bindingKey(binding)||!state.config.interactiveCards)throw new Error('卡面连接期间绑定已经改变')
    if(map.get(request.frameId)!==record||record.closed)throw new Error('卡面运行时连接已失效')
    record.token=randomUUID();record.binding=bindingKey(binding);delete record.closedAt
    return {token:record.token}
  }catch(error){
    // 保留本次 epoch 的断开墓碑；迟到的旧连接不能恢复被撤销的令牌。
    if(map.get(request.frameId)===record){delete record.token;record.closed=true;record.closedAt=Date.now()}
    throw error
  }
}
export function closeHelperFrame(state:TavernState,request:HelperFrameClose):void{
  identity(request)
  const record=mapFor(state).get(request.frameId)
  if(!record||record.sessionId!==request.sessionId||record.messageId!==request.messageId||record.runtimeId!==request.runtimeId||record.epoch!==request.epoch
    ||request.token!==undefined&&record.token!==request.token)return
  delete record.token;record.closed=true;record.closedAt=Date.now()
}
export function helperFrameWriteGuard(state:TavernState,scope:{sessionId:string;messageId?:number;storyId?:string},lease?:HelperFrameLease):HelperFrameWriteGuard|undefined{
  if(lease===undefined)return undefined // 可信设置面板沿用原业务入口；iframe 宿主总是注入私有租约。
  return binding=>{
    const record=mapFor(state).get(lease.frameId)
    if(!record?.token||record.readOnly||record.token!==lease.token||record.runtimeId!==lease.runtimeId||record.epoch!==lease.epoch
      ||record.sessionId!==scope.sessionId||scope.messageId!==undefined&&record.messageId!==scope.messageId
      ||scope.storyId!==undefined&&record.storyId!==scope.storyId||record.storyId!==binding.storyId
      ||record.binding!==bindingKey(binding)||!state.config.interactiveCards||binding.interactiveCards===false)throw new Error('卡面运行时租约已失效，请重新加载卡面')
  }
}
