/** 剧情级酒馆助手状态：完整验证后 CAS 更新，每次写入经过当前楼层 WAL，支持分支和重启。 */
import { helperChanges, helperRecord, helperScopeKey, helperTable, type HelperScopes, type HelperVariableChange } from '../core/helperRuntime.js'
import {parseHelperSwipes,type HelperSwipeSet} from '../core/helperSwipes.js'
import {parseHelperMvuState,type HelperMvuState} from '../core/helperMvu.js'
import type { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'

export const HELPER_STATE_PATH = 'state/helper.json'
export interface HelperState {scopes:HelperScopes;extras:Record<string,Record<string,unknown>>;swipes?:Record<string,HelperSwipeSet>;mvu?:HelperMvuState}
export async function loadHelperState(fs: WorkspaceFs): Promise<HelperState> {
  const info = await fs.stat(HELPER_STATE_PATH)
  if (info && info.size > 4 * 1024 * 1024) throw new Error('酒馆助手状态文件超限')
  const raw = await fs.readText(HELPER_STATE_PATH)
  if (raw === null) return {scopes:{},extras:{}}
  const parsed: unknown = JSON.parse(raw)
  if (!helperRecord(parsed) || parsed.version !== 1 || !helperRecord(parsed.scopes)) throw new Error('酒馆助手状态文件损坏')
  const scopes = helperTable(parsed.scopes) as HelperScopes
  for (const [key, table] of Object.entries(scopes)) { helperScopeKey(key); helperTable(table) }
  const extras=helperTable(parsed.extras===undefined?{}:parsed.extras) as HelperState['extras']
  for(const [id,table] of Object.entries(extras)){if(!id||id.length>256)throw new Error('消息身份无效');helperTable(table)}
  const rawSwipes=helperTable(parsed.swipes===undefined?{}:parsed.swipes),swipes:Record<string,HelperSwipeSet>={}
  for(const [id,value] of Object.entries(rawSwipes)){if(!id||id.length>256)throw new Error('消息身份无效');swipes[id]=parseHelperSwipes(value)}
  return {scopes,extras,swipes,...(parsed.mvu===undefined?{}:{mvu:parseHelperMvuState(parsed.mvu)})}
}
export async function loadHelperScopes(fs:WorkspaceFs):Promise<HelperScopes>{return (await loadHelperState(fs)).scopes}
/** 同文件保存变量与 extra，整批在一次原子正文替换中生效。 */
export async function saveHelperState(fs:WorkspaceFs,state:HelperState):Promise<void>{
  if(!fs.currentFloor)throw new Error('酒馆助手剧情写入必须绑定楼层')
  const scopes=helperTable(state.scopes),extras=helperTable(state.extras)
  for(const [key,table] of Object.entries(scopes)){helperScopeKey(key);helperTable(table)}
  for(const [id,table] of Object.entries(extras)){if(!id||id.length>256)throw new Error('消息身份无效');helperTable(table)}
  const swipes=helperTable(state.swipes??{})
  for(const [id,value] of Object.entries(swipes)){if(!id||id.length>256)throw new Error('消息身份无效');parseHelperSwipes(value)}
  const raw=JSON.stringify({version:1,scopes,...(Object.keys(extras).length?{extras}:{}),...(Object.keys(swipes).length?{swipes}:{}),...(state.mvu===undefined?{}:{mvu:parseHelperMvuState(state.mvu)})})
  if(Buffer.byteLength(raw)>4*1024*1024)throw new Error('酒馆助手状态文件超限')
  if(await fs.readText(HELPER_STATE_PATH)!==raw){
    try{await fs.writeText(HELPER_STATE_PATH,raw)}
    catch(error){if(await fs.readText(HELPER_STATE_PATH)!==raw)throw error}
  }
}
export function applyHelperChanges(scopes: HelperScopes, changes: HelperVariableChange[]): HelperScopes {
  const next = {...scopes}
  for (const change of changes) {
    const previous = JSON.stringify(scopes[change.key] ?? {}), value = JSON.stringify(change.value)
    if (previous !== JSON.stringify(change.before) && previous !== value) throw new Error('酒馆助手变量已被另一卡面修改，请刷新后重试')
    next[change.key] = change.value
  }
  return helperTable(next) as HelperScopes
}
export async function commitHelperChanges(fs: WorkspaceFs, changes: HelperVariableChange[]): Promise<HelperScopes> {
  if (!fs.currentFloor) throw new Error('酒馆助手剧情写入必须绑定楼层')
  return withWorkspaceLock(fs.root, async () => {
    const state=await loadHelperState(fs),next=applyHelperChanges(state.scopes,helperChanges(changes))
    await saveHelperState(fs,{...state,scopes:next})
    return next
  })
}
