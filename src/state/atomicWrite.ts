/**
 * 同目录临时文件落盘后替换目标，避免正文或 WAL 被截断；失败保留原文件。
 * 临时文件使用固定短前缀，避免合法长目标名再追加后缀后超过文件系统上限。
 * 进程在替换前崩溃会留下 `.dsh-tavern-write.<uuid>.tmp`，打开数据目录时回收；兼容旧目标名格式。
 * rename 之后对父目录做一次尽力而为的 fsync：目录项不刷盘时掉电可能丢掉 rename，
 * 正文已替换而 WAL 仍是旧日志，破坏「先 WAL 后正文」的持久性。目录 fsync 只影响崩溃一致性，
 * 不支持（Windows 上 open 目录可成功但 sync 返回 EPERM；部分文件系统同样拒绝）时静默降级，
 * 不把已经提交的写入改报为失败。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 只匹配本模块生成的临时文件名，不碰用户或其它程序的 .tmp。 */
const ORPHAN_TEMP = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 正常写入只持有临时文件几毫秒；超过该时长的一定是崩溃遗留，清理不需要与写入互斥。 */
export const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000

/** 已发布角色/剧情目录不允许被草稿回收删除：它们不带点号前缀，与 `.importing-`/`.preparing-` 天然不冲突。 */
export const DRAFT_PREFIXES = ['.importing-', '.preparing-'] as const

/**
 * 目录 fsync：只在 rename/mkdir 之后调用，任何失败都吞掉（含 Windows 的 EPERM）。
 * 失败只意味着这次提交的目录项在掉电时可能丢失，不代表本次写入失败。
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle
  try { handle = await open(dir, 'r') } catch { return }
  try { await handle.sync() } catch { /* 平台/文件系统不支持目录同步：尽力而为 */ }
  finally { await handle.close().catch(() => {}) }
}

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path)
  // 新建目录链的目录项也要刷盘；已存在的目录不重复 sync，避免每次写入都多走一趟父目录。
  const existed = await stat(dir).then(() => true, () => false)
  await mkdir(dir, { recursive: true })
  if (!existed) await syncDirectory(dirname(dir))
  const temp = join(dir, `.dsh-tavern-write.${randomUUID()}.tmp`)
  let owned = false
  try {
    const file = await open(temp, 'wx')
    owned = true
    try {
      await file.writeFile(data)
      await file.sync()
    } catch (error) {
      // 保留最先发生的写入/同步错误；关闭和清理只做尽力收尾。
      await file.close().catch(() => {})
      throw error
    }
    await file.close()
    await rename(temp, path)
    // rename 已经移走临时文件并提交正文；随后的目录 fsync 只做尽力而为，失败不改报结果。
    await syncDirectory(dir)
  } catch (error) {
    // wx 失败时未取得文件所有权；即使碰撞也不能删除其它调用的临时文件。
    if (owned) await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export interface SweepOrphanTempsOptions {
  now?: number
  maxAgeMs?: number
  skipDir?: (relDir: string) => boolean
  /** 只删除被扫目录本层、名字以这些前缀开头且超龄的目录（崩溃遗留的导入/分支草稿）。 */
  draftPrefixes?: readonly string[]
  /** false 时只处理被扫目录本层，不递归子树（草稿回收用）。 */
  recursive?: boolean
}

/**
 * 递归删除 dir 下超龄的原子写临时文件，返回删除数。不跟随链接；skipDir 以正斜杠相对路径
 * 排除整棵子树（例如由各自剧情打开时清理的 stories/）。目录不存在视为无事可做。
 * `draftPrefixes` 额外回收被扫目录本层、按前缀命名且超龄的草稿目录：
 * 已发布的角色目录（cardId）与剧情目录（story-<uuid>/legacy-<hex>）不带这些前缀，绝不在删除范围内。
 */
export async function sweepOrphanTemps(dir: string, options?: SweepOrphanTempsOptions): Promise<number> {
  const cutoff = (options?.now ?? Date.now()) - (options?.maxAgeMs ?? ORPHAN_TEMP_MAX_AGE_MS)
  const recursive = options?.recursive !== false
  let removed = 0
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries
    try {
      // readdir 会跟随入口链接；根目录也必须检查，递归时再复核一次目录身份。
      // 只检查本工作区入口，不拒绝安装路径祖先的正常挂载。
      if ((await lstat(abs)).isSymbolicLink()) return
      entries = await readdir(abs, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const child = join(abs, entry.name)
      if (entry.isDirectory()) {
        // 草稿目录只在被扫目录本层识别：点号前缀 + 超龄，缺一不可；已发布目录不带前缀。
        const draft = rel === '' && options?.draftPrefixes?.some((prefix) => entry.name.startsWith(prefix))
        if (draft) {
          const info = await lstat(child).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
          if (!info?.isDirectory() || info.mtimeMs > cutoff) continue
          await rm(child, { recursive: true, force: true })
          removed += 1
          continue
        }
        if (recursive && !options?.skipDir?.(childRel)) await walk(child, childRel)
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
  // 去掉末尾分隔符，避免 lstat 在部分平台把链接入口当成目标目录。
  await walk(resolve(dir), '')
  return removed
}
