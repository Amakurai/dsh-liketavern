/**
 * 会话绑定：Tavern 会话 ↔ 角色卡/预设/人设/世界书选择。
 * 存 `sessions/<sessionId>.json`（host 数据目录；不随楼层回滚——绑定不是剧情状态）。
 */
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionFile, type TavernPaths } from './paths.js'

/** 子会话继承的祖先 WAL 边界：仅 throughTurn（含）属于当前分支历史。 */
export interface WalLineageEntry {
  sessionId: string
  throughTurn: number
}

export interface SessionBinding {
  sessionId: string
  cardId: string
  /** 绑定时的角色显示名；删除后按此找回新工作区。旧文件可缺。 */
  cardName?: string
  /** 预设 identifier；null = 内建默认预设。 */
  presetId: string | null
  personaId: string | null
  /** 全局世界书（library 内文件名）。 */
  lorebookIds: string[]
  /** 主世界书（Character Lore）；null = 使用卡内嵌书（若有）。 */
  characterLorebookId: string | null
  /** 会话级交互卡开关；null 跟随全局设置。 */
  interactiveCards: boolean | null
  /** 开场白 swipe 下标（0 = first_mes，1.. = alternate_greetings）。 */
  greetingIndex: number
  /** 会话作者注释，每轮进 turnContext。 */
  authorNote?: string
  /** 是否把角色工作区 journal.md 注入本轮 turn。 */
  injectJournal?: boolean
  /** fork 祖先及各自被继承的最大 turn；旧绑定可缺，视为无祖先。 */
  walLineage?: WalLineageEntry[]
  createdAt: string
}

export async function loadBinding(paths: TavernPaths, sessionId: string): Promise<SessionBinding | null> {
  try {
    const raw = await readFile(sessionFile(paths, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as SessionBinding
    if (parsed.sessionId !== sessionId || typeof parsed.cardId !== 'string') return null
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null // 绑定文件损坏视为未绑定（面板可重选）
  }
}

export async function saveBinding(paths: TavernPaths, binding: SessionBinding): Promise<void> {
  await writeFile(sessionFile(paths, binding.sessionId), JSON.stringify(binding, null, 2) + '\n', 'utf8')
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
        const parsed = JSON.parse(await readFile(abs, 'utf8')) as SessionBinding
        if (parsed.cardId === cardId) await unlink(abs)
      } catch {
        // 坏文件跳过
      }
    }),
  )
}
