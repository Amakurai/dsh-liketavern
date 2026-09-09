/** 旧 lorebook 浏览器接口复用现代世界书业务桥；updater 在沙箱执行，局部更新保留未指定条目和字段。 */
import type {HelperWorldbookEntry} from './helperWorldbook.js'
import type {HelperLorebookCodec,HelperLorebookEntry} from './helperLorebook.js'
interface WorldbookApi {
  getWorldbookNames():string[]
  getCharWorldbookNames(character:string):{primary:string|null;additional:string[]}
  rebindCharWorldbooks(character:string,input:unknown,partial?:boolean):Promise<void>
  rebindChatWorldbook(chat:string,input:unknown):Promise<void>
  getChatWorldbookName(chat:string):string|null
  getOrCreateChatWorldbook(chat:string,label?:string):Promise<string>
  createWorldbook(book:string,entries?:unknown):Promise<boolean>
  deleteWorldbook(book:string):Promise<boolean>
  getWorldbook(book:string):Promise<HelperWorldbookEntry[]>
  updateWorldbookWith(book:string,updater:(entries:HelperWorldbookEntry[])=>unknown):Promise<HelperWorldbookEntry[]>
  createWorldbookEntries(book:string,input:unknown):Promise<{worldbook:HelperWorldbookEntry[];new_entries:HelperWorldbookEntry[]}>
  deleteWorldbookEntries(book:string,predicate:(entry:HelperWorldbookEntry)=>boolean):Promise<{worldbook:HelperWorldbookEntry[];deleted_entries:HelperWorldbookEntry[]}>
}
export function installCardLorebook(modern:WorldbookApi,codec:HelperLorebookCodec):void {
  const legacy=(entries:HelperWorldbookEntry[])=>entries.map(codec.toLegacy)
  const api={getLorebooks:()=>modern.getWorldbookNames(),createLorebook:(book:string)=>modern.createWorldbook(book),deleteLorebook:(book:string)=>modern.deleteWorldbook(book),
    getCharLorebooks:(options:{name?:string;type?:'all'|'primary'|'additional'}={})=>{
      if(!options||typeof options!=='object'||Array.isArray(options)||!['all','primary','additional'].includes(options.type??'all'))throw new Error('旧角色世界书查询选项无效')
      const current=modern.getCharWorldbookNames(options.name??'current')
      return {primary:options.type==='additional'?null:current.primary,additional:options.type==='primary'?[]:current.additional}
    },
    setCurrentCharLorebooks:(input:unknown)=>modern.rebindCharWorldbooks('current',input,true),
    setChatLorebook:(input:string|null)=>modern.rebindChatWorldbook('current',input),
    getCurrentCharPrimaryLorebook:()=>modern.getCharWorldbookNames('current').primary,
    getChatLorebook:()=>modern.getChatWorldbookName('current'),getOrCreateChatLorebook:(name?:string)=>modern.getOrCreateChatWorldbook('current',name),
    getLorebookEntries:async(book:string,options:{filter?:unknown}={})=>{
      if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('旧世界书查询选项无效')
      return codec.filter(legacy(await modern.getWorldbook(book)),options.filter)
    },
    replaceLorebookEntries:async(book:string,input:unknown):Promise<void>=>{await modern.updateWorldbookWith(book,before=>codec.replace(input,before))},
    updateLorebookEntriesWith:async(book:string,updater:(entries:HelperLorebookEntry[])=>unknown)=>{
      if(typeof updater!=='function')throw new Error('旧世界书更新器必须是函数')
      return legacy(await modern.updateWorldbookWith(book,async before=>codec.replace(await updater(legacy(before)),before)))
    },
    setLorebookEntries:async(book:string,input:unknown)=>legacy(await modern.updateWorldbookWith(book,before=>codec.patch(input,before))),
    createLorebookEntries:async(book:string,input:unknown)=>{
      const result=await modern.createWorldbookEntries(book,codec.replace(input))
      return {entries:legacy(result.worldbook),new_uids:result.new_entries.map(entry=>entry.uid)}
    },
    deleteLorebookEntries:async(book:string,input:unknown)=>{
      const ids=new Set(codec.ids(input)),result=await modern.deleteWorldbookEntries(book,entry=>ids.has(entry.uid))
      return {entries:legacy(result.worldbook),delete_occurred:result.deleted_entries.length>0}
    },
  }
  Object.assign(window,api);const root=window as unknown as Record<string,unknown>;root.TavernHelper=Object.assign(root.TavernHelper??{},api)
}
