/** 从当前角色和当前人设的固定头像文件生成冻结 URL；不采信资产 JSON 中的任意路径或远程地址。 */
import { Buffer } from 'node:buffer'
import { templateAvatarPng } from '../core/templateAvatar.js'
import type { Persona } from '../core/persona.js'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { openLedger, writtenSince } from '../state/writeLedger.js'
import type { TavernState } from './state.js'

const AVATAR_CACHE_MAX = 32
const avatarCache = new Map<string, { mtimeMs: number; size: number; revision: number; epoch: number; url: string }>()

async function readAvatar(fs:WorkspaceFs,file:string):Promise<string> {
  const ledger=openLedger(fs.root)
  const revision=ledger.counter,epoch=ledger.epoch
  const info=await fs.stat(file)
  if(!info || info.size>32*1024*1024) return ''
  const key=`${fs.root}:${file}`
  const cached=avatarCache.get(key)
  if(cached && cached.epoch===epoch && cached.mtimeMs===info.mtimeMs && cached.size===info.size && !writtenSince(ledger,file,cached.revision)) return cached.url
  const raw=await fs.readBytes(file)
  const png=raw && templateAvatarPng(raw)
  const url=png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : ''
  const after=await fs.stat(file)
  if(after && after.mtimeMs===info.mtimeMs && after.size===info.size && !writtenSince(ledger,file,revision) && ledger.epoch===epoch) {
    if(avatarCache.size>=AVATAR_CACHE_MAX && !avatarCache.has(key)) {
      const oldest=avatarCache.keys().next().value
      if(oldest!==undefined) avatarCache.delete(oldest)
    }
    avatarCache.set(key,{mtimeMs:info.mtimeMs,size:info.size,revision,epoch,url})
  }
  return url
}

export async function loadTemplateAvatars(state:TavernState,cardId:string,persona:Persona|null):Promise<{charAvatar:string;userAvatar:string}> {
  // Persona 的契约是 personas/<id>.png；头像字段不能扩大到其他人设、卡片或剧情文件。
  const validPersona=persona && typeof persona.id==='string' && /^[\p{L}\p{N}_.-]+$/u.test(persona.id)
    && !persona.id.includes('..') && persona.avatar===`${persona.id}.png`
  const [character,userAvatar]=await Promise.all([
    state.workspace(cardId),
    validPersona ? readAvatar(new WorkspaceFs(state.paths.personas,null),`${persona.id}.png`) : Promise.resolve(''),
  ])
  const charAvatar=await readAvatar(character.fs,'card.png')
  return {charAvatar,userAvatar}
}
