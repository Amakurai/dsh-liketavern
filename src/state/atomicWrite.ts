/**
 * 同目录临时文件落盘后替换目标，避免正文或 WAL 被截断；失败保留原文件。
 * 进程在替换前崩溃会留下 `<目标>.<uuid>.tmp`，由 sweepOrphanTemps 在打开数据目录时清理。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 只匹配本模块生成的临时文件名，不碰用户或其它程序的 .tmp。 */
const ORPHAN_TEMP = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 正常写入只持有临时文件几毫秒；超过该时长的一定是崩溃遗留，清理不需要与写入互斥。 */
export const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx')
    try {
      await file.writeFile(data)
      await file.sync()
    } finally { await file.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

/**
 * 递归删除 dir 下超龄的原子写临时文件，返回删除数。不跟随链接；skipDir 以正斜杠相对路径
 * 排除整棵子树（例如由各自剧情打开时清理的 stories/）。目录不存在视为无事可做。
 */
export async function sweepOrphanTemps(dir: string, options?: { now?: number; maxAgeMs?: number; skipDir?: (relDir: string) => boolean }): Promise<number> {
  const cutoff = (options?.now ?? Date.now()) - (options?.maxAgeMs ?? ORPHAN_TEMP_MAX_AGE_MS)
  let removed = 0
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries
    try { entries = await readdir(abs, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const child = join(abs, entry.name)
      if (entry.isDirectory()) {
        if (!options?.skipDir?.(childRel)) await walk(child, childRel)
        continue
      }
      if (!entry.isFile() || !ORPHAN_TEMP.test(entry.name)) continue
      const info = await lstat(child).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info?.isFile() || info.mtimeMs > cutoff) continue
      await rm(child, { force: true })
      removed += 1
    }
  }
  await walk(dir, '')
  return removed
}
