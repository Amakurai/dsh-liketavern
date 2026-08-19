/**
 * 数据目录布局（plan 3.13：插件 profile 数据目录内，JSON/MD 可直接查看备份）。
 *
 * ~/.dsh/dsh-tavern/
 *   characters/<cardId>/    每角色工作区（plan 3.12.1）
 *   library/lorebooks/      导入的全局世界书（ST JSON 原样 + 归一化缓存）
 *   library/presets/        导入的预设（归一化 PromptPreset JSON）
 *   personas/               用户人设（JSON；头像文件同名 .png）
 *   regex/rules.json        全局正则规则
 *   sessions/<sessionId>.json  会话绑定（角色/预设/人设/世界书选择、swipe 状态）
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export interface TavernPaths {
  root: string
  characters: string
  lorebooks: string
  presets: string
  personas: string
  regexDir: string
  sessions: string
}

export function tavernPaths(home?: string): TavernPaths {
  const root = home ? join(home, 'dsh-tavern') : dshHomePath('dsh-tavern')
  return {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
}

export async function ensurePaths(paths: TavernPaths): Promise<void> {
  await Promise.all(
    [paths.characters, paths.lorebooks, paths.presets, paths.personas, paths.regexDir, paths.sessions].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  )
}

/** 会话绑定文件名安全化。 */
export function sessionFile(paths: TavernPaths, sessionId: string): string {
  return join(paths.sessions, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
}
