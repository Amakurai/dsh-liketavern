/** 酒馆助手世界书契约及 JSON 校验：公开条目使用数值 UID，正则键以原生 /source/flags 文本跨沙箱传递。 */
import type {HelperLorebookSettings} from './helperWorldbookSettings.js'
import {helperJson,helperRecord,type HelperTable} from './helperRuntime.js'
export const HELPER_WORLDBOOK_MAX_BYTES=8*1024*1024
export const HELPER_CHARACTER_WORLDBOOK='@dsh/character'
export const HELPER_CHAT_WORLDBOOK='@dsh/chat'
export interface HelperWorldbookEntry {
  uid:number;name:string;enabled:boolean;content:string;probability:number
  strategy:{type:'constant'|'selective'|'vectorized';keys:string[];keys_secondary:{logic:'and_any'|'and_all'|'not_all'|'not_any';keys:string[]};scan_depth:'same_as_global'|number}
  position:{type:'before_character_definition'|'after_character_definition'|'before_author_note'|'after_author_note'|'at_depth'|'before_example_messages'|'after_example_messages'|'outlet';role:'system'|'assistant'|'user';depth:number;order:number}
  recursion:{prevent_incoming:boolean;prevent_outgoing:boolean;delay_until:number|null}
  effect:{sticky:number|null;cooldown:number|null;delay:number|null}
  extra:HelperTable
}
export interface HelperWorldbookContext {storyId:string;bindingRevision:string;names:string[];global:string[];characterName:string;settings?:HelperLorebookSettings;character:{primary:string|null;additional:string[]};chat:string|null}
export interface HelperWorldbookSnapshot {name:string;revision:string;entries:HelperWorldbookEntry[]}
export type HelperWorldbookOperation='get'|'replace'|'create'|'upsert'|'delete'
export interface HelperWorldbookRequest {storyId:string;bindingRevision:string;name:string;operation:HelperWorldbookOperation;revision?:string;entries?:unknown;label?:string}
export interface HelperWorldbookRebindRequest {storyId:string;bindingRevision:string;kind:'global'|'character'|'chat'|'ensure-chat'|'settings';selection:unknown}
export interface HelperWorldbookResult {context?:HelperWorldbookContext;snapshot?:HelperWorldbookSnapshot;missing?:boolean;created?:boolean;deleted?:boolean}
/** 完全替换与新建的默认字段；拒绝错误类型和重复 UID，不在宿主求值任何脚本或正则。 */
export function parseHelperWorldbook(input:unknown):HelperWorldbookEntry[] {
  const data=helperJson(input,HELPER_WORLDBOOK_MAX_BYTES)
  if(!Array.isArray(data)||data.length>2000)throw new Error('世界书条目必须是至多 2000 项的数组')
  const ids=new Set<number>(),reserved=new Set<number>()
  for(const value of data)if(helperRecord(value)&&value.uid!==undefined){if(!Number.isSafeInteger(value.uid)||Number(value.uid)<0)throw new Error('世界书 UID 必须是非负安全整数');reserved.add(Number(value.uid))}
  let next=0
  const record=(value:unknown):HelperTable=>{if(value===undefined)return {};if(!helperRecord(value))throw new Error('世界书设置必须为对象');return value}
  const text=(value:unknown,fallback='',max=100000)=>{if(value===undefined)return fallback;if(typeof value!=='string'||value.length>max)throw new Error('世界书文本字段类型无效或超出预算');return value}
  const bool=(value:unknown,fallback:boolean)=>{if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error('世界书开关必须为布尔值');return value}
  const number=(value:unknown,fallback:number,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error('世界书数值字段无效');return value}
  const nullable=(value:unknown)=>value==null?null:number(value,0)
  const choice=<T extends string>(value:unknown,values:readonly T[],fallback:T):T=>{if(value===undefined)return fallback;if(!values.includes(value as T))throw new Error('世界书枚举字段无效');return value as T}
  const keys=(value:unknown):string[]=>{if(value===undefined)return [];if(!Array.isArray(value)||value.length>2000)throw new Error('世界书关键字列表无效');return value.map(item=>text(item,'',500))}
  return data.map(value=>{
    const item=record(value),strategy=record(item.strategy),secondary=record(strategy.keys_secondary),position=record(item.position),recursion=record(item.recursion),effect=record(item.effect)
    while(reserved.has(next))next++
    const uid=item.uid===undefined?next++:Number(item.uid);reserved.add(uid)
    if(ids.has(uid))throw new Error('世界书 UID 重复');ids.add(uid)
    const scan=strategy.scan_depth===undefined||strategy.scan_depth==='same_as_global'?'same_as_global':number(strategy.scan_depth,0)
    return {uid,name:text(item.name,'',4096),enabled:bool(item.enabled,true),content:text(item.content),probability:number(item.probability,100,0,100),
      strategy:{type:choice(strategy.type,['constant','selective','vectorized'],'selective'),keys:keys(strategy.keys),keys_secondary:{logic:choice(secondary.logic,['and_any','and_all','not_all','not_any'],'and_any'),keys:keys(secondary.keys)},scan_depth:scan},
      position:{type:choice(position.type,['before_character_definition','after_character_definition','before_author_note','after_author_note','at_depth','before_example_messages','after_example_messages','outlet'],'before_character_definition'),role:choice(position.role,['system','assistant','user'],'system'),depth:number(position.depth,4),order:number(position.order,100,-Number.MAX_SAFE_INTEGER)},
      recursion:{prevent_incoming:bool(recursion.prevent_incoming,false),prevent_outgoing:bool(recursion.prevent_outgoing,false),delay_until:nullable(recursion.delay_until)},
      effect:{sticky:nullable(effect.sticky),cooldown:nullable(effect.cooldown),delay:nullable(effect.delay)},extra:record(item.extra)}
  })
}
