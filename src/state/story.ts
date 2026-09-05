/** 剧情状态快照：角色资产共享，记忆/变化层/笔记/聊天世界书/WAL 按剧情隔离；先准备再原子发布。 */
import { randomUUID, createHash } from 'node:crypto'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { rebuildIndex } from './workspace.js'
import { estimateTokens } from '../core/tokenize.js'
import { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'

export interface StorySummary {
  id: string
  sessionId: string
  createdAt: string
  migrated: boolean
}

export function newStoryId(): string { return `story-${randomUUID()}` }
export function legacyStoryId(sessionId: string): string {
  return `legacy-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
}

export function storyRoot(cardRoot: string, id: string): string {
  if (!/^(?:story-[a-f0-9-]{36}|legacy-[a-f0-9]{32})$/.test(id)) throw new Error('非法的剧情状态 ID')
  return join(cardRoot, 'stories', id)
}

/** 剧情的可变路径；其它资产由角色工作区提供。 */
export function isStoryPath(path: string): boolean {
  return path === 'journal.md' || path === 'index.json' || path === 'assets/chat-lorebook.json'
    || path.startsWith('memory/') || path.startsWith('state/')
}

export async function readStory(cardRoot: string, id: string): Promise<StorySummary> {
  for (const path of [join(cardRoot, 'stories'), storyRoot(cardRoot, id)]) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('剧情状态目录不能是链接')
  }
  const raw = await new WorkspaceFs(storyRoot(cardRoot, id), null).readText('story.json')
  if (raw === null) throw new Error('剧情状态不存在，已停止操作以免写入错误工作区')
  const value = JSON.parse(raw) as Partial<StorySummary> & { version?: number }
  if (value.version !== 1 || value.id !== id || typeof value.sessionId !== 'string'
    || typeof value.createdAt !== 'string' || typeof value.migrated !== 'boolean') throw new Error('剧情状态元数据损坏')
  return { id, sessionId: value.sessionId, createdAt: value.createdAt, migrated: value.migrated }
}

export async function listStories(cardRoot: string): Promise<StorySummary[]> {
  const entries = await readdir(join(cardRoot, 'stories'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const items: StorySummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(story-|legacy-)/.test(entry.name)) continue
    // 已发布状态损坏必须报告；.preparing-* 是未发布草稿，不会列为可选剧情。
    items.push(await readStory(cardRoot, entry.name))
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 只复制剧情状态，不复制卡片、图片或其它剧情。锁住来源，保证多文件快照一致。 */
export async function snapshotStory(options: {
  cardRoot: string; sourceRoot: string; id: string; sessionId: string; migrated?: boolean; includeWal?: boolean
  prepare?: (fs: WorkspaceFs) => Promise<void>
}): Promise<void> {
  const target = storyRoot(options.cardRoot, options.id)
  await withWorkspaceLock(options.sourceRoot, async () => {
    const parent = await lstat(join(options.cardRoot, 'stories')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (parent?.isSymbolicLink()) throw new Error('剧情状态父目录不能是链接')
    if (await new WorkspaceFs(target, null).exists('story.json')) return
    const staging = join(options.cardRoot, 'stories', `.preparing-${randomUUID()}`)
    const source = new WorkspaceFs(options.sourceRoot, null)
    const dest = new WorkspaceFs(staging, null)
    try {
      // 先检查所有可遍历的父目录，不能只检查末级文件：目录 junction 也会越界。
      for (const directory of ['', 'memory', 'assets', 'state', 'state/wi-timers', 'state/wal']) {
        const info = await lstat(join(options.sourceRoot, directory)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (info?.isSymbolicLink()) throw new Error(`剧情快照不支持链接目录：${directory}`)
      }
      await dest.ensureDir()
      const paths = ['journal.md', 'assets/chat-lorebook.json', 'state/world-delta.jsonl', 'state/template.json']
      for (const directory of ['memory', 'state/wi-timers', ...(options.includeWal ? ['state/wal'] : [])]) {
        for (const file of await source.list(directory)) paths.push(`${directory}/${file}`)
      }
      for (const path of paths) {
        // 外部链接不属于快照；避免本机手改的 junction/symlink 把其它目录带进分支。
        const info = await lstat(join(options.sourceRoot, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (!info) continue
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`剧情快照不支持链接或目录文件：${path}`)
        const bytes = await source.readBytes(path)
        if (bytes !== null) await dest.writeBytes(path, bytes)
      }
      await options.prepare?.(dest)
      await rebuildIndex(dest, estimateTokens)
      await dest.writeText('story.json', JSON.stringify({ version: 1, id: options.id,
        sessionId: options.sessionId, createdAt: new Date().toISOString(), migrated: options.migrated ?? false }) + '\n')
      await rename(staging, target)
    } finally {
      // 只清理本次生成且确认位于 stories 内的草稿，已发布状态从不在失败清理中删除。
      const base = resolve(options.cardRoot, 'stories') + sep
      if (!resolve(staging).startsWith(base)) throw new Error('剧情草稿清理路径越界')
      await rm(staging, { recursive: true, force: true })
    }
  })
}

/** 仅供创建分支失败时清理刚创建、尚未绑定的副本，调用方负责复核绑定。 */
export async function discardStory(cardRoot: string, id: string, sessionId: string): Promise<void> {
  const metadata = await readStory(cardRoot, id)
  if (metadata.sessionId !== sessionId || metadata.migrated) throw new Error('拒绝清理不属于本次分支的剧情')
  const target = resolve(storyRoot(cardRoot, id))
  if (!target.startsWith(resolve(cardRoot, 'stories') + sep)) throw new Error('剧情清理路径越界')
  await rm(target, { recursive: true, force: true })
}
