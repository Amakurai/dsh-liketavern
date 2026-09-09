/** 沙箱消息批量编辑契约：正文和消息数据分别验证，禁止不支持的属性被半执行。 */
import {helperJson,type HelperTable,type HelperSnapshot} from './helperRuntime.js'
import {parseHelperSwipes,type HelperSwipeSet} from './helperSwipes.js'
export interface HelperMessageTextEdit {message_id:number;message?:string;data?:HelperTable;extra?:HelperTable;pages?:HelperSwipeSet;delete?:true}
export interface HelperMessageEditRequest {storyId:string;historyRevision:string;edits:unknown;before?:unknown}
export interface HelperMessageEditResult {branch:{childSessionId:string;title:string}|null;snapshot?:HelperSnapshot}
export function parseHelperMessageEdits(input:unknown,json:typeof helperJson=helperJson,swipes:typeof parseHelperSwipes=parseHelperSwipes):HelperMessageTextEdit[]{
  const value=json(input,1024*1024)
  const onlyDeletes=Array.isArray(value)&&value.every(item=>item!==null&&typeof item==='object'&&!Array.isArray(item)&&(item as Record<string,unknown>).delete===true)
  if(!Array.isArray(value)||value.length>(onlyDeletes?4096:64))throw new Error('单次最多修改 64 条消息或删除 4096 条消息')
  const seen=new Set<number>()
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['message_id','message','data','extra','pages','delete'].includes(key)))throw new Error('当前消息编辑只接受 message_id、message、data 和 extra')
    const row=item as Record<string,unknown>
    if(!Number.isSafeInteger(row.message_id)||typeof row.message_id!=='number'||seen.has(row.message_id))throw new Error('消息序号无效或重复')
    if(Object.hasOwn(row,'delete')){if(row.delete!==true||Object.keys(row).length!==2)throw new Error('删除消息不能混入其它修改字段');seen.add(row.message_id);return {message_id:row.message_id,delete:true}}
    if(!['message','data','extra','pages'].some(key=>Object.hasOwn(row,key)))throw new Error('消息编辑没有指定修改字段')
    if(Object.hasOwn(row,'message')&&(typeof row.message!=='string'||!row.message.trim()||new TextEncoder().encode(row.message).length>256*1024))throw new Error('消息正文为空或超过 256 KiB')
    for(const key of ['data','extra'])if(Object.hasOwn(row,key)&&(!row[key]||typeof row[key]!=='object'||Array.isArray(row[key])))throw new Error('消息 data 和 extra 必须是普通 JSON 对象')
    if(Object.hasOwn(row,'pages'))row.pages=swipes(row.pages,json)
    seen.add(row.message_id);return row as unknown as HelperMessageTextEdit
  })
}
