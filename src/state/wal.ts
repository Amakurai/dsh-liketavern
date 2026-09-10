/**
 * 事务层（WAL）：楼层级写入快照与回滚。
 * agent 每次写入先经 recordChange() 持久化前后镜像，再原子替换正文。
 * 回退逆序撤销本层修改，保留后续手动编辑；世界状态按条目合并撤销。
 * record()/recordAfter() 仅保留旧调用兼容，新写入不得使用后补快照协议。
 *
 * 磁盘布局（rootDir 为工作区的 state/wal/ 目录）：
 *   <root>/<floor>/meta.json      楼层事务元数据（committed/时间戳）
 *   <root>/<floor>/records.jsonl  每次修改的 before/after 及其显式编码
 * 回滚后楼层目录改名为 <floor>.rolled-back-<timestamp>，保留供调试（UI 不展示）。
 */

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WalRecord } from '../core/types.js'
import { undoWorldDelta } from '../core/walUndo.js'
import { atomicWrite } from './atomicWrite.js'
import { withWorkspaceLock } from './workspaceLock.js'
import { expandAffectedMemories } from './memoryRollback.js'
import { WorkspaceFs } from './workspaceFs.js'
import { rebuildIndex } from './workspace.js'
import { estimateTokens } from '../core/tokenize.js'

// ---------------------------------------------------------------------------
// 磁盘格式
// ---------------------------------------------------------------------------

/** records.jsonl 单行形状（floor 由所在目录承载，行内不重复）。after/编码字段兼容旧记录。 */
type RecordLine = Omit<WalRecord, 'floor'>

/** 回滚恢复游标；pending 的前后镜像始终为标准 base64，null 表示文件不存在。 */
interface RollbackProgress {
  hash: string
  next: number
  restored: string[]
  preserved: string[]
  pending?: { path: string; from: string | null; to: string | null }
}

/** meta.json 形状：楼层事务元数据。 */
interface FloorMeta {
  floor: string
  startedAt: string
  committed: boolean
  committedAt?: string
  /** 回滚时刻（prune 以此为据判断过期）。 */
  rolledBackAt?: string
  /** 与楼层写入不同的后续修订被保留，供检查回滚结果。 */
  preservedPaths?: string[]
}

/** listFloors() 返回元素。 */
export interface WalFloorInfo {
  floor: string
  committed: boolean
  startedAt: string
  rolledBack: boolean
}

/** rollbackAfter() 返回形状。 */
export interface RollbackAfterResult {
  /** 实际恢复/删除的路径（各楼层 rollbackFloor 返回的合并）。 */
  restored: string[]
  /** 已不存在（含已回滚）而被跳过的楼层。 */
  skipped: string[]
}

/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
const ROLLED_BACK_MARK = '.rolled-back-'

/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export const WAL_BINARY_MARK = 'binary-base64:'

/** Buffer 的 base64 解码会忽略坏字符和截断；必须往返一致才允许用作恢复镜像。 */
function isBase64(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 楼层 id → 目录名：非法字符替换为 '_'（同字符冲突由调用方保证不出现）。 */
function sanitizeFloor(floor: string): string {
  return floor.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** 目录改名用时间戳：纯数字（毫秒精度），避开 Windows 文件名非法字符。 */
function timestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, '')
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Wal
// ---------------------------------------------------------------------------

/**
 * 两条世界状态快照是否改动了同一批 id。快照来自正文原样镜像，而正文读写（WorldDeltaStore、undoWorldDelta）
 * 都刻意保留无法解析的行；这里同样只按能解析出字符串 id 的行比较，坏行不能让预检抛出原始解析错误。
 */
function deltaChangesOverlap(a: RecordLine, b: RecordLine): boolean {
  const changed = (rec: RecordLine) => {
    const rows = (text: string | null | undefined) => new Map((text ?? '').split('\n').filter((line) => line.trim()).flatMap((line) => {
      let id: unknown
      try { id = (JSON.parse(line) as { id?: unknown } | null)?.id } catch { return [] }
      return typeof id === 'string' ? [[id, line] as const] : []
    }))
    const before = rows(rec.before), after = rows(rec.after)
    return new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)))
  }
  const ids = changed(a)
  return [...changed(b)].some((id) => ids.has(id))
}

/** before 与 after 字节相同的记录：恢复时不改文件，既不会被复活，也不能作为别的楼层的依赖锚点。 */
function isNoopRecord(rec: RecordLine): boolean {
  return 'after' in rec && rec.before === rec.after && (rec.beforeEncoding ?? 'utf8') === (rec.afterEncoding ?? 'utf8')
}

export class Wal {
  private readonly rootDir: string
  /** 实例内 promise 队列：所有公共方法串行化，保证并发安全。 */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * 楼层目录名 → 记录状态（paths 用于同层同路径去重，seq 为已用最大序号）。
   * 全部公共方法按 floor 参数化、状态按楼层目录分键：多个未提交楼层可以并存
   * （同一张卡的并发会话各开各的 `sessionId#tN`），本类没有单态「当前楼层」。
   */
  private readonly states = new Map<string, { paths: Set<string>; seq: number }>()

  /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** 开始一个楼层事务；对已存在且未 commit 的同名单元报错（防止跨会话串层）。 */
  beginFloor(floor: string): Promise<void> {
    return this.enqueue(() => this.doBeginFloor(floor))
  }

  /** 在即将写入 path 前记录快照；同层同路径只留首次快照，重复调用忽略。path 统一为正斜杠相对路径。 */
  record(floor: string, path: string, before: string | null, beforeEncoding?: 'utf8' | 'base64'): Promise<void> {
    return this.enqueue(() => this.doRecord(floor, path, before, beforeEncoding))
  }

  /** 写入完成后补记 after 快照，用于回滚前识别楼层外的人工修改。 */
  recordAfter(floor: string, path: string, after: string | null, afterEncoding?: 'utf8' | 'base64'): Promise<void> {
    return this.enqueue(() => this.doRecordAfter(floor, path, after, afterEncoding))
  }

  /** 每次修改独立记录 before/after，必须在正文原子替换之前持久化。 */
  recordChange(floor: string, path: string, before: string | null, after: string | null,
    beforeEncoding: 'utf8' | 'base64', afterEncoding: 'utf8' | 'base64'): Promise<void> {
    return this.enqueue(async () => {
      const dirName = sanitizeFloor(floor)
      const dir = join(this.rootDir, dirName)
      if (!(await isDir(dir))) throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`)
      const state = await this.loadState(dirName)
      const file = join(dir, 'records.jsonl')
      const text = await readFile(file, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      })
      const record: RecordLine = { seq: state.seq + 1, path: path.replace(/\\/g, '/'), before, after, beforeEncoding, afterEncoding }
      await atomicWrite(file, text + (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(record) + '\n')
      state.seq = record.seq
      state.paths.add(record.path)
    })
  }

  /** 提交楼层：meta.committed=true 并记录 committedAt。 */
  commitFloor(floor: string): Promise<void> {
    return this.enqueue(() => this.doCommitFloor(floor))
  }

  /** 已完成楼层追加受控事务前重新标记未收口；保留全部快照和时间，先验证整层，不能用旧 committed 掩盖新写入失败。 */
  reopenFloor(floor: string): Promise<void> {
    return this.enqueue(async () => {
      const dir = join(this.rootDir, sanitizeFloor(floor))
      if (!(await isDir(dir))) throw new Error(`WAL 楼层缺失或已回滚：${floor}`)
      const meta = await this.readMeta(dir)
      if (!meta || meta.floor !== floor) throw new Error(`WAL 楼层元数据不匹配：${floor}`)
      await this.readRecords(dir)
      if (!meta.committed) return
      meta.committed = false
      delete meta.committedAt
      await this.writeMeta(dir, meta)
    })
  }

  /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
  rollbackFloor(floor: string, workspaceRoot: string): Promise<string[]> {
    return withWorkspaceLock(workspaceRoot, () => this.enqueue(async () => {
      await this.preflightRollback([floor])
      return this.doRollbackFloor(floor, workspaceRoot)
    }))
  }

  /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
  rollbackAfter(floors: string[], workspaceRoot: string): Promise<RollbackAfterResult> {
    return withWorkspaceLock(workspaceRoot, () => this.enqueue(() => this.doRollbackAfter(floors, workspaceRoot)))
  }

  /** 列出全部楼层（含已回滚，rolledBack: true），按 startedAt 升序。 */
  listFloors(): Promise<WalFloorInfo[]> {
    return this.enqueue(() => this.doListFloors())
  }

  /** 恢复前只读检查原楼层：元数据、序号、路径与全部快照都必须有效，不把坏记录当成空日志。 */
  validateFloor(floor: string): Promise<WalFloorInfo> {
    return this.enqueue(async () => {
      const dir = join(this.rootDir, sanitizeFloor(floor))
      if (!(await isDir(dir))) throw new Error(`WAL 楼层缺失或已回滚：${floor}`)
      const meta = await this.readMeta(dir)
      if (!meta || meta.floor !== floor) throw new Error(`WAL 楼层元数据不匹配：${floor}`)
      await this.readRecords(dir)
      return { floor, committed: meta.committed, startedAt: meta.startedAt, rolledBack: false }
    })
  }

  /** 删除已回滚且早于 keepRolledBackDays（默认 7）的楼层目录，返回删除数。 */
  prune(options: { keepRolledBackDays?: number }): Promise<number> {
    return this.enqueue(() => this.doPrune(options))
  }

  // -------------------------------------------------------------------------
  // 队列与读写原语
  // -------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // 失败不阻断后续操作，队列永远向前推进
    this.queue = run.catch(() => undefined)
    return run
  }

  private async readMeta(dir: string): Promise<FloorMeta | null> {
    const raw = await readFile(join(dir, 'meta.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return null
    let meta: FloorMeta
    try { meta = JSON.parse(raw) as FloorMeta } catch { throw new Error(`WAL 元数据损坏：${dir}`) }
    if (!meta || typeof meta.floor !== 'string' || !meta.floor || typeof meta.startedAt !== 'string'
      || !Number.isFinite(Date.parse(meta.startedAt)) || typeof meta.committed !== 'boolean') throw new Error(`WAL 元数据形状损坏：${dir}`)
    return meta
  }

  private async writeMeta(dir: string, meta: FloorMeta): Promise<void> {
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  }

  private async readRecords(dir: string): Promise<RecordLine[]> {
    let text: string
    try {
      text = await readFile(join(dir, 'records.jsonl'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const records: RecordLine[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec: RecordLine
      try { rec = JSON.parse(line) as RecordLine } catch { throw new Error(`WAL 记录损坏：${dir}`) }
      if (!isRecord(rec)) throw new Error(`WAL 记录形状损坏：${dir}`)
      const safePath = typeof rec.path === 'string' && rec.path.length > 0 && !rec.path.includes('\\')
        && !rec.path.includes(':') && !rec.path.startsWith('/') && rec.path.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
        && !rec.path.toLowerCase().startsWith('state/wal/')
      if (!safePath || !Number.isSafeInteger(rec.seq) || rec.seq < 1 || rec.seq <= (records.at(-1)?.seq ?? 0)
        || !(rec.before === null || typeof rec.before === 'string')
        || ('after' in rec && !(rec.after === null || typeof rec.after === 'string'))
        || (rec.beforeEncoding !== undefined && !['utf8', 'base64'].includes(rec.beforeEncoding))
        || (rec.afterEncoding !== undefined && !['utf8', 'base64'].includes(rec.afterEncoding))) {
        throw new Error(`WAL 记录形状或路径损坏：${dir}`)
      }
      const before = rec.beforeEncoding === undefined && rec.before?.startsWith(WAL_BINARY_MARK)
        ? rec.before.slice(WAL_BINARY_MARK.length) : rec.before
      if ((before !== null && (rec.beforeEncoding === 'base64' || before !== rec.before) && !isBase64(before))
        || (rec.afterEncoding === 'base64' && rec.after !== null && !isBase64(rec.after))) {
        throw new Error(`WAL 快照编码损坏：${dir}`)
      }
      records.push(rec)
    }
    return records
  }

  /** 预检与执行共用同一套只读校验，任何坏游标都必须在修改批次中首个文件前被发现。 */
  private async readRollbackProgress(dir: string, records: RecordLine[]): Promise<RollbackProgress> {
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    const saved = await readFile(join(dir, 'rollback-progress.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (saved === null) return { hash, next: records.length - 1, restored: [], preserved: [] }
    let value: unknown
    try { value = JSON.parse(saved) } catch { throw new Error(`WAL 回滚恢复游标损坏：${dir}`) }
    const paths = new Set(records.map(record => record.path))
    const isPaths = (items: unknown): items is string[] => Array.isArray(items)
      && items.every(item => typeof item === 'string' && paths.has(item))
    if (!isRecord(value) || value.hash !== hash || typeof value.next !== 'number'
      || !Number.isSafeInteger(value.next) || value.next < -1 || value.next >= records.length
      || !isPaths(value.restored) || !isPaths(value.preserved)
      || value.restored.length + value.preserved.length !== records.length - value.next - 1) {
      throw new Error(`WAL 回滚恢复游标损坏：${dir}`)
    }
    const progress: RollbackProgress = { hash, next: value.next, restored: value.restored, preserved: value.preserved }
    if ('pending' in value) {
      const pending = value.pending
      if (!isRecord(pending) || typeof pending.path !== 'string' || pending.path !== records[value.next]?.path
        || !(pending.from === null || isBase64(pending.from)) || !(pending.to === null || isBase64(pending.to))) {
        throw new Error(`WAL 回滚恢复记录损坏：${dir}`)
      }
      progress.pending = { path: pending.path, from: pending.from, to: pending.to }
    }
    return progress
  }

  /** 读取楼层记录状态（惰性加载，进程重启后首次访问时从磁盘重建）。 */
  private async loadState(dirName: string): Promise<{ paths: Set<string>; seq: number }> {
    const cached = this.states.get(dirName)
    if (cached) return cached
    const state = { paths: new Set<string>(), seq: 0 }
    for (const rec of await this.readRecords(join(this.rootDir, dirName))) {
      state.paths.add(rec.path)
      state.seq = Math.max(state.seq, rec.seq)
    }
    this.states.set(dirName, state)
    return state
  }

  private async hasRolledBackDir(dirName: string): Promise<boolean> {
    try {
      const names = await readdir(this.rootDir)
      return names.some((n) => n.startsWith(dirName + ROLLED_BACK_MARK))
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 公共方法的实际实现（均在队列内串行执行）
  // -------------------------------------------------------------------------

  private async doBeginFloor(floor: string): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    if (await isDir(dir)) {
      const meta = await this.readMeta(dir)
      if (meta && !meta.committed) {
        throw new Error(`楼层 "${floor}" 已存在且未提交，拒绝重复开始（防止跨会话串层）`)
      }
      // 已提交（或元数据缺失）的同名旧单元：清空旧记录，作为新事务开始
      await writeFile(join(dir, 'records.jsonl'), '', 'utf8')
    } else {
      await mkdir(dir, { recursive: true })
    }
    await this.writeMeta(dir, { floor, startedAt: new Date().toISOString(), committed: false })
    this.states.set(dirName, { paths: new Set(), seq: 0 })
  }

  private async doRecord(floor: string, path: string, before: string | null, beforeEncoding?: 'utf8' | 'base64'): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    if (!(await isDir(dir))) {
      throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`)
    }
    const normPath = path.replace(/\\/g, '/')
    const state = await this.loadState(dirName)
    if (state.paths.has(normPath)) return // 同层同路径只留首次快照
    // 顺序要紧：必须先 append 成功再更新内存状态。若先记入 paths 而 append 失败，
    // 调用方重试同一路径会命中上面的「已快照」快路径，这条 before 镜像就永远不落盘，
    // 回滚只能把文件停在改后内容——静默的数据丢失。doRecord 在串行队列内执行，
    // 这段「读—写」不会与其他记录交错，推迟更新是安全的。
    const seq = state.seq + 1
    const line: RecordLine = {
      seq,
      path: normPath,
      before,
      ...(beforeEncoding && before !== null ? { beforeEncoding } : {}),
    }
    await appendFile(join(dir, 'records.jsonl'), JSON.stringify(line) + '\n', 'utf8')
    state.seq = seq
    state.paths.add(normPath)
  }

  private async doRecordAfter(floor: string, path: string, after: string | null, afterEncoding?: 'utf8' | 'base64'): Promise<void> {
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    if (!(await isDir(dir))) throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入后快照`)
    const file = join(dir, 'records.jsonl')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`楼层 "${floor}" 没有可更新的 WAL 记录`)
      }
      throw error
    }
    const normPath = path.replace(/\\/g, '/')
    let found = false
    const lines = text.split('\n').map((line) => {
      if (!line.trim()) return line
      try {
        const record = JSON.parse(line) as RecordLine
        if (record.path !== normPath) return line
        found = true
        return JSON.stringify({
          ...record,
          after,
          ...(afterEncoding && after !== null ? { afterEncoding } : {}),
        })
      } catch {
        // 坏行保留原文；补写 after 不应顺手抹掉调试信息。
        return line
      }
    })
    if (!found) throw new Error(`楼层 "${floor}" 没有路径 "${normPath}" 的 WAL 记录`)
    await atomicWrite(file, lines.join('\n'))
  }

  private async doCommitFloor(floor: string): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const dir = join(this.rootDir, sanitizeFloor(floor))
    const meta = await this.readMeta(dir)
    if (!meta) throw new Error(`楼层 "${floor}" 不存在，无法提交`)
    meta.committed = true
    meta.committedAt = new Date().toISOString()
    await this.writeMeta(dir, meta)
  }

  private async doRollbackFloor(floor: string, workspaceRoot: string): Promise<string[]> {
    await mkdir(this.rootDir, { recursive: true })
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    if (!(await isDir(dir))) {
      throw new Error(
        (await this.hasRolledBackDir(dirName))
          ? `楼层 "${floor}" 已回滚，无法重复回滚`
          : `楼层 "${floor}" 不存在，无法回滚`,
      )
    }
    const records = await this.readRecords(dir)
    const progressFile = join(dir, 'rollback-progress.json')
    const progress = await this.readRollbackProgress(dir, records)
    await expandAffectedMemories(workspaceRoot, records.map((record) => record.path))
    const checkpoint = () => atomicWrite(progressFile, JSON.stringify(progress) + '\n')
    const currentBytes = async (path: string) => (await readFile(join(workspaceRoot, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }))?.toString('base64') ?? null
    const applyPending = async () => {
      const pending = progress.pending!
      const current = await currentBytes(pending.path)
      // 崩溃可能发生在文件替换后、游标推进前。已到目标值则直接推进，避免重放较新的 before。
      if (current !== pending.to) {
        if (current !== pending.from) throw new Error(`WAL 恢复期间文件又被修改：${pending.path}`)
        const target = join(workspaceRoot, pending.path)
        if (pending.to === null) await rm(target, { force: true })
        else { await mkdir(dirname(target), { recursive: true }); await atomicWrite(target, Buffer.from(pending.to, 'base64')) }
      }
      progress.restored.push(pending.path)
      delete progress.pending
      progress.next--
      await checkpoint()
    }
    if (progress.pending) await applyPending()
    for (let i = progress.next; i >= 0; i--) {
      const rec = records[i]!
      const current = await currentBytes(rec.path)
      let desired = rec.before === null ? null : rec.beforeEncoding === 'base64' ? rec.before
        : rec.beforeEncoding === undefined && rec.before.startsWith(WAL_BINARY_MARK) ? rec.before.slice(WAL_BINARY_MARK.length)
        : Buffer.from(rec.before).toString('base64')
      if ('after' in rec) {
        const after = rec.after ?? null
        const expected = after === null ? null : rec.afterEncoding === 'base64' ? after : Buffer.from(after).toString('base64')
        if (current !== expected) {
          if (rec.path === 'state/world-delta.jsonl' && rec.beforeEncoding !== 'base64' && rec.afterEncoding !== 'base64') {
            const merged = undoWorldDelta(rec.before, after, current === null ? null : Buffer.from(current, 'base64').toString('utf8'))
            desired = merged === null ? null : Buffer.from(merged).toString('base64')
          } else {
            progress.preserved.push(rec.path)
            progress.next = i - 1
            await checkpoint()
            continue
          }
        }
      }
      progress.pending = { path: rec.path, from: current, to: desired }
      await checkpoint()
      await applyPending()
    }
    const restored = progress.restored
    const preserved = new Set(progress.preserved)
    if (records.some((record) => record.path.startsWith('memory/') || record.path === 'state/world-delta.jsonl')) {
      await rebuildIndex(new WorkspaceFs(workspaceRoot, null), estimateTokens)
    }
    const meta = (await this.readMeta(dir)) ?? { floor, startedAt: new Date().toISOString(), committed: false }
    meta.rolledBackAt = new Date().toISOString()
    meta.preservedPaths = [...preserved]
    await this.writeMeta(dir, meta)
    await rename(dir, join(this.rootDir, `${dirName}${ROLLED_BACK_MARK}${timestamp()}`))
    this.states.delete(dirName)
    return restored
  }

  /** 整批先校验；不能在撤销较新楼层后才发现较旧日志损坏。 */
  private async preflightRollback(floors: string[]): Promise<void> {
    const selected = new Set(floors)
    const changes: { rec: RecordLine; startedAt: number | null }[] = []
    for (const floor of floors) {
      const dir = join(this.rootDir, sanitizeFloor(floor))
      const records = await this.readRecords(dir)
      await this.readRollbackProgress(dir, records)
      // 元数据缺失时不知道楼层何时开始，保守地把所有其它楼层都当作可能的后继。
      const meta = await this.readMeta(dir).catch(() => null)
      const startedAt = meta ? Date.parse(meta.startedAt) : null
      for (const rec of records) if (!isNoopRecord(rec)) changes.push({ rec, startedAt })
    }
    // 后继写入以被撤销记录的写后内容为写前快照；只有已在目标楼层开始前完成的旧楼层才能排除。
    // 旧共享工作区的会话可能交错：较早开始的楼层仍会较晚写入，重新打开的完成楼层也会追加写入。
    // 不能单凭 startedAt 排除它们，否则之后撤销该楼层时会复活已经撤销的事实。
    // 已更早完成楼层的同值 before 不是依赖：轮到它时恢复的正是它自己的 before。
    // 每轮重写相同定时器、标志位来回切换的普通剧情都会让旧楼层出现同值 before，若不分先后，
    // 第三层起就再也无法只重生成最新楼层。
    for (const floor of await this.doListFloors()) {
      if (floor.rolledBack || selected.has(floor.floor)) continue
      const dir = join(this.rootDir, sanitizeFloor(floor.floor))
      const meta = await this.readMeta(dir)
      const completedAt = meta?.committed && meta.committedAt ? Date.parse(meta.committedAt) : NaN
      const records = await this.readRecords(dir)
      for (const rec of records) {
        if (isNoopRecord(rec)) continue
        if (changes.some(({ rec: change, startedAt }) => (startedAt === null || !Number.isFinite(completedAt) || completedAt >= startedAt)
          && change.path === rec.path && (rec.path !== 'state/world-delta.jsonl' || deltaChangesOverlap(change, rec)) && 'after' in change && change.after !== null
          && rec.before === change.after && rec.beforeEncoding === change.afterEncoding)) {
          throw new Error(`WAL 存在未撤销的后继依赖：${floor.floor}（${rec.path}）；请从最新楼层依次回退`)
        }
      }
    }
  }

  private async doRollbackAfter(floors: string[], workspaceRoot: string): Promise<RollbackAfterResult> {
    await this.preflightRollback(floors)
    await mkdir(this.rootDir, { recursive: true })
    const restored: string[] = []
    const skipped: string[] = []
    for (let i = floors.length - 1; i >= 0; i--) {
      const floor = floors[i]!
      if (!(await isDir(join(this.rootDir, sanitizeFloor(floor))))) {
        skipped.push(floor) // 已不存在（含已回滚）的楼层跳过
        continue
      }
      restored.push(...(await this.doRollbackFloor(floor, workspaceRoot)))
    }
    return { restored, skipped }
  }

  private async doListFloors(): Promise<WalFloorInfo[]> {
    await mkdir(this.rootDir, { recursive: true })
    const entries = await readdir(this.rootDir, { withFileTypes: true })
    const floors: WalFloorInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await this.readMeta(join(this.rootDir, entry.name))
      if (!meta || sanitizeFloor(meta.floor) !== entry.name.split(ROLLED_BACK_MARK)[0]) throw new Error(`WAL 元数据缺失或目录不匹配：${entry.name}`)
      floors.push({
        floor: meta.floor,
        committed: meta.committed,
        startedAt: meta.startedAt,
        rolledBack: entry.name.includes(ROLLED_BACK_MARK),
      })
    }
    floors.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    return floors
  }

  private async doPrune(options: { keepRolledBackDays?: number }): Promise<number> {
    const keepDays = options.keepRolledBackDays ?? 7
    await mkdir(this.rootDir, { recursive: true })
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const entries = await readdir(this.rootDir, { withFileTypes: true })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(ROLLED_BACK_MARK)) continue
      const dir = join(this.rootDir, entry.name)
      const meta = await this.readMeta(dir)
      let rolledBackAt = meta?.rolledBackAt ? Date.parse(meta.rolledBackAt) : Number.NaN
      if (Number.isNaN(rolledBackAt)) rolledBackAt = (await stat(dir)).mtimeMs // 元数据缺失时退回目录 mtime
      if (rolledBackAt < cutoff) {
        await rm(dir, { recursive: true, force: true })
        removed += 1
      }
    }
    return removed
  }
}
