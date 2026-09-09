/** 自动 MVU 的持久任务与回执契约：消息稳定身份独立于剧情副本，租约只由宿主进程持有。 */
import { helperJson, helperRecord, helperTable } from './helperRuntime.js'
import type {HelperSnapshot} from './helperRuntime.js'

export interface HelperMvuJob { id:string; kind:'initialize'|'update'; seq:number; identity:string; text:string; turn:number; floor:string }
export interface HelperMvuReceipt { id:string; identity:string; kind:'initialize'|'update'; digest:string; valueDigest:string; floor:string }
export interface HelperMvuState { version:1; initialized:boolean; pending:HelperMvuJob[]; completed:HelperMvuReceipt[]; lastIdentity?:string }
export interface HelperMvuInitialSource { name:string; role?:'global'|'character'; entries:{uid:string;comment:string;content:string}[] }
export interface HelperMvuWork {
  storyId:string; enabled:boolean; status:'idle'|'pending'|'waiting'; job?:HelperMvuJob; token?:string
  base?:Record<string,unknown>; initialSources?:HelperMvuInitialSource[]; greeting?:string; swipeId?:number
  awaitingTurnEnd?:boolean
  snapshot?:HelperSnapshot
  applyText?:boolean
  completed?:{id:string;digest:string}[]
}
export function parseHelperMvuState(value:unknown):HelperMvuState {
  if(value===undefined)return {version:1,initialized:false,pending:[],completed:[]}
  const state=helperJson(value,1024*1024)
  const text=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max
  if(!helperRecord(state)||state.version!==1||typeof state.initialized!=='boolean'||!Array.isArray(state.pending)||state.pending.length>64||!Array.isArray(state.completed)||state.completed.length>256
    ||Object.keys(state).some(key=>!['version','initialized','pending','completed','lastIdentity'].includes(key))||state.lastIdentity!==undefined&&!text(state.lastIdentity,256))throw new Error('自动 MVU 状态文件损坏')
  const ids=new Set<string>(),identities=new Set<string>()
  for(const row of [...state.pending,...state.completed]){
    if(!helperRecord(row)||typeof row.id!=='string'||!/^[a-f0-9]{64}$/.test(row.id)||!text(row.identity,256)||!['initialize','update'].includes(String(row.kind))||ids.has(String(row.id))||identities.has(String(row.identity)))throw new Error('自动 MVU 任务身份损坏或重复')
    ids.add(String(row.id));identities.add(String(row.identity))
  }
  for(const row of state.pending){
    if(!helperRecord(row)||!Number.isSafeInteger(row.seq)||Number(row.seq)<0||!Number.isSafeInteger(row.turn)||Number(row.turn)<0||!text(row.floor,320)||typeof row.text!=='string'||new TextEncoder().encode(row.text).length>256*1024
      ||Object.keys(row).some(key=>!['id','kind','seq','identity','text','turn','floor'].includes(key)))throw new Error('自动 MVU 待处理任务损坏')
  }
  for(const row of state.completed)if(!helperRecord(row)||typeof row.digest!=='string'||!/^[a-f0-9]{64}$/.test(row.digest)||typeof row.valueDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.valueDigest)||typeof row.floor!=='string'||row.floor.length>320||!/^.+#t[0-9]+$/.test(row.floor)||!Number.isSafeInteger(Number(row.floor.slice(row.floor.lastIndexOf('#t')+2)))||Object.keys(row).some(key=>!['id','kind','identity','digest','valueDigest','floor'].includes(key)))throw new Error('自动 MVU 完成回执损坏')
  const pending=state.pending
  if(!state.initialized&&(state.completed.length>0||pending.length>1)||pending.some((row,index)=>!helperRecord(row)||row.kind!==(state.initialized?'update':'initialize')||index>0&&Number((pending[index-1] as Record<string,unknown>).seq)>=Number(row.seq)))throw new Error('自动 MVU 初始化阶段或任务顺序损坏')
  return state as unknown as HelperMvuState
}
/** 最终消息表必须保留 stat_data；临时内部指针不能进入正文/WAL，其他可序列化扩展数据仍由原变量表契约验证。 */
export function helperMvuData(value:unknown):Record<string,unknown>{
  const data=helperTable(value)
  if(!helperRecord(data.stat_data))throw new Error('自动 MVU 结果缺少 stat_data 对象')
  const check=(value:unknown):void=>{
    if(!value||typeof value!=='object')return
    if(Object.hasOwn(value,'$internal'))throw new Error('自动 MVU 结果不能保存临时 $internal')
    for(const child of Object.values(value))check(child)
  }
  check(data);return data
}
