/**
 * WAL 磁盘格式的纯判定：楼层目录名、回滚副本后缀、快照编码、记录行、回滚恢复游标、
 * 独立楼层清单与工作区恢复标记的形状，以及由记录推导回滚目标的规则。
 *
 * 运行时（state/wal.ts）据判定结果抛出各自原有的错误文本，只读诊断（doctor.ts）据此给出
 * healthy/unhealthy 结论。两边共用同一套规则：诊断存在的意义就是回答「运行时会不会接受这份数据」，
 * 不能比运行时更宽或更严。本模块不做 I/O、不抛错，判定函数只返回布尔值、原因或归一化结果。
 */
import { Buffer } from 'node:buffer'
import type { WalRecord } from '../core/types.js'
import { isRecord } from '../core/guards.js'
import { undoWorldDelta } from '../core/walUndo.js'
import { isReservedWalPath } from './workspaceFs.js'

/** records.jsonl 单行形状（floor 由所在目录承载，行内不重复）。after/编码字段兼容旧记录。 */
export type RecordLine = Omit<WalRecord, 'floor'>

/** 回滚恢复游标；pending 的前后镜像始终为标准 base64，null 表示文件不存在。 */
export interface RollbackProgress {
  hash: string
  next: number
  restored: string[]
  preserved: string[]
  pending?: { path: string; from: string | null; to: string | null }
}

/** 独立楼层清单中的一项：楼层身份由原始 id 与开始时间共同决定。 */
export interface WalCoverageFloor {
  floor: string
  startedAt: string
}

/** 独立楼层清单（state/wal-coverage.json）的大小上限；运行时读写与诊断读取共用。 */
export const MAX_WAL_COVERAGE_BYTES = 4 * 1024 * 1024

/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export const WAL_BINARY_MARK = 'binary-base64:'

/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
export const ROLLED_BACK_MARK = '.rolled-back-'

/**
 * 副本目录的严格后缀：标记后跟纯数字时间戳（timestamp() 只保留数字）。
 * 楼层 id 自身可能含 `.rolled-back-` 子串（sanitizeFloor 允许点和连字符），
 * 用 includes 判断会把活跃楼层当成回滚副本，进而漏记清单、拒绝开层乃至 prune 删掉完整日志。
 */
const ROLLED_BACK_SUFFIX = /\.rolled-back-\d+$/

/** 目录名是否为回滚副本；活跃楼层名中段的同名子串不算。 */
export function isRolledBackDir(name: string): boolean { return ROLLED_BACK_SUFFIX.test(name) }

/** 副本目录去掉后缀得到原楼层目录名；活跃目录原样返回。 */
export function baseFloorDir(name: string): string {
  return isRolledBackDir(name) ? name.replace(ROLLED_BACK_SUFFIX, '') : name
}

/** 楼层 id → 目录名：非法字符替换为 '_'（同字符冲突由调用方保证不出现）。 */
export function sanitizeFloor(floor: string): string {
  return floor.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** Buffer 的 base64 解码会忽略坏字符和截断；必须往返一致才允许用作恢复镜像。 */
export function isBase64(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value
}

/** Windows 上大小写别名是同一个正文文件；仅用于比较，不能改写已有日志或恢复游标的 hash。 */
export function recordPathIdentity(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }

/** 记录路径必须是工作区内的规范相对路径（正斜杠、无盘符与 `.`/`..`/空段），且不能指向 WAL 自身。 */
export function isSafeWalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.includes(':') && !value.startsWith('/') && value.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
    && !isReservedWalPath(value)
}

/** meta.json 的最低形状：楼层 id 非空、开始时间可解析、committed 为布尔值。 */
export function isFloorMetaShape(value: unknown): value is { floor: string; startedAt: string; committed: boolean } & Record<string, unknown> {
  return isRecord(value) && typeof value.floor === 'string' && !!value.floor && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt)) && typeof value.committed === 'boolean'
}

/** 记录行不被接受的原因，按运行时的检查顺序给出第一个。 */
export type RecordLineIssue = 'shape' | 'seq' | 'path' | 'encoding'

/**
 * 校验已解析的一行记录。所有写入协议都从 1 连续编号；只验证递增会把丢失首条或中间行的日志误认完整，
 * 回滚后残留被漏记的事实，却已撤销其它楼层并标记成功。空白行不占序号，由调用方跳过。
 * 返回 null 表示该行可用。
 */
export function recordLineIssue(value: unknown, expectedSeq: number): RecordLineIssue | null {
  if (!isRecord(value)) return 'shape'
  if (!Number.isSafeInteger(value.seq) || value.seq !== expectedSeq) return 'seq'
  if (!isSafeWalPath(value.path)
    || !(value.before === null || typeof value.before === 'string')
    || ('after' in value && !(value.after === null || typeof value.after === 'string'))
    || (value.beforeEncoding !== undefined && value.beforeEncoding !== 'utf8' && value.beforeEncoding !== 'base64')
    || (value.afterEncoding !== undefined && value.afterEncoding !== 'utf8' && value.afterEncoding !== 'base64')) {
    return 'path'
  }
  const before = value.beforeEncoding === undefined && typeof value.before === 'string' && value.before.startsWith(WAL_BINARY_MARK)
    ? value.before.slice(WAL_BINARY_MARK.length) : value.before
  if ((before !== null && (value.beforeEncoding === 'base64' || before !== value.before) && !isBase64(before))
    || (value.afterEncoding === 'base64' && value.after !== null && !isBase64(value.after))) {
    return 'encoding'
  }
  return null
}

const snapshotCache = new WeakMap<RecordLine, { before?: string | null; after?: string | null }>()

/** 快照统一为实际字节的 base64；旧版省略 utf8 标签或使用 before 前缀也必须得到相同身份（带 WeakMap 缓存）。 */
export function snapshotBytes(rec: RecordLine, side: 'before' | 'after'): string | null {
  let cached = snapshotCache.get(rec)
  if (cached && side in cached) return cached[side]!
  const value = rec[side] ?? null
  const encoding = side === 'before' ? rec.beforeEncoding : rec.afterEncoding
  let result: string | null
  if (value === null) result = null
  else if (encoding === 'base64') result = value
  else if (side === 'before' && encoding === undefined && value.startsWith(WAL_BINARY_MARK)) result = value.slice(WAL_BINARY_MARK.length)
  else result = Buffer.from(value).toString('base64')
  if (!cached) {
    cached = {}
    snapshotCache.set(rec, cached)
  }
  cached[side] = result
  return result
}

/** 从同一记录与撤销前正文推导恢复目标；执行与恢复游标预检共用，禁止游标自行提供新正文。 */
export function rollbackTarget(rec: RecordLine, current: string | null): { restore: true; value: string | null } | { restore: false } {
  let desired = snapshotBytes(rec, 'before')
  if ('after' in rec && current !== snapshotBytes(rec, 'after')) {
    if (recordPathIdentity(rec.path) !== 'state/world-delta.jsonl' || rec.beforeEncoding === 'base64' || rec.afterEncoding === 'base64') {
      return { restore: false }
    }
    const merged = undoWorldDelta(rec.before, rec.after ?? null, current === null ? null : Buffer.from(current, 'base64').toString('utf8'))
    desired = merged === null ? null : Buffer.from(merged).toString('base64')
    if (desired === current) return { restore: false }
  }
  return { restore: true, value: desired }
}

/** 恢复游标不被接受的原因：整体形状、完成路径与进度、pending 形状、pending 目标。 */
export type RollbackProgressIssue = 'cursor' | 'paths' | 'pending' | 'target'

/**
 * 校验已解析的恢复游标。hash 为调用方按当前记录集合算出的身份，records 必须已逐行校验通过。
 * 完成数组必须恰好覆盖 next 之后已处理的记录；只比总数会让错路径/重复路径跳过真实修改。
 * pending 目标必须由原记录与来源正文重新推导，不能由游标自行提供。
 */
export function checkRollbackProgress(value: unknown, records: readonly RecordLine[], hash: string):
  { ok: true; progress: RollbackProgress } | { ok: false; reason: RollbackProgressIssue } {
  const paths = new Set(records.map(record => record.path))
  const isPaths = (items: unknown): items is string[] => Array.isArray(items)
    && items.every(item => typeof item === 'string' && paths.has(item))
  if (!isRecord(value) || value.hash !== hash || typeof value.next !== 'number'
    || !Number.isSafeInteger(value.next) || value.next < -1 || value.next >= records.length
    || !isPaths(value.restored) || !isPaths(value.preserved)
    || value.restored.length + value.preserved.length !== records.length - value.next - 1) {
    return { ok: false, reason: 'cursor' }
  }
  const progress: RollbackProgress = { hash, next: value.next, restored: value.restored, preserved: value.preserved }
  const remaining = new Map<string, number>()
  for (const record of records.slice(value.next + 1)) remaining.set(record.path, (remaining.get(record.path) ?? 0) + 1)
  for (const path of [...progress.restored, ...progress.preserved]) {
    const count = remaining.get(path) ?? 0
    if (!count) return { ok: false, reason: 'paths' }
    remaining.set(path, count - 1)
  }
  if ('pending' in value) {
    const pending = value.pending
    if (!isRecord(pending) || typeof pending.path !== 'string' || pending.path !== records[value.next]?.path
      || !(pending.from === null || isBase64(pending.from)) || !(pending.to === null || isBase64(pending.to))) {
      return { ok: false, reason: 'pending' }
    }
    const target = rollbackTarget(records[value.next]!, pending.from)
    if (!target.restore || pending.to !== target.value) return { ok: false, reason: 'target' }
    progress.pending = { path: pending.path, from: pending.from, to: pending.to }
  }
  return { ok: true, progress }
}

/**
 * 独立楼层清单的形状：版本、字段白名单、楼层名长度、开始时间可解析、同名楼层不重复。
 * 返回清单中的楼层数组；任何一项不合规返回 null。
 */
export function parseWalCoverage(value: unknown): WalCoverageFloor[] | null {
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'floors'].includes(key))
    || !Array.isArray(value.floors) || value.floors.some(floor => !isRecord(floor)
      || Object.keys(floor).some(key => !['floor', 'startedAt'].includes(key))
      || typeof floor.floor !== 'string' || !floor.floor || floor.floor.length > 512
      || typeof floor.startedAt !== 'string' || !Number.isFinite(Date.parse(floor.startedAt)))
    || new Set(value.floors.map(floor => floor.floor)).size !== value.floors.length) return null
  return value.floors as WalCoverageFloor[]
}

/**
 * 工作区恢复标记的解析结果：floors 只保留形状合法的楼层名，valid 表示整份标记完全符合写入格式
 * （版本、楼层与净化目录名一一对应、可选路径字段类型）。非对象一律 valid: false。
 */
export function parseRecoveryMarker(value: unknown): { floors: string[]; bodyRoot?: string; valid: boolean } {
  if (!isRecord(value)) return { floors: [], valid: false }
  const rawFloors = Array.isArray(value.floors) ? value.floors : []
  const floors = rawFloors.filter((floor): floor is string => typeof floor === 'string' && floor.length > 0 && floor.length <= 512)
  const expectedDirs = floors.map(sanitizeFloor)
  const valid = value.version === 1 && Array.isArray(value.floors) && Array.isArray(value.dirs)
    && floors.length > 0 && floors.length === value.floors.length
    && value.dirs.length === expectedDirs.length && value.dirs.every((dir, i) => dir === expectedDirs[i])
    && (value.walDir === undefined || typeof value.walDir === 'string')
    && (value.bodyRoot === undefined || typeof value.bodyRoot === 'string')
  return { floors, ...(typeof value.bodyRoot === 'string' && value.bodyRoot ? { bodyRoot: value.bodyRoot } : {}), valid }
}
