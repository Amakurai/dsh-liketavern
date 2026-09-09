/**
 * 会话绑定：Tavern 会话 ↔ 角色卡/预设/人设/世界书选择。
 * 存 `sessions/<sessionId>.json`（host 数据目录；不随楼层回滚——绑定不是剧情状态）。
 * SessionBinding / WalLineageEntry 是纯数据形状，定义在 core/binding（remote 契约引用），此处 re-export。
 * 读写共用 parseSessionBinding 严格校验（RPC 宽松传输、存储层严格校验的落点），不再 as 断言。
 */
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionFile, type TavernPaths } from './paths.js'
import { assertValidCardId } from '../state/workspace.js'
import type { SessionBinding, WalLineageEntry } from '../core/binding.js'
import {helperWorldbookSettingsCodec} from '../core/helperWorldbookSettings.js'
import { atomicWrite } from '../state/atomicWrite.js'
import { storyRoot } from '../state/story.js'

export type { SessionBinding, WalLineageEntry } from '../core/binding.js'

function invalidBinding(field: string, expect: string): never {
  throw new Error(`会话绑定字段 ${field} 非法：期望${expect}`)
}

/**
 * 会话绑定的严格解析：必填字段缺失或类型错误即抛错，未知字段丢弃（对齐 RPC schema 的 strip 行为）。
 * service.setSessionBinding 与本文件的 load/save 共用这一个校验点；
 * interactiveCards（会话级交互卡开关，boolean | null）原样透传——客户端依它做渲染决策。
 */
export function parseSessionBinding(input: unknown): SessionBinding {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidBinding('(root)', '对象')
  const raw = input as Record<string, unknown>

  const requiredString = (field: string): string => {
    const value = raw[field]
    if (typeof value !== 'string' || value.length === 0) invalidBinding(field, '非空字符串')
    return value
  }
  const nullableString = (field: string): string | null => {
    const value = raw[field]
    if (value === null) return null
    if (typeof value !== 'string') invalidBinding(field, '字符串或 null')
    return value
  }
  const optionalString = (field: string): string | undefined => {
    const value = raw[field]
    if (value === undefined) return undefined
    if (typeof value !== 'string') invalidBinding(field, '字符串')
    return value
  }
  const optionalBoolean = (field: string): boolean | undefined => {
    const value = raw[field]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') invalidBinding(field, '布尔值')
    return value
  }

  const sessionId = requiredString('sessionId')
  const cardId = requiredString('cardId')
  // cardId 是 characters/ 下的单层目录名；格式不对直接拒绝（防路径越界，与工作区入口同一帮手）。
  assertValidCardId(cardId)
  const storyId = optionalString('storyId')
  if (storyId !== undefined) storyRoot('.', storyId)

  const lorebookIdsRaw = raw['lorebookIds']
  if (!Array.isArray(lorebookIdsRaw)) invalidBinding('lorebookIds', '字符串数组')
  const lorebookIds = lorebookIdsRaw.map((id, i) => {
    if (typeof id !== 'string') invalidBinding(`lorebookIds[${i}]`, '字符串')
    return id
  })

  const interactiveCardsRaw = raw['interactiveCards']
  let interactiveCards: boolean | null
  if (interactiveCardsRaw === null) interactiveCards = null
  else if (typeof interactiveCardsRaw === 'boolean') interactiveCards = interactiveCardsRaw
  else invalidBinding('interactiveCards', '布尔值或 null')

  const greetingIndex = raw['greetingIndex']
  if (typeof greetingIndex !== 'number' || !Number.isSafeInteger(greetingIndex) || greetingIndex < 0) {
    invalidBinding('greetingIndex', '非负整数')
  }

  const walLineageRaw = raw['walLineage']
  let walLineage: WalLineageEntry[] | undefined
  if (walLineageRaw !== undefined) {
    if (!Array.isArray(walLineageRaw)) invalidBinding('walLineage', '数组')
    walLineage = walLineageRaw.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalidBinding(`walLineage[${i}]`, '对象')
      const item = entry as Record<string, unknown>
      const entrySessionId = item['sessionId']
      if (typeof entrySessionId !== 'string' || entrySessionId.length === 0) {
        invalidBinding(`walLineage[${i}].sessionId`, '非空字符串')
      }
      const throughTurn = item['throughTurn']
      if (typeof throughTurn !== 'number' || !Number.isSafeInteger(throughTurn) || throughTurn < 0) {
        invalidBinding(`walLineage[${i}].throughTurn`, '非负整数')
      }
      return { sessionId: entrySessionId, throughTurn }
    })
  }

  return {
    sessionId,
    cardId,
    storyId,
    cardName: optionalString('cardName'),
    presetId: nullableString('presetId'),
    personaId: nullableString('personaId'),
    lorebookIds,
    characterLorebookId: nullableString('characterLorebookId'),
    useEmbeddedLorebook: optionalBoolean('useEmbeddedLorebook'),
    characterLorebookIds: raw.characterLorebookIds===undefined?undefined:(()=>{
      if(!Array.isArray(raw.characterLorebookIds)||raw.characterLorebookIds.length>64||raw.characterLorebookIds.some(id=>typeof id!=='string'||!id))invalidBinding('characterLorebookIds','至多 64 项的非空字符串数组')
      return [...new Set(raw.characterLorebookIds as string[])]
    })(),
    worldInfo:raw.worldInfo===undefined?undefined:helperWorldbookSettingsCodec.nativePatch(raw.worldInfo),
    interactiveCards,
    helperMvu:optionalBoolean('helperMvu'),
    greetingIndex,
    authorNote: optionalString('authorNote'),
    injectJournal: optionalBoolean('injectJournal'),
    walLineage,
    createdAt: requiredString('createdAt'),
  }
}

export async function loadBinding(paths: TavernPaths, sessionId: string): Promise<SessionBinding | null> {
  try {
    const parsed = parseSessionBinding(JSON.parse(await readFile(sessionFile(paths, sessionId), 'utf8')))
    if (parsed.sessionId !== sessionId) return null
    return parsed
  } catch {
    // 文件不存在（ENOENT）、JSON 损坏或字段校验失败都视为未绑定（面板可重选）。
    return null
  }
}

export async function saveBinding(paths: TavernPaths, binding: SessionBinding): Promise<void> {
  // 写入侧严格校验（sessionId 非空、cardId 目录名格式在 parse 内检查）：坏数据不落盘，
  // 否则合法 JSON 但字段缺失的绑定要到使用点才抛错。
  const checked = parseSessionBinding(binding)
  await atomicWrite(sessionFile(paths, checked.sessionId), JSON.stringify(checked, null, 2) + '\n')
}

export async function deleteBinding(paths: TavernPaths, sessionId: string): Promise<void> {
  try {
    await unlink(sessionFile(paths, sessionId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** 删除角色卡时清掉仍指向该 cardId 的会话绑定，避免封面页继续显示文件夹 ID。 */
export async function clearBindingsForCard(paths: TavernPaths, cardId: string): Promise<void> {
  let files: string[] = []
  try {
    files = await readdir(paths.sessions)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith('.json')) return
      const abs = join(paths.sessions, file)
      try {
        const parsed = parseSessionBinding(JSON.parse(await readFile(abs, 'utf8')))
        if (parsed.cardId === cardId) await unlink(abs)
      } catch {
        // 坏文件跳过
      }
    }),
  )
}
