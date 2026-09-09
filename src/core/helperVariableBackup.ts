/** 设置中的变量备份校验与整批恢复计划；只处理有界 JSON，沿用剧情变量的 CAS 和单批原子提交限制。 */
import {HELPER_MAX_BYTES,helperChanges,helperJson,helperRecord,helperScopeKey,helperTable,type HelperScopes,type HelperVariableChange} from './helperRuntime.js'

/** 变量表仍为 1 MiB；额外空间只给 version/scopes 封装，保证合法持久快照可以导出后再导入。 */
const MAX_BACKUP_BYTES=HELPER_MAX_BYTES+64

export function parseHelperVariableBackup(text:string,currentMessageId?:number):HelperScopes {
  if(new TextEncoder().encode(text).length>MAX_BACKUP_BYTES)throw new Error('变量备份超过大小上限（变量数据最多 1 MiB）')
  const value=helperJson(JSON.parse(text),MAX_BACKUP_BYTES)
  if(!helperRecord(value)||value.version!==1||!helperRecord(value.scopes))throw new Error('变量备份格式无效')
  for(const [key,table] of Object.entries(value.scopes)){
    helperScopeKey(key)
    if(!helperRecord(table))throw new Error('变量备份中的变量表无效')
  }
  const scopes=value.scopes as HelperScopes
  const legacyKey=JSON.stringify(['message','current'])
  if(currentMessageId!==undefined&&Object.hasOwn(scopes,legacyKey)){
    if(!Number.isSafeInteger(currentMessageId)||currentMessageId<0)throw new Error('变量备份目标消息无效')
    const key=JSON.stringify(['message',currentMessageId])
    if(Object.hasOwn(scopes,key)&&JSON.stringify(scopes[key])!==JSON.stringify(scopes[legacyKey]))throw new Error('变量备份包含冲突的当前消息变量')
    scopes[key]=scopes[legacyKey]!
    delete scopes[legacyKey]
  }
  return helperTable(scopes) as HelperScopes
}

export function helperVariableRestoreChanges(before:HelperScopes,next:HelperScopes):HelperVariableChange[]{
  const changes=[...new Set([...Object.keys(before),...Object.keys(next)])].map(key=>({key,before:before[key]??{},value:next[key]??{}}))
    .filter(change=>JSON.stringify(helperJson(change.before))!==JSON.stringify(helperJson(change.value)))
  return changes.length?helperChanges(changes):[]
}
