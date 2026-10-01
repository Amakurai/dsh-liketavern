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
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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

/** Windows 上大小写别名是同一个正文文件；仅用于比较，不能改写已有日志或恢复游标的 hash。 */
function recordPathIdentity(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }

/**
 * 楼层目录中表明楼层已开始的文件。建目录后、写 meta 前崩溃会留下这些文件都不存在的目录：
 * 记录只在元数据存在后追加，回滚也先写游标再改正文，这种目录不可能关联任何正文修改，
 * 按未开始处理；缺元数据但有记录或回滚游标仍是损坏，照常拒绝。doctor 共用同一判定。
 */
export const WAL_FLOOR_MARKERS = ['meta.json', 'records.jsonl', 'rollback-progress.json'] as const

async function isUnstartedDir(dir: string): Promise<boolean> {
  for (const name of WAL_FLOOR_MARKERS) {
    const present = await stat(join(dir, name)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (present) return false
  }
  return true
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

/** 快照统一为实际字节的 base64；旧版省略 utf8 标签或使用 before 前缀也必须得到相同身份。 */
function snapshotBytes(rec: RecordLine, side: 'before' | 'after'): string | null {
  const value = rec[side] ?? null
  if (value === null) return null
  const encoding = side === 'before' ? rec.beforeEncoding : rec.afterEncoding
  if (encoding === 'base64') return value
  if (side === 'before' && encoding === undefined && value.startsWith(WAL_BINARY_MARK)) return value.slice(WAL_BINARY_MARK.length)
  return Buffer.from(value).toString('base64')
}

/**
 * 后继世界状态快照是否依赖先前修改的 id。快照来自正文原样镜像，而正文读写（WorldDeltaStore、undoWorldDelta）
 * 都刻意保留无法解析的行；这里同样只按能解析出字符串 id 的行比较，坏行不能让预检抛出原始解析错误。
 */
function deltaChangesDependOn(previous: RecordLine, next: RecordLine): boolean {
  const snapshots = (rec: RecordLine) => {
    const rows = (text: string | null | undefined) => new Map((text ?? '').split('\n').filter((line) => line.trim()).flatMap((line) => {
      let id: unknown
      try { id = (JSON.parse(line) as { id?: unknown } | null)?.id } catch { return [] }
      return typeof id === 'string' ? [[id, line] as const] : []
    }))
    const text = (side: 'before' | 'after') => {
      const bytes = snapshotBytes(rec, side)
      return bytes === null ? null : Buffer.from(bytes, 'base64').toString('utf8')
    }
    const before = rows(text('before')), after = rows(text('after'))
    return { before, after, changed: new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id))) }
  }
  const a = snapshots(previous), b = snapshots(next)
  // 中间插入其它 id 或保留坏行会改变整文件镜像，但不会消除同一条目的前后依赖。
  // 人工修改过同一 id 的情况则必须保留，不能只因 id 重叠就拒绝撤销。
  return [...b.changed].some((id) => a.changed.has(id) && a.after.get(id) === b.before.get(id))
}

/** before 与 after 字节相同的记录：恢复时不改文件，既不会被复活，也不能作为别的楼层的依赖锚点。 */
function isNoopRecord(rec: RecordLine): boolean {
  return 'after' in rec && snapshotBytes(rec, 'before') === snapshotBytes(rec, 'after')
}

/** 从同一记录与撤销前正文推导恢复目标；执行与恢复游标预检共用，禁止游标自行提供新正文。 */
function rollbackTarget(rec: RecordLine, current: string | null): { restore: true; value: string | null } | { restore: false } {
  let desired = snapshotBytes(rec, 'before')
  if ('after' in rec && current !== snapshotBytes(rec, 'after')) {
    if (recordPathIdentity(rec.path) !== 'state/world-delta.jsonl' || rec.beforeEncoding === 'base64' || rec.afterEncoding === 'base64') {
      return { restore: false }
    }
    const merged = undoWorldDelta(rec.before, rec.after ?? null, current === null ? null : Buffer.from(current, 'base64').toString('utf8'))
    desired = merged === null ? null : Buffer.from(merged).toString('base64')
  }
  return { restore: true, value: desired }
}

export class Wal {
  private readonly rootDir: string
  private readonly logFs: WorkspaceFs

  /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
    const state = dirname(this.rootDir)
    // 宿主日志的边界是所属工作区，state 父路径也不能改成兄弟剧情的链接；安装祖先挂载不受影响。
    // 独立日志根继续采用调用方显式给定的边界，不要求正文目录与日志目录是同一个根。
    const anchor = basename(state).toLowerCase() === 'state' && basename(this.rootDir).toLowerCase() === 'wal'
      ? dirname(state) : this.rootDir
    this.logFs = new WorkspaceFs(anchor, null)
  }

  private async assertLogPath(target = this.rootDir): Promise<void> {
    await this.logFs.assertSafePath(relative(this.logFs.root, target))
  }

  /** 开始新的楼层事务；已有楼层必须显式 reopen 或先回滚，不能覆盖原始镜像。 */
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
      await this.assertLogPath(dir)
      if (!(await isDir(dir))) throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`)
      await this.assertNotRecovering(dir)
      await this.readFloorMeta(dir, floor)
      const state = await this.loadState(dirName)
      const file = join(dir, 'records.jsonl')
      const text = await readFile(file, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      })
      const record: RecordLine = { seq: state.seq + 1, path: path.replace(/\\/g, '/'), before, after, beforeEncoding, afterEncoding }
      await atomicWrite(file, text + (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(record) + '\n')
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
      await this.assertLogPath(dir)
      if (!(await isDir(dir))) throw new Error(`WAL 楼层缺失或已回滚：${floor}`)
      await this.assertNotRecovering(dir)
      const meta = await this.readFloorMeta(dir, floor)
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
      await this.preflightRollback([floor], workspaceRoot)
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

  /** 只读检查可用楼层：元数据、序号、路径与快照必须有效；回滚中的旧 committed 不能作为完成证明。 */
  validateFloor(floor: string): Promise<WalFloorInfo> {
    return this.enqueue(async () => {
      const dir = join(this.rootDir, sanitizeFloor(floor))
      await this.assertLogPath(dir)
      if (!(await isDir(dir))) throw new Error(`WAL 楼层缺失或已回滚：${floor}`)
      const meta = await this.readFloorMeta(dir, floor)
      await this.assertNotRecovering(dir)
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
    // 同一日志目录的所有句柄共享队列，路径别名也由工作区锁规范化。
    return withWorkspaceLock(this.rootDir, async () => {
      await this.assertLogPath()
      return task()
    })
  }

  private async readMeta(dir: string): Promise<FloorMeta | null> {
    await this.assertLogPath(join(dir, 'meta.json'))
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
    await this.assertLogPath(join(dir, 'meta.json'))
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  }

  /** 目录存在不代表楼层可写；元数据必须完整且属于请求的原始楼层，不能只比净化后的目录名。 */
  private async readFloorMeta(dir: string, floor: string): Promise<FloorMeta> {
    const meta = await this.readMeta(dir)
    if (!meta || meta.floor !== floor) throw new Error(`WAL 楼层元数据不存在或不匹配：${floor}`)
    return meta
  }

  /** 恢复游标绑定原始记录集合；中断后只能继续回滚，追加或提交会使游标失效或误报已完成。 */
  private async assertNotRecovering(dir: string): Promise<void> {
    await this.assertLogPath(join(dir, 'rollback-progress.json'))
    const progress = await stat(join(dir, 'rollback-progress.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (progress) throw new Error(`WAL 楼层正在回滚恢复，完成恢复前不能追加或提交：${dir}`)
  }

  private async readRecords(dir: string): Promise<RecordLine[]> {
    await this.assertLogPath(join(dir, 'records.jsonl'))
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
    await this.assertLogPath(join(dir, 'rollback-progress.json'))
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
    // 完成数组必须恰好覆盖 next 之后已处理的记录；只比总数会让错路径/重复路径跳过真实修改。
    const remaining = new Map<string, number>()
    for (const record of records.slice(value.next + 1)) remaining.set(record.path, (remaining.get(record.path) ?? 0) + 1)
    for (const path of [...progress.restored, ...progress.preserved]) {
      const count = remaining.get(path) ?? 0
      if (!count) throw new Error(`WAL 回滚恢复游标路径与处理进度不符：${dir}`)
      remaining.set(path, count - 1)
    }
    if ('pending' in value) {
      const pending = value.pending
      if (!isRecord(pending) || typeof pending.path !== 'string' || pending.path !== records[value.next]?.path
        || !(pending.from === null || isBase64(pending.from)) || !(pending.to === null || isBase64(pending.to))) {
        throw new Error(`WAL 回滚恢复记录损坏：${dir}`)
      }
      const target = rollbackTarget(records[value.next]!, pending.from)
      if (!target.restore || pending.to !== target.value) throw new Error(`WAL 回滚恢复目标与原记录不符：${dir}`)
      progress.pending = { path: pending.path, from: pending.from, to: pending.to }
    }
    return progress
  }

  /** 每次从当前日志读取序号和去重路径；其它实例追加及替换后报错都不能复用旧缓存。 */
  private async loadState(dirName: string): Promise<{ paths: Set<string>; seq: number }> {
    const state = { paths: new Set<string>(), seq: 0 }
    for (const rec of await this.readRecords(join(this.rootDir, dirName))) {
      state.paths.add(rec.path)
      state.seq = Math.max(state.seq, rec.seq)
    }
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
    await this.assertLogPath(dir)
    for (const marker of WAL_FLOOR_MARKERS) await this.assertLogPath(join(dir, marker))
    if (await isDir(dir) && !(await isUnstartedDir(dir))) {
      const meta = await this.readMeta(dir)
      if (meta && !meta.committed) {
        throw new Error(`楼层 "${floor}" 已存在且未提交，拒绝重复开始（防止跨会话串层）`)
      }
      // records 与 meta 两次原子替换仍有崩溃窗口；重复楼层不得清空旧镜像。
      // 已完成层的受控追加使用 reopenFloor；重生成先回滚再开新层。
      throw new Error(`楼层 "${floor}" 已存在，拒绝重复开始；追加写入请显式重新打开，重新生成请先回滚`)
    }
    await mkdir(dir, { recursive: true })
    await this.writeMeta(dir, { floor, startedAt: new Date().toISOString(), committed: false })
  }

  private async doRecord(floor: string, path: string, before: string | null, beforeEncoding?: 'utf8' | 'base64'): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    await this.assertLogPath(dir)
    if (!(await isDir(dir))) {
      throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`)
    }
    await this.assertNotRecovering(dir)
    await this.readFloorMeta(dir, floor)
    const normPath = path.replace(/\\/g, '/')
    const state = await this.loadState(dirName)
    if (state.paths.has(normPath)) return // 同层同路径只留首次快照
    // 序号和去重均基于当前磁盘，追加失败后的重试不会误认路径已快照。
    // 读写全程持有共享日志锁，另一个实例不能在中间插入记录。
    const seq = state.seq + 1
    const line: RecordLine = {
      seq,
      path: normPath,
      before,
      ...(beforeEncoding && before !== null ? { beforeEncoding } : {}),
    }
    await appendFile(join(dir, 'records.jsonl'), JSON.stringify(line) + '\n', 'utf8')
  }

  private async doRecordAfter(floor: string, path: string, after: string | null, afterEncoding?: 'utf8' | 'base64'): Promise<void> {
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    await this.assertLogPath(dir)
    if (!(await isDir(dir))) throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入后快照`)
    await this.assertNotRecovering(dir)
    await this.readFloorMeta(dir, floor)
    await this.readRecords(dir)
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
    const meta = await this.readFloorMeta(dir, floor)
    await this.assertNotRecovering(dir)
    // 提交是完成证明，不能让读取/回滚均拒绝的日志得到 committed=true。
    await this.readRecords(dir)
    meta.committed = true
    meta.committedAt = new Date().toISOString()
    await this.writeMeta(dir, meta)
  }

  private async doRollbackFloor(floor: string, workspaceRoot: string): Promise<string[]> {
    await mkdir(this.rootDir, { recursive: true })
    const dirName = sanitizeFloor(floor)
    const dir = join(this.rootDir, dirName)
    await this.assertLogPath(dir)
    if (!(await isDir(dir))) {
      throw new Error(
        (await this.hasRolledBackDir(dirName))
          ? `楼层 "${floor}" 已回滚，无法重复回滚`
          : `楼层 "${floor}" 不存在，无法回滚`,
      )
    }
    const records = await this.readRecords(dir)
    const bodyFs = new WorkspaceFs(workspaceRoot, null)
    const progressFile = join(dir, 'rollback-progress.json')
    const progress = await this.readRollbackProgress(dir, records)
    const checkpoint = async () => {
      await this.assertLogPath(progressFile)
      await atomicWrite(progressFile, JSON.stringify(progress) + '\n')
    }
    // 摘要展开本身也会恢复/删除正文；先固定恢复状态，展开中断后不能再把旧 committed
    // 当成完成证明，也不能允许迟到的写入改变原日志使后续恢复游标失效。
    await checkpoint()
    await expandAffectedMemories(workspaceRoot, records.map((record) => record.path))
    const currentBytes = async (path: string) => {
      const bytes = await bodyFs.readBytes(path)
      return bytes === null ? null : Buffer.from(bytes).toString('base64')
    }
    const applyPending = async () => {
      const pending = progress.pending!
      const current = await currentBytes(pending.path)
      // 崩溃可能发生在文件替换后、游标推进前。已到目标值则直接推进，避免重放较新的 before。
      if (current !== pending.to) {
        if (current !== pending.from) throw new Error(`WAL 恢复期间文件又被修改：${pending.path}`)
        if (pending.to === null) await bodyFs.delete(pending.path)
        else await bodyFs.writeBytes(pending.path, Buffer.from(pending.to, 'base64'))
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
      const target = rollbackTarget(rec, current)
      if (!target.restore) {
        progress.preserved.push(rec.path)
        progress.next = i - 1
        await checkpoint()
        continue
      }
      progress.pending = { path: rec.path, from: current, to: target.value }
      await checkpoint()
      await applyPending()
    }
    const restored = progress.restored
    const preserved = new Set(progress.preserved)
    if (records.some((record) => recordPathIdentity(record.path).startsWith('memory/') || recordPathIdentity(record.path) === 'state/world-delta.jsonl')) {
      await rebuildIndex(new WorkspaceFs(workspaceRoot, null), estimateTokens)
    }
    const meta = (await this.readMeta(dir)) ?? { floor, startedAt: new Date().toISOString(), committed: false }
    meta.rolledBackAt = new Date().toISOString()
    meta.preservedPaths = [...preserved]
    await this.writeMeta(dir, meta)
    const archived = join(this.rootDir, `${dirName}${ROLLED_BACK_MARK}${timestamp()}`)
    await this.assertLogPath(dir)
    await this.assertLogPath(archived)
    await rename(dir, archived)
    return restored
  }

  /** 整批先校验；不能在撤销较新楼层后才发现较旧日志损坏。 */
  private async preflightRollback(floors: string[], workspaceRoot: string): Promise<void> {
    const bodyFs = new WorkspaceFs(workspaceRoot, null)
    const logRelative = relative(workspaceRoot, this.rootDir)
    // 正常剧情日志在工作区内，要连同内部父路径一起检查；独立日志根仍遵守自己的显式边界。
    if (!isAbsolute(logRelative) && !logRelative.split(/[/\\]/).includes('..')) await bodyFs.assertSafePath(logRelative)
    await this.assertLogPath()
    const directories = await readdir(this.rootDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    // 后继依赖预检也会读未选中日志，所有可见楼层标记都必须在第一次日志读取前拒绝链接。
    for (const directory of directories) {
      if (!directory.isDirectory() && !directory.isSymbolicLink()) continue
      await this.assertLogPath(join(this.rootDir, directory.name))
      for (const marker of WAL_FLOOR_MARKERS) await this.assertLogPath(join(this.rootDir, directory.name, marker))
    }
    const selected = new Set(floors)
    const changes: { rec: RecordLine; startedAt: number | null }[] = []
    let expandsMemory = false
    let rebuildsIndex = false
    for (const floor of floors) {
      const dir = join(this.rootDir, sanitizeFloor(floor))
      // 净化目录名不是楼层身份：不同原始 id 可能共用同一目录名。
      // 必须在整批开始前核对元数据，不能撤销到另一个楼层或等较新楼层已恢复才发现冲突。
      const meta = await isDir(dir) && !(await isUnstartedDir(dir)) ? await this.readFloorMeta(dir, floor) : null
      const records = await this.readRecords(dir)
      await this.readRollbackProgress(dir, records)
      const startedAt = meta ? Date.parse(meta.startedAt) : null
      for (const rec of records) {
        await bodyFs.assertSafePath(rec.path)
        const path = recordPathIdentity(rec.path)
        expandsMemory ||= path.startsWith('memory/')
        rebuildsIndex ||= path.startsWith('memory/') || path === 'state/world-delta.jsonl'
        if (!isNoopRecord(rec)) changes.push({ rec, startedAt })
      }
    }
    // 摘要展开与索引重建读写记录外的路径；整批准备时检查，不能等较新楼层已恢复才失败。
    if (rebuildsIndex) {
      await bodyFs.list('memory', { recursive: expandsMemory, rejectLinks: true })
      for (const path of ['state/world-delta.jsonl', 'journal.md', 'index.json']) await bodyFs.assertSafePath(path)
    }
    // 后继写入以被撤销记录的写后内容为写前快照；null 也代表删除后的状态，重建文件同样依赖它。
    // 只有已在目标楼层开始前完成的旧楼层才能排除。
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
          && recordPathIdentity(change.path) === recordPathIdentity(rec.path) && 'after' in change
          && (recordPathIdentity(rec.path) === 'state/world-delta.jsonl'
            ? deltaChangesDependOn(change, rec)
            : snapshotBytes(rec, 'before') === snapshotBytes(change, 'after')))) {
          throw new Error(`WAL 存在未撤销的后继依赖：${floor.floor}（${rec.path}）；请从最新楼层依次回退`)
        }
      }
    }
  }

  private async doRollbackAfter(floors: string[], workspaceRoot: string): Promise<RollbackAfterResult> {
    await this.preflightRollback(floors, workspaceRoot)
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
      if (entry.isSymbolicLink()) await this.assertLogPath(join(this.rootDir, entry.name))
      if (!entry.isDirectory()) continue
      const dir = join(this.rootDir, entry.name)
      await this.assertLogPath(dir)
      for (const marker of WAL_FLOOR_MARKERS) await this.assertLogPath(join(dir, marker))
      if (await isUnstartedDir(dir)) continue
      const meta = await this.readMeta(dir)
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
      await this.assertLogPath(dir)
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
