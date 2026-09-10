/** 剧情聊天世界书集合；活动书保持原生 entries 外形，闲置书放同一原子文件，切换与解绑不丢内容。 */
import {helperJson,helperRecord} from '../core/helperRuntime.js'
import {readHelperWorldbook} from './helperWorldbook.js'
export const CHAT_WORLDBOOK_PATH='assets/chat-lorebook.json'
export const CHAT_WORLDBOOK_META='dsh_tavern_chat_books'
export const CHAT_WORLDBOOK_TOTAL_BYTES=32*1024*1024
export interface ChatWorldbooks {active:string|null;books:Map<string,unknown>}
function id(value:unknown):string {if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))throw new Error('聊天世界书标识无效');return value}
export function chatWorldbookId(ref:string):string|null {if(ref==='@dsh/chat')return 'main';if(ref.startsWith('@dsh/chat/'))return id(ref.slice('@dsh/chat/'.length));return null}
export function chatWorldbookRef(value:string):string {return id(value)==='main'?'@dsh/chat':'@dsh/chat/'+value}
export function plainChatWorldbook(value:unknown):unknown {
  if(!helperRecord(value))throw new Error('聊天世界书必须为对象')
  const {[CHAT_WORLDBOOK_META]:_meta,...book}=value
  readHelperWorldbook(book)
  return book
}
export function decodeChatWorldbooks(input:unknown|null):ChatWorldbooks {
  if(input===null)return {active:null,books:new Map()}
  const raw=helperJson(input,CHAT_WORLDBOOK_TOTAL_BYTES)
  if(!helperRecord(raw))throw new Error('聊天世界书文件损坏')
  const meta=raw[CHAT_WORLDBOOK_META],books=new Map<string,unknown>()
  if(meta===undefined)return {active:'main',books:new Map([['main',plainChatWorldbook(raw)]])}
  if(!helperRecord(meta)||meta.version!==1||!helperRecord(meta.books)||Object.keys(meta.books).length>64||Object.keys(meta).some(key=>!['version','active','books'].includes(key)))throw new Error('聊天世界书集合损坏')
  const active=meta.active===null?null:id(meta.active)
  for(const [key,value] of Object.entries(meta.books)){id(key);if(key===active)throw new Error('聊天世界书活动副本冲突');books.set(key,plainChatWorldbook(value))}
  const current=plainChatWorldbook(raw)
  if(active!==null)books.set(active,current)
  else if(readHelperWorldbook(current).entries.length)throw new Error('已解绑聊天世界书仍含活动条目')
  if(books.size>64)throw new Error('聊天世界书超过 64 本预算')
  return {active,books}
}
export function parseChatWorldbookFile(text:string|null):ChatWorldbooks {
  if(text===null)return decodeChatWorldbooks(null)
  // 解析前体量闸：写路径以 2 空格美化落盘，合法值（32MiB 值预算）最坏膨胀约 2 倍字符；
  // 超过 2.5 倍预算必为外部篡改，与 helper.ts/template.ts 的 stat 前置检查同族，
  // 避免被篡改的超大文件造成无界读取与解析期内存尖峰。
  if(text.length>CHAT_WORLDBOOK_TOTAL_BYTES*2.5)throw new Error('聊天世界书文件超限')
  const value:unknown=JSON.parse(text)
  if(value===null)throw new Error('聊天世界书文件损坏')
  return decodeChatWorldbooks(value)
}
export function encodeChatWorldbooks(store:ChatWorldbooks):unknown|null {
  if(store.books.size>64)throw new Error('聊天世界书超过 64 本预算')
  if(store.active!==null&&!store.books.has(store.active))throw new Error('聊天世界书活动目标不存在')
  if(store.books.size===0)return null
  const inactive:Record<string,unknown>=Object.create(null)
  for(const [key,value] of store.books){id(key);const book=plainChatWorldbook(value);if(key!==store.active)inactive[key]=book}
  const current=store.active===null?{entries:{}}:plainChatWorldbook(store.books.get(store.active))
  const output=store.active==='main'&&store.books.size===1?current:{...(current as Record<string,unknown>),[CHAT_WORLDBOOK_META]:{version:1,active:store.active,books:inactive}}
  return helperJson(output,CHAT_WORLDBOOK_TOTAL_BYTES)
}
