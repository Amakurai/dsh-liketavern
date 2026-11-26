#!/usr/bin/env node
/**
 * 只读诊断 CLI：仅扫描 Tavern 数据目录的结构与聚合健康状态。
 *
 * 诊断结果刻意不携带角色名、角色/剧情/楼层 ID、正文、令牌、底层异常消息或
 * 绝对路径。扫描入口与遍历中遇到的目录链接不会被跟随；所有 JSON/WAL 读取都有大小上限，遍历也有
 * 总文件数与深度上限。该入口没有修复参数，也不调用任何会创建目录的状态 API。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, realpathSync, type Dirent } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { EDITOR_DRAFT_MAX_BYTES } from './core/editorDraftLimits.js'
import { isRecord } from './core/guards.js'
import { hostVersionSatisfies, manifestHostRange, safeHostRange } from './core/hostVersion.js'
import { MAX_STORED_CARD_JSON_BYTES } from './state/card.js'
import { CHAT_WORLDBOOK_TOTAL_BYTES } from './state/chatWorldbooks.js'
import { TEMPLATE_DOCUMENT_LIMIT } from './state/templateStorage.js'
import { CHARACTER_ARCHIVE_FILE, isValidCardId } from './state/workspace.js'
import { legacyStoryId, storyRoot } from './state/story.js'
import { caseIdentity, rootIdentity } from './state/pathIdentity.js'
import { WAL_COVERAGE_PATH, WAL_FLOOR_MARKERS } from './state/wal.js'
import {
  baseFloorDir, checkRollbackProgress, isFloorMetaShape, isRolledBackDir, isValidWalFloorDir, MAX_WAL_COVERAGE_BYTES, parseRecoveryMarker,
  parseWalCoverage, recordLineIssue, sanitizeFloor, type RecordLine,
} from './state/walFormat.js'
import { WAL_RECOVERY_PATH } from './state/workspaceFs.js'
import { parseSessionBinding } from './node/bindings.js'
import { tavernPaths, type TavernPaths } from './node/paths.js'
import { safeAssetFileId } from './node/state.js'

const REQUIRED_NODE_MAJOR = 24
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_CHAT_WORLDBOOK_JSON_BYTES = Math.floor(CHAT_WORLDBOOK_TOTAL_BYTES * 2.5)
const MAX_WAL_BYTES = 128 * 1024 * 1024
/**
 * 累计读取预算只限制扫描耗时，单文件内存仍由各自上限约束。card.json 上限为 128 MiB，
 * 预算需容纳多张满额角色卡与 WAL，否则备份会把运行时合法写出的数据判成检查不完整。
 */
const MAX_TOTAL_READ_BYTES = 1024 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const MAX_SCANNED_ENTRIES = 100_000
const MAX_SCAN_DEPTH = 32

export type DoctorSeverity = 'info' | 'warning' | 'error'
export type DoctorDirectoryStatus = 'missing' | 'directory' | 'file' | 'link' | 'unreadable'

export interface DoctorIssue {
  code: string
  severity: DoctorSeverity
  count: number
}

export interface DoctorReport {
  schemaVersion: 1
  ok: boolean
  runtime: {
    nodeVersion: string
    requiredNodeMajor: number
    nodeSupported: boolean
    pluginVersion: string
    dsh: {
      installedVersion: string
      expectedVersion: string
      compatible: boolean
    }
  }
  storage: {
    home: '~/.dsh' | '$DSH_HOME'
    dataRoot: '~/.dsh/dsh-tavern' | '$DSH_HOME/dsh-tavern'
    homeStatus: DoctorDirectoryStatus
    dataRootStatus: DoctorDirectoryStatus
    directories: {
      characters: DoctorDirectoryStatus
      lorebooks: DoctorDirectoryStatus
      presets: DoctorDirectoryStatus
      personas: DoctorDirectoryStatus
      regex: DoctorDirectoryStatus
      sessions: DoctorDirectoryStatus
    }
  }
  statistics: {
    files: {
      total: number
      json: number
      invalidJson: number
      oversizedJson: number
      unreadable: number
      skippedLinks: number
      scanTruncated: boolean
    }
    characters: {
      directories: number
      healthy: number
      unhealthy: number
      uninspected: number
      archived: number
      drafts: number
      invalidIds: number
      unsafeEntries: number
    }
    stories: {
      directories: number
      healthy: number
      unhealthy: number
      uninspected: number
      drafts: number
      unsafeEntries: number
    }
    wal: {
      roots: number
      floors: number
      active: number
      rolledBack: number
      healthy: number
      unhealthy: number
      uninspected: number
      committed: number
      pending: number
      unsafeEntries: number
    }
  }
  issues: DoctorIssue[]
}

export interface RunDoctorOptions {
  /** 测试或显式 CLI 覆盖使用；该绝对值从不进入报告。 */
  home?: string
  env?: Record<string, string | undefined>
  nodeVersion?: string
  pluginVersion?: string
  /** 测试注入；非法值会折叠为 unknown，绝不原样输出。 */
  dshInstalledVersion?: string
  dshExpectedVersion?: string
  /** 仅允许缩小默认累计预算，供边界测试与受限环境使用。 */
  readBudgetBytes?: number
  /** 结构检查与普通文件遍历共用目录项预算；只能缩小默认上限。 */
  scanEntryLimit?: number
}

type ReadTextResult =
  | { status: 'ok'; text: string }
  | { status: 'missing' | 'invalid' | 'unsafe' | 'oversized' | 'unreadable' | 'budget' }

type ReadJsonResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' | 'invalid' | 'unsafe' | 'oversized' | 'unreadable' | 'budget' }

type ValidationResult = 'healthy' | 'unhealthy' | 'uninspected'

interface ReadBudget {
  remaining: number
  exhausted: boolean
}

interface ScanBudget {
  remaining: number
  exhausted: boolean
}

class IssueCounter {
  private readonly issues = new Map<string, DoctorIssue>()

  add(code: string, severity: DoctorSeverity, count = 1): void {
    const current = this.issues.get(code)
    if (current) current.count += count
    else this.issues.set(code, { code, severity, count })
  }

  values(): DoctorIssue[] {
    const rank: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2 }
    return [...this.issues.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code))
  }
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/**
 * 打开时拒绝链接，固定位置分块读取且最多碰 `maxBytes + 1` 字节。多读的一字节只用于
 * 识别 fstat 后增长；累计预算不足时宁可记作未检查，也不会部分解析或继续读取。
 */
async function readBoundedText(path: string, maxBytes: number, sharedBudget?: ReadBudget): Promise<ReadTextResult> {
  let before
  try {
    before = await lstat(path)
  } catch (error) {
    return errno(error) === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' }
  }
  if (before.isSymbolicLink()) return { status: 'unsafe' }
  if (!before.isFile()) return { status: 'invalid' }
  if (before.size > maxBytes) return { status: 'oversized' }

  let handle
  try {
    // Windows 的 Node 常量表没有 O_NOFOLLOW；此时以前后 lstat + 已打开句柄 inode
    // 复核补足。Unix 同时使用 O_NOFOLLOW，在内核层拒绝最后一段链接。
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const current = await handle.stat()
    const after = await lstat(path)
    if (after.isSymbolicLink() || !after.isFile() || current.dev !== before.dev || current.ino !== before.ino
      || current.dev !== after.dev || current.ino !== after.ino) return { status: 'unsafe' }
    if (!current.isFile()) return { status: 'invalid' }
    if (current.size > maxBytes) return { status: 'oversized' }
    const budget = sharedBudget ?? { remaining: maxBytes + 1, exhausted: false }
    // 为增长探针预留一字节；预算刚好等于旧大小时不能证明完整快照。
    if (current.size >= budget.remaining) {
      budget.exhausted = true
      return { status: 'budget' }
    }
    const chunks: Buffer[] = []
    let position = 0
    while (position <= maxBytes) {
      if (budget.remaining <= 0) {
        budget.exhausted = true
        return { status: 'budget' }
      }
      const expected = current.size >= position ? current.size + 1 - position : READ_CHUNK_BYTES
      const length = Math.min(READ_CHUNK_BYTES, Math.max(256, expected), maxBytes + 1 - position, budget.remaining)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead === 0) return { status: 'ok', text: Buffer.concat(chunks, position).toString('utf8') }
      budget.remaining -= bytesRead
      position += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
      if (position > maxBytes) return { status: 'oversized' }
    }
    return { status: 'oversized' }
  } catch (error) {
    if (errno(error) === 'ENOENT') return { status: 'missing' }
    if (errno(error) === 'ELOOP') return { status: 'unsafe' }
    return { status: 'unreadable' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** 楼层目录不含任何开始标记文件（链接或不可读都不算缺失，交给后续检查报错）。 */
async function isUnstartedFloor(directory: string): Promise<boolean> {
  for (const name of WAL_FLOOR_MARKERS) {
    try { await lstat(`${directory}/${name}`) } catch (error) {
      if (errno(error) === 'ENOENT') continue
    }
    return false
  }
  return true
}

async function readBoundedJson(
  path: string,
  maxBytes = MAX_JSON_BYTES,
  budget?: ReadBudget,
  inspectedJson?: Map<string, ReadJsonResult['status']>,
): Promise<ReadJsonResult> {
  const read = await readBoundedText(path, maxBytes, budget)
  const done = (result: ReadJsonResult): ReadJsonResult => {
    if (inspectedJson && (
      result.status === 'ok'
      || result.status === 'invalid'
      || result.status === 'unsafe'
      || result.status === 'unreadable'
      || (result.status === 'oversized' && maxBytes >= MAX_JSON_BYTES)
    )) {
      inspectedJson.set(rootIdentity(path), result.status)
    }
    return result
  }
  if (read.status !== 'ok') return done(read)
  try {
    return done({ status: 'ok', value: JSON.parse(read.text) as unknown })
  } catch {
    return done({ status: 'invalid' })
  }
}

async function probeDirectory(path: string, boundary?: string, verifiedDirs?: Set<string>): Promise<DoctorDirectoryStatus> {
  const resolvedPath = resolve(path)
  if (boundary !== undefined) {
    const resolvedBoundary = resolve(boundary)
    const local = relative(resolvedBoundary, resolvedPath)
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return 'unreadable'
    let current = resolvedBoundary
    // 必须逐段检查 state/wal、library/* 等多级目录；只 lstat 末级仍会跟随中间的 junction。
    const parents = [current]
    for (const part of local.split(sep).filter(Boolean).slice(0, -1)) {
      current = join(current, part)
      parents.push(current)
    }
    for (const parent of parents) {
      if (verifiedDirs?.has(rootIdentity(parent))) continue
      const status = await probeDirectory(parent, undefined, verifiedDirs)
      if (status !== 'directory') return status
    }
  }
  const pathKey = rootIdentity(resolvedPath)
  if (verifiedDirs?.has(pathKey)) return 'directory'
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    return errno(error) === 'ENOENT' ? 'missing' : 'unreadable'
  }
  if (info.isSymbolicLink()) return 'link'
  if (!info.isDirectory()) return 'file'
  let directory
  try {
    directory = await opendir(path)
    verifiedDirs?.add(pathKey)
    return 'directory'
  } catch {
    return 'unreadable'
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

/** 目录项本身也有累计上限，避免结构检查的 readdir 在正文预算生效前耗尽内存；返回前按名称排序保证跨平台预算截断一致。 */
async function readDirectoryEntries(path: string, budget: ScanBudget): Promise<Dirent[]> {
  if (budget.remaining <= 0) {
    budget.exhausted = true
    return []
  }
  const entries: Dirent[] = []
  const directory = await opendir(path)
  try {
    for await (const entry of directory) {
      if (budget.remaining <= 0) {
        budget.exhausted = true
        break
      }
      budget.remaining -= 1
      entries.push(entry)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validStoryMetadata(value: unknown, id: string): boolean {
  return isRecord(value) && value.version === 1 && value.id === id && typeof value.sessionId === 'string'
    && typeof value.createdAt === 'string' && typeof value.migrated === 'boolean'
}

function validArchiveMetadata(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && validDate(value.archivedAt)
}

/**
 * WAL 楼层只消费首次有界快照；活跃与已回滚目录使用同一套事务格式约束。
 * 记录行与恢复游标的判定与运行时共用（state/walFormat.ts），诊断不能比运行时更宽或更严。
 */
async function validateWalArtifacts(
  directory: string,
  budget: ReadBudget,
  rolledBack = false,
  inspectedJson?: Map<string, ReadJsonResult['status']>,
): Promise<ValidationResult | 'recovering'> {
  const recordsRead = await readBoundedText(`${directory}/records.jsonl`, MAX_WAL_BYTES, budget)
  if (recordsRead.status === 'oversized' || recordsRead.status === 'budget') return 'uninspected'
  if (recordsRead.status === 'unsafe' || recordsRead.status === 'invalid' || recordsRead.status === 'unreadable') return 'unhealthy'
  const records: RecordLine[] = []
  if (recordsRead.status === 'ok') {
    for (const line of recordsRead.text.split('\n')) {
      if (!line.trim()) continue
      let record: unknown
      try { record = JSON.parse(line) as unknown } catch { return 'unhealthy' }
      if (recordLineIssue(record, records.length + 1)) return 'unhealthy'
      records.push(record as RecordLine)
    }
  }

  const progressRead = await readBoundedJson(`${directory}/rollback-progress.json`, MAX_WAL_BYTES, budget, inspectedJson)
  if (progressRead.status === 'missing') return rolledBack && records.length > 0 ? 'unhealthy' : 'healthy'
  if (progressRead.status === 'oversized' || progressRead.status === 'budget') return 'uninspected'
  if (progressRead.status !== 'ok') return 'unhealthy'
  const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
  const checked = checkRollbackProgress(progressRead.value, records, hash)
  if (!checked.ok) return 'unhealthy'
  if (rolledBack) return checked.progress.next === -1 && !checked.progress.pending ? 'healthy' : 'unhealthy'
  return 'recovering'
}

/**
 * 清单与磁盘日志对账：清单里登记的每个楼层身份（floor + startedAt）必须仍能在日志目录中找到，
 * 判定与 Wal.doListFloors 相同（含已回滚副本；被清空日志的目录不贡献身份）。
 * 运行时在开层/回退/分支前会拒绝这种数据，只读诊断不能把它算成健康——
 * 否则 backup 会把「哈希自洽但恢复后不可用」的副本判为可恢复。
 * 清单形状（版本、字段白名单、楼层名长度、开始时间、同名不重复）与 Wal.readCoverage 共用 parseWalCoverage。
 */
async function inspectWalCoverage(
  root: string,
  presentIdentities: ReadonlySet<string>,
  unresolvedFloors: ReadonlySet<string>,
  stats: DoctorReport['statistics']['wal'],
  issues: IssueCounter,
  budget: ReadBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
): Promise<void> {
  // 清单根是工作区（root 的祖父目录），路径为 <workspace>/state/wal-coverage.json。
  const path = join(dirname(dirname(root)), ...WAL_COVERAGE_PATH.split('/'))
  const read = await readBoundedJson(path, MAX_WAL_COVERAGE_BYTES, budget, inspectedJson)
  if (read.status === 'missing') return
  if (read.status === 'budget') {
    stats.uninspected += 1
    issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
    return
  }
  const floors = read.status === 'ok' ? parseWalCoverage(read.value) : null
  if (floors === null) {
    issues.add('WAL_COVERAGE_INVALID', 'error')
    return
  }
  let missing = 0
  for (const floor of floors) {
    // 没能读到元数据的楼层目录不能断言「日志已丢失」，交给 WAL_INVALID / 限额警告。
    if (unresolvedFloors.has(sanitizeFloor(floor.floor))) continue
    if (!presentIdentities.has(JSON.stringify([floor.floor, floor.startedAt]))) missing += 1
  }
  if (missing > 0) issues.add('WAL_FLOOR_MISSING', 'error', missing)
}

async function inspectWalRecovery(
  root: string,
  stats: DoctorReport['statistics']['wal'],
  issues: IssueCounter,
  budget: ReadBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
): Promise<boolean> {
  const path = join(dirname(dirname(root)), ...WAL_RECOVERY_PATH.split('/'))
  const read = await readBoundedJson(path, MAX_WAL_COVERAGE_BYTES, budget, inspectedJson)
  if (read.status === 'missing') return false
  if (read.status === 'budget') {
    stats.uninspected += 1
    issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
    return false
  }
  if (read.status !== 'ok' || !parseRecoveryMarker(read.value).valid) {
    issues.add('WAL_INVALID', 'error')
    return false
  }
  return true
}

async function inspectWalRoot(
  root: string,
  stats: DoctorReport['statistics']['wal'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
  verifiedDirs: Set<string>,
): Promise<void> {
  const pendingBefore = stats.pending
  const status = await probeDirectory(root, dirname(dirname(root)), verifiedDirs)
  if (status === 'missing') {
    // 日志目录被整体删除时清单仍可能登记着楼层；没有可枚举的身份，全部按缺失报告。
    await inspectWalCoverage(root, new Set(), new Set(), stats, issues, budget, inspectedJson)
    if (await inspectWalRecovery(root, stats, issues, budget, inspectedJson)) {
      issues.add('WAL_RECOVERY_IN_PROGRESS', 'warning', 1)
    }
    return
  }
  if (status === 'link') {
    stats.unsafeEntries += 1
    issues.add('WAL_LINK_SKIPPED', 'error')
    return
  }
  if (status !== 'directory') {
    issues.add('WAL_ROOT_UNREADABLE', 'error')
    return
  }
  stats.roots += 1
  let entries
  try { entries = await readDirectoryEntries(root, scanBudget) } catch {
    issues.add('WAL_ROOT_UNREADABLE', 'error')
    return
  }
  const presentIdentities = new Set<string>()
  /** 因限额或链接而没能读到元数据的楼层目录名（净化后）；清单对账不能把它们当成缺失。 */
  const unresolvedFloors = new Set<string>()
  let enumerationComplete = !budget.exhausted && !scanBudget.exhausted
  let recoveringFloors = 0
  for (const entry of entries) {
    if (budget.exhausted) { enumerationComplete = false; break }
    // 回滚副本按运行时的严格后缀识别：楼层 id 中段含 `.rolled-back-` 的活跃目录不是副本。
    const rolledBack = isRolledBackDir(entry.name)
    const baseName = baseFloorDir(entry.name)
    if (entry.isSymbolicLink()) {
      unresolvedFloors.add(baseName)
      stats.unsafeEntries += 1
      issues.add('WAL_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    // 与 Wal 相同：开始楼层时崩溃遗留的空目录不是损坏，宿主会跳过并允许重新开始。
    if (!rolledBack && await isUnstartedFloor(`${root}/${entry.name}`)) continue
    stats.floors += 1
    if (rolledBack) stats.rolledBack += 1
    else stats.active += 1

    const directory = `${root}/${entry.name}`
    const metaRead = await readBoundedJson(`${directory}/meta.json`, MAX_JSON_BYTES, budget, inspectedJson)
    if (metaRead.status === 'oversized' || metaRead.status === 'budget') {
      unresolvedFloors.add(baseName)
      stats.uninspected += 1
      issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
      continue
    }
    const meta = metaRead.status === 'ok' ? metaRead.value : undefined
    if (!isFloorMetaShape(meta) || !isValidWalFloorDir(baseName) || sanitizeFloor(meta.floor) !== baseName
      || (rolledBack && !validDate(meta.rolledBackAt))) {
      stats.unhealthy += 1
      issues.add('WAL_INVALID', 'error')
      continue
    }

    // 已成功回滚的目录是终态（meta.committed 保持回滚前的值），不是遗留未收口事务。

    // 清单身份与 Wal.doListFloors 一致：元数据有效的楼层（含回滚副本）才算「日志仍在」。
    presentIdentities.add(JSON.stringify([meta.floor, meta.startedAt]))

    const validation = await validateWalArtifacts(directory, budget, rolledBack, inspectedJson)
    if (!rolledBack && validation === 'recovering') recoveringFloors += 1
    if (!rolledBack && (validation === 'recovering' || !meta.committed)) stats.pending += 1
    else if (meta.committed) stats.committed += 1
    if (validation === 'healthy' || validation === 'recovering') stats.healthy += 1

    else if (validation === 'uninspected') {
      stats.uninspected += 1
      issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
    } else {
      stats.unhealthy += 1
      issues.add('WAL_INVALID', 'error')
    }
  }
  // 只在完整枚举后对账：预算耗尽或目录项被截断时不能断言某层日志已丢失。
  let hasRecoveryMarker = false
  if (enumerationComplete && !budget.exhausted && !scanBudget.exhausted) {
    await inspectWalCoverage(root, presentIdentities, unresolvedFloors, stats, issues, budget, inspectedJson)
    hasRecoveryMarker = await inspectWalRecovery(root, stats, issues, budget, inspectedJson)
  }
  if (recoveringFloors > 0 || hasRecoveryMarker) {
    issues.add('WAL_RECOVERY_IN_PROGRESS', 'warning', Math.max(recoveringFloors, 1))
  }
  if (stats.pending > pendingBefore) issues.add('WAL_UNCOMMITTED', 'warning', stats.pending - pendingBefore)
}

interface DiscoveredStory {
  sessionId: string | null
  bound: boolean
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 只读检查头像 PNG 的 8 字节魔数，避免解码大图或跟随链接；文件缺失不算错误。 */
async function inspectAvatarPng(path: string, budget: ReadBudget): Promise<'missing' | 'ok' | 'invalid' | 'link' | 'budget'> {
  let before
  try { before = await lstat(path) } catch (error) {
    return errno(error) === 'ENOENT' ? 'missing' : 'invalid'
  }
  if (before.isSymbolicLink()) return 'link'
  if (!before.isFile() || before.size < PNG_MAGIC.length) return 'invalid'
  if (budget.remaining < PNG_MAGIC.length) {
    budget.exhausted = true
    return 'budget'
  }
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const current = await handle.stat()
    const after = await lstat(path)
    if (after.isSymbolicLink() || !after.isFile() || current.dev !== before.dev || current.ino !== before.ino
      || current.dev !== after.dev || current.ino !== after.ino) return 'link'
    if (current.size < PNG_MAGIC.length) return 'invalid'
    const header = Buffer.allocUnsafe(PNG_MAGIC.length)
    const { bytesRead } = await handle.read(header, 0, PNG_MAGIC.length, 0)
    budget.remaining -= bytesRead
    return bytesRead === PNG_MAGIC.length && header.equals(PNG_MAGIC) ? 'ok' : 'invalid'
  } catch (error) {
    if (errno(error) === 'ENOENT') return 'missing'
    if (errno(error) === 'ELOOP') return 'link'
    return 'invalid'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function inspectStories(
  cardId: string,
  cardRoot: string,
  stats: DoctorReport['statistics'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
  verifiedDirs: Set<string>,
  knownStories: Map<string, DiscoveredStory>,
): Promise<void> {
  const draftsBefore = stats.stories.drafts
  const storiesRoot = `${cardRoot}/stories`
  const status = await probeDirectory(storiesRoot, undefined, verifiedDirs)
  if (status === 'missing') return
  if (status === 'link') {
    stats.stories.unsafeEntries += 1
    issues.add('STORY_LINK_SKIPPED', 'error')
    return
  }
  if (status !== 'directory') {
    issues.add('STORIES_DIRECTORY_INVALID', 'error')
    return
  }
  let entries
  try { entries = await readDirectoryEntries(storiesRoot, scanBudget) } catch {
    issues.add('STORIES_DIRECTORY_UNREADABLE', 'error')
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.preparing-')) {
      if (entry.isDirectory()) stats.stories.drafts += 1
      else if (entry.isSymbolicLink()) { stats.stories.unsafeEntries += 1; issues.add('STORY_LINK_SKIPPED', 'error') }
      continue
    }
    if (entry.isSymbolicLink()) {
      stats.stories.unsafeEntries += 1
      issues.add('STORY_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    stats.stories.directories += 1
    if (budget.exhausted) {
      stats.stories.uninspected += 1
      continue
    }
    let root: string
    try { root = storyRoot(cardRoot, entry.name) } catch {
      stats.stories.unhealthy += 1
      issues.add('STORY_METADATA_INVALID', 'error')
      continue
    }
    verifiedDirs.add(rootIdentity(root))
    const storyKey = caseIdentity(`${cardId}/${entry.name}`)
    const metadata = await readBoundedJson(`${root}/story.json`, 256 * 1024, budget, inspectedJson)
    if (metadata.status === 'budget') {
      stats.stories.uninspected += 1
      continue
    }
    if (metadata.status !== 'ok') {
      if (metadata.status !== 'missing') knownStories.set(storyKey, { sessionId: null, bound: false })
      stats.stories.unhealthy += 1
      issues.add(metadata.status === 'oversized' ? 'STORY_METADATA_TOO_LARGE' : 'STORY_METADATA_INVALID', 'error')
      continue
    }
    if (validStoryMetadata(metadata.value, entry.name)) {
      stats.stories.healthy += 1
      knownStories.set(storyKey, { sessionId: (metadata.value as { sessionId: string }).sessionId, bound: false })
    } else {
      knownStories.set(storyKey, { sessionId: null, bound: false })
      stats.stories.unhealthy += 1
      issues.add('STORY_METADATA_INVALID', 'error')
      continue
    }
    await inspectWalRoot(`${root}/state/wal`, stats.wal, issues, budget, scanBudget, inspectedJson, verifiedDirs)
  }
  if (stats.stories.drafts > draftsBefore) issues.add('STORY_DRAFT_PRESENT', 'info', stats.stories.drafts - draftsBefore)
}

async function inspectCharacters(
  charactersRoot: string,
  stats: DoctorReport['statistics'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
  verifiedDirs: Set<string>,
  presentCardFiles: Set<string>,
  knownStories: Map<string, DiscoveredStory>,
): Promise<void> {
  const draftsBefore = stats.characters.drafts
  let entries
  try { entries = await readDirectoryEntries(charactersRoot, scanBudget) } catch {
    issues.add('CHARACTERS_DIRECTORY_UNREADABLE', 'error')
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.importing-') || entry.name.startsWith('.preparing-')) {
      if (entry.isDirectory()) stats.characters.drafts += 1
      else if (entry.isSymbolicLink()) { stats.characters.unsafeEntries += 1; issues.add('CHARACTER_LINK_SKIPPED', 'error') }
      continue
    }
    if (entry.isSymbolicLink()) {
      stats.characters.unsafeEntries += 1
      issues.add('CHARACTER_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    stats.characters.directories += 1
    if (budget.exhausted) {
      stats.characters.uninspected += 1
      continue
    }
    if (!isValidCardId(entry.name)) {
      stats.characters.invalidIds += 1
      stats.characters.unhealthy += 1
      issues.add('CHARACTER_ID_INVALID', 'error')
      continue
    }
    const cardRoot = `${charactersRoot}/${entry.name}`
    verifiedDirs.add(rootIdentity(cardRoot))
    // card.json 与运行时写入共用存储上限；通用扫描复用本次结果计数，不再重复读取。
    const card = await readBoundedJson(`${cardRoot}/card.json`, MAX_STORED_CARD_JSON_BYTES, budget, inspectedJson)
    if (card.status === 'budget') {
      stats.characters.uninspected += 1
      continue
    }
    if (card.status !== 'missing' && card.status !== 'unsafe') presentCardFiles.add(caseIdentity(entry.name))
    let healthy = card.status === 'ok' && isRecord(card.value) && typeof card.value.name === 'string' && card.value.name.length > 0
    if (!healthy) issues.add(card.status === 'oversized' ? 'CHARACTER_METADATA_TOO_LARGE' : 'CHARACTER_METADATA_INVALID', 'error')

    const archive = await readBoundedJson(`${cardRoot}/${CHARACTER_ARCHIVE_FILE}`, 64 * 1024, budget, inspectedJson)
    if (archive.status === 'budget') {
      if (!healthy) stats.characters.unhealthy += 1
      else stats.characters.uninspected += 1
      continue
    }
    if (archive.status === 'ok') {
      if (validArchiveMetadata(archive.value)) stats.characters.archived += 1
      else {
        healthy = false
        issues.add('CHARACTER_ARCHIVE_MARKER_INVALID', 'error')
      }
    } else if (archive.status !== 'missing') {
      healthy = false
      issues.add('CHARACTER_ARCHIVE_MARKER_INVALID', 'error')
    }

    if (!budget.exhausted) {
      const avatar = await inspectAvatarPng(`${cardRoot}/card.png`, budget)
      if (avatar === 'invalid') issues.add('CHARACTER_AVATAR_INVALID', 'warning')
    }

    if (healthy) stats.characters.healthy += 1
    else stats.characters.unhealthy += 1
    await inspectWalRoot(`${cardRoot}/state/wal`, stats.wal, issues, budget, scanBudget, inspectedJson, verifiedDirs)
    await inspectStories(entry.name, cardRoot, stats, issues, budget, scanBudget, inspectedJson, verifiedDirs, knownStories)
  }
  if (stats.characters.drafts > draftsBefore) issues.add('CHARACTER_DRAFT_PRESENT', 'info', stats.characters.drafts - draftsBefore)
}

type SharedAssetDirectory = 'library/presets' | 'personas' | 'library/lorebooks'

/**
 * 复用与离线备份一致的会话绑定与引用检查：所有结果仅汇总脱敏问题码与计数，不泄露会话/资产 ID。
 * 严重结构损坏（绑定损坏/串剧情/缺角色/缺剧情）记为 error；删除共享预设/人设/世界书造成的悬空引用记为 warning，
 * 避免正常 UI 删除共享资产后永久锁死离线备份。
 */
async function inspectSessions(
  paths: TavernPaths,
  directories: DoctorReport['storage']['directories'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
  presentCardFiles: ReadonlySet<string>,
  knownStories: Map<string, DiscoveredStory>,
): Promise<void> {
  if (budget.exhausted || scanBudget.exhausted) return
  let corruptBindings = 0
  let enumerationComplete = true
  if (directories.sessions === 'directory') {
    let entries: Dirent[]
    try { entries = await readDirectoryEntries(paths.sessions, scanBudget) } catch {
      return
    }
    if (scanBudget.exhausted) enumerationComplete = false

    const assetDirPaths: Record<SharedAssetDirectory, { root: string; ok: boolean }> = {
      'library/presets': { root: paths.presets, ok: directories.presets === 'directory' },
      personas: { root: paths.personas, ok: directories.personas === 'directory' },
      'library/lorebooks': { root: paths.lorebooks, ok: directories.lorebooks === 'directory' },
    }
    const assetListCache = new Map<SharedAssetDirectory, Array<{ fullPath: string; fileIdKey: string }>>()
    const assetMapCache = new Map<SharedAssetDirectory, Map<string, string>>()
    const candidateCache = new Map<string, { primary: string | null; sourceId: string | null; lorebookId: string | null } | null>()
    const resolvedAssetCache = new Map<string, string | null>()
    const field = (raw: Record<string, unknown>, key: string): string | null => {
      const value = raw[key]
      return typeof value === 'string' && value.trim().length > 0 ? value : null
    }
    const loadAssetDir = async (dir: SharedAssetDirectory): Promise<{ list: Array<{ fullPath: string; fileIdKey: string }>; byKey: Map<string, string> }> => {
      const cachedList = assetListCache.get(dir)
      const cachedMap = assetMapCache.get(dir)
      if (cachedList && cachedMap) return { list: cachedList, byKey: cachedMap }
      const list: Array<{ fullPath: string; fileIdKey: string }> = []
      const byKey = new Map<string, string>()
      const info = assetDirPaths[dir]
      if (info.ok && !scanBudget.exhausted) {
        try {
          const dirEntries = await readDirectoryEntries(info.root, scanBudget)
          for (const item of dirEntries) {
            if (item.isSymbolicLink() || !item.isFile() || !/\.json$/i.test(item.name)) continue
            const fileIdKey = caseIdentity(item.name.slice(0, -5))
            const fullPath = join(info.root, item.name)
            list.push({ fullPath, fileIdKey })
            if (!byKey.has(fileIdKey)) byKey.set(fileIdKey, fullPath)
          }
        } catch {
          // 资产目录读取失败交由通用文件树扫描报错
        }
      }
      assetListCache.set(dir, list)
      assetMapCache.set(dir, byKey)
      return { list, byKey }
    }
    const parseCandidate = async (
      fullPath: string,
      dir: SharedAssetDirectory,
    ): Promise<{ primary: string | null; sourceId: string | null; lorebookId: string | null } | null> => {
      if (candidateCache.has(fullPath)) return candidateCache.get(fullPath) ?? null
      const maxBytes = dir === 'personas' ? MAX_JSON_BYTES : MAX_STORED_CARD_JSON_BYTES
      const read = await readBoundedJson(fullPath, maxBytes, budget, inspectedJson)
      if (read.status === 'budget') return null
      const parsed = read.status === 'ok' && isRecord(read.value)
        ? {
            primary: field(read.value, 'identifier') ?? field(read.value, 'id') ?? field(read.value, 'name'),
            sourceId: field(read.value, 'sourceId'),
            lorebookId: dir === 'personas' ? field(read.value, 'lorebookId') : null,
          }
        : null
      candidateCache.set(fullPath, parsed)
      return parsed
    }
    const resolveAsset = async (dir: SharedAssetDirectory, id: string): Promise<string | null> => {
      const cacheKey = `${dir}\0${id}`
      if (resolvedAssetCache.has(cacheKey)) return resolvedAssetCache.get(cacheKey) ?? null
      const { list, byKey } = await loadAssetDir(dir)
      if (scanBudget.exhausted) return null
      const safe = safeAssetFileId(id)
      const safeKey = caseIdentity(safe)
      if (safe === id) {
        const direct = byKey.get(safeKey) ?? null
        resolvedAssetCache.set(cacheKey, direct)
        return direct
      }
      const prefixKey = `${safeKey}-`
      let matchedPath: string | null = null
      let matches = 0
      let fallbackPath: string | null = null
      for (const { fullPath, fileIdKey } of list) {
        if (fileIdKey !== safeKey && (!fileIdKey.startsWith(prefixKey) || !/^\d+$/.test(fileIdKey.slice(prefixKey.length)))) continue
        const parsed = await parseCandidate(fullPath, dir)
        if (budget.exhausted) return null
        if (!parsed) continue
        const identities = [parsed.sourceId, parsed.primary].filter((v): v is string => v !== null)
        if (identities.some(v => v === id)) {
          matches += 1
          matchedPath = fullPath
        } else if (fileIdKey === safeKey && identities.length === 0) {
          fallbackPath = fullPath
        }
      }
      const resolved = matches === 1 ? matchedPath : matches === 0 ? fallbackPath : null
      resolvedAssetCache.set(cacheKey, resolved)
      return resolved
    }

    for (const entry of entries) {
      if (budget.exhausted || scanBudget.exhausted) { enumerationComplete = false; break }
      if (!/\.json$/i.test(entry.name)) continue
      if (entry.isSymbolicLink() || !entry.isFile()) {
        corruptBindings += 1
        issues.add('BINDING_INVALID', 'error')
        continue
      }
      const bindingPath = join(paths.sessions, entry.name)
      const read = await readBoundedJson(bindingPath, 1024 * 1024, budget, inspectedJson)
      if (read.status === 'budget') { enumerationComplete = false; break }
      if (read.status !== 'ok') {
        corruptBindings += 1
        issues.add('BINDING_INVALID', 'error')
        continue
      }
      let binding: ReturnType<typeof parseSessionBinding>
      try { binding = parseSessionBinding(read.value) } catch {
        corruptBindings += 1
        issues.add('BINDING_INVALID', 'error')
        continue
      }
      const expectedName = `${binding.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
      if (caseIdentity(expectedName) !== caseIdentity(entry.name)) issues.add('BINDING_IDENTITY_INVALID', 'error')
      if (!presentCardFiles.has(caseIdentity(binding.cardId))) {
        issues.add('BINDING_CARD_MISSING', 'error')
      } else if (binding.storyId) {
        const story = knownStories.get(caseIdentity(`${binding.cardId}/${binding.storyId}`))
        if (!story) issues.add('BINDING_STORY_MISSING', 'error')
        else {
          story.bound = true
          if (story.sessionId !== binding.sessionId) issues.add('BINDING_STORY_IDENTITY_INVALID', 'error')
        }
      } else {
        const legacy = knownStories.get(caseIdentity(`${binding.cardId}/${legacyStoryId(binding.sessionId)}`))
        if (legacy) legacy.bound = true
      }

      if (binding.presetId) {
        const found = await resolveAsset('library/presets', binding.presetId)
        if (budget.exhausted || scanBudget.exhausted) { enumerationComplete = false; break }
        if (!found) issues.add('BINDING_ASSET_MISSING', 'warning')
      }
      let personaLorebookId: string | null = null
      if (binding.personaId) {
        const personaPath = await resolveAsset('personas', binding.personaId)
        if (budget.exhausted || scanBudget.exhausted) { enumerationComplete = false; break }
        if (!personaPath) {
          issues.add('BINDING_ASSET_MISSING', 'warning')
        } else {
          const parsedPersona = await parseCandidate(personaPath, 'personas')
          if (budget.exhausted) { enumerationComplete = false; break }
          personaLorebookId = parsedPersona?.lorebookId ?? null
        }
      }
      const loreIds = new Set([...binding.lorebookIds, ...(binding.characterLorebookIds ?? []), binding.characterLorebookId, personaLorebookId])
      for (const id of loreIds) {
        if (!id || id === '@dsh/character') continue
        const found = await resolveAsset('library/lorebooks', id)
        if (budget.exhausted || scanBudget.exhausted) { enumerationComplete = false; break }
        if (!found) issues.add('BINDING_ASSET_MISSING', 'warning')
      }
    }
  }
  if (enumerationComplete && !budget.exhausted && !scanBudget.exhausted && corruptBindings === 0
    && (directories.sessions === 'directory' || directories.sessions === 'missing')) {
    let orphaned = 0
    for (const story of knownStories.values()) {
      if (story.sessionId !== null && !story.bound) orphaned += 1
    }
    if (orphaned > 0) issues.add('STORY_ORPHANED', 'info', orphaned)
  }
}

/** 扫描中断遗留的单会话迁移标记；该标记会阻断对应会话打开与整库离线备份。 */
async function inspectSessionImports(
  dataRoot: string,
  issues: IssueCounter,
  scanBudget: ScanBudget,
  verifiedDirs: Set<string>,
): Promise<void> {
  if (scanBudget.exhausted) return
  const importsRoot = join(dataRoot, 'session-imports')
  const status = await probeDirectory(importsRoot, dataRoot, verifiedDirs)
  if (status !== 'directory') return
  let entries: Dirent[]
  try { entries = await readDirectoryEntries(importsRoot, scanBudget) } catch { return }
  let pending = 0
  for (const entry of entries) {
    if (!entry.isSymbolicLink() && entry.isFile() && /^[a-f0-9]{64}\.json$/i.test(entry.name)) pending += 1
  }
  if (pending > 0) issues.add('SESSION_IMPORT_INCOMPLETE', 'error', pending)
}

/** 扫描编辑器暂存草稿，按运行时 2 MiB 上限与信封格式检查，不重复计费读取预算。 */
async function inspectEditorDrafts(
  dataRoot: string,
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedJson: Map<string, ReadJsonResult['status']>,
  verifiedDirs: Set<string>,
): Promise<void> {
  if (budget.exhausted || scanBudget.exhausted) return
  const draftsRoot = join(dataRoot, 'editor-drafts')
  const status = await probeDirectory(draftsRoot, dataRoot, verifiedDirs)
  if (status !== 'directory') return
  let owners: Dirent[]
  try { owners = await readDirectoryEntries(draftsRoot, scanBudget) } catch { return }
  for (const owner of owners) {
    if (budget.exhausted || scanBudget.exhausted) break
    if (owner.isSymbolicLink() || !owner.isDirectory()) continue
    const ownerDir = join(draftsRoot, owner.name)
    let files: Dirent[]
    try { files = await readDirectoryEntries(ownerDir, scanBudget) } catch { continue }
    for (const file of files) {
      if (budget.exhausted || scanBudget.exhausted) break
      if (file.isSymbolicLink() || !file.isFile() || !file.name.toLowerCase().endsWith('.json')) continue
      const filePath = join(ownerDir, file.name)
      let statInfo
      try { statInfo = await lstat(filePath) } catch { continue }
      if (statInfo.isSymbolicLink() || !statInfo.isFile()) continue
      if (statInfo.size > EDITOR_DRAFT_MAX_BYTES) {
        issues.add('EDITOR_DRAFT_TOO_LARGE', 'warning')
        continue
      }
      const read = await readBoundedJson(filePath, EDITOR_DRAFT_MAX_BYTES, budget, inspectedJson)
      if (read.status === 'budget') break
      if (read.status === 'oversized') {
        issues.add('EDITOR_DRAFT_TOO_LARGE', 'warning')
        continue
      }
      if (read.status !== 'ok') {
        issues.add('EDITOR_DRAFT_INVALID', 'warning')
        continue
      }
      const rec = read.value
      if (!isRecord(rec) || rec.version !== 1 || !validDate(rec.updatedAt) || !isRecord(rec.value)) {
        issues.add('EDITOR_DRAFT_INVALID', 'warning')
      }
    }
  }
}

/** 特定剧情/角色/共享库大文件与运行时各自的持久化上限对齐，避免合法大快照在诊断与离线备份时误报超限。 */
function jsonLimitForDataFile(dataRoot: string, filePath: string): number {
  const rawRel = relative(resolve(dataRoot), resolve(filePath)).replace(/\\/g, '/')
  const rel = process.platform === 'win32' ? rawRel.toLowerCase() : rawRel
  if (/^library\/(?:lorebooks|presets)\/[^/]+\.json$/.test(rel)) {
    return MAX_STORED_CARD_JSON_BYTES
  }
  const match = /^characters\/([^/]+)\/(?:stories\/([^/]+)\/)?(.+)$/.exec(rel)
  if (!match) return MAX_JSON_BYTES
  const rawMatch = /^characters\/([^/]+)\/(?:stories\/([^/]+)\/)?(.+)$/i.exec(rawRel)
  const cardId = rawMatch?.[1] ?? match[1]!
  const isCardDraft = cardId.startsWith('.importing-') || cardId.startsWith('.preparing-')
  if (!isCardDraft && !isValidCardId(cardId)) return MAX_JSON_BYTES
  const storyId = match[2]
  if (storyId !== undefined && !storyId.startsWith('.preparing-') && !/^(?:story-[a-f0-9-]{36}|legacy-[a-f0-9]{32})$/.test(storyId)) {
    return MAX_JSON_BYTES
  }
  const sub = match[3]!
  if (storyId === undefined && (sub === 'card.json' || sub === 'assets/character-book.json' || sub === 'assets/regex-scripts.json')) {
    return MAX_STORED_CARD_JSON_BYTES
  }
  if (sub === 'state/template.json' || /^state\/template-generation\/[^/]+\.json$/.test(sub)) {
    return TEMPLATE_DOCUMENT_LIMIT
  }
  if (sub === 'assets/chat-lorebook.json') {
    return MAX_CHAT_WORLDBOOK_JSON_BYTES
  }
  if (/^state\/wal\/[^/]+\/rollback-progress\.json$/.test(sub)) {
    return MAX_WAL_BYTES
  }
  return MAX_JSON_BYTES
}

/** 统计普通文件并只对 .json 做语法检查；不跟随任何链接，也不输出文件名。 */
async function inspectFiles(
  root: string,
  stats: DoctorReport['statistics']['files'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
  inspectedCards: ReadonlyMap<string, ReadJsonResult['status']>,
): Promise<void> {
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (pending.length > 0 && !scanBudget.exhausted && !budget.exhausted) {
    const current = pending.pop()!
    let entries
    try { entries = await readDirectoryEntries(current.path, scanBudget) } catch {
      stats.unreadable += 1
      issues.add('FILE_TREE_UNREADABLE', 'error')
      continue
    }
    try {
      const subdirs: Array<{ path: string; depth: number }> = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          stats.skippedLinks += 1
          continue
        }
        const child = `${current.path}/${entry.name}`
        if (entry.isDirectory()) {
          if (current.depth < MAX_SCAN_DEPTH) subdirs.push({ path: child, depth: current.depth + 1 })
          else {
            stats.scanTruncated = true
            issues.add('FILE_SCAN_LIMIT_REACHED', 'warning')
          }
          continue
        }
        if (!entry.isFile()) continue
        stats.total += 1
        if (entry.name.toLowerCase().endsWith('.json')) {
          stats.json += 1
          const cached = inspectedCards.get(rootIdentity(child))
          const json = cached !== undefined ? { status: cached } : await readBoundedJson(child, jsonLimitForDataFile(root, child), budget)
          if (json.status === 'oversized') stats.oversizedJson += 1
          else if (json.status === 'invalid') stats.invalidJson += 1
          else if (json.status === 'budget') {
            stats.scanTruncated = true
            break
          }
          else if (json.status !== 'ok') stats.unreadable += 1
        }
      }
      for (let i = subdirs.length - 1; i >= 0; i--) pending.push(subdirs[i]!)
    } catch {
      stats.unreadable += 1
      issues.add('FILE_TREE_UNREADABLE', 'error')
    }
  }
  if (budget.exhausted) stats.scanTruncated = true
  if (stats.skippedLinks > 0) issues.add('FILE_LINK_SKIPPED', 'warning', stats.skippedLinks)
  if (stats.invalidJson > 0) issues.add('JSON_SYNTAX_INVALID', 'error', stats.invalidJson)
  if (stats.oversizedJson > 0) issues.add('JSON_VALIDATION_LIMIT_EXCEEDED', 'warning', stats.oversizedJson)
  if (stats.unreadable > 0) issues.add('FILE_UNREADABLE', 'error', stats.unreadable)
}

const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

/** 包元数据中的异常字符串不应成为诊断输出侧信道；只允许普通精确 SemVer。 */
function safeVersion(value: unknown): string {
  return typeof value === 'string' && SAFE_VERSION.test(value) ? value : 'unknown'
}

interface OwnPackageInfo {
  pluginVersion: string
  dshExpectedVersion: string
}

async function ownPackageInfo(): Promise<OwnPackageInfo> {
  try {
    const read = await readBoundedJson(fileURLToPath(new URL('../package.json', import.meta.url)), 1024 * 1024)
    if (read.status !== 'ok' || !isRecord(read.value)) return { pluginVersion: 'unknown', dshExpectedVersion: 'unknown' }
    return {
      pluginVersion: safeVersion(read.value.version),
      dshExpectedVersion: manifestHostRange(read.value),
    }
  } catch {
    return { pluginVersion: 'unknown', dshExpectedVersion: 'unknown' }
  }
}

/** 从当前安装树解析宿主包；解析出来的文件路径和底层错误都不会进入报告。 */
async function installedDshVersion(): Promise<string> {
  try {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
    const json = await readBoundedJson(packagePath, 1024 * 1024)
    return json.status === 'ok' && isRecord(json.value) ? safeVersion(json.value.version) : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function areDshVersionsCompatible(installedVersion: string, expectedVersion: string): boolean {
  return hostVersionSatisfies(installedVersion, expectedVersion)
}

async function ownPackageVersion(): Promise<string> {
  return (await ownPackageInfo()).pluginVersion
}

function emptyStatistics(): DoctorReport['statistics'] {
  return {
    files: { total: 0, json: 0, invalidJson: 0, oversizedJson: 0, unreadable: 0, skippedLinks: 0, scanTruncated: false },
    characters: { directories: 0, healthy: 0, unhealthy: 0, uninspected: 0, archived: 0, drafts: 0, invalidIds: 0, unsafeEntries: 0 },
    stories: { directories: 0, healthy: 0, unhealthy: 0, uninspected: 0, drafts: 0, unsafeEntries: 0 },
    wal: { roots: 0, floors: 0, active: 0, rolledBack: 0, healthy: 0, unhealthy: 0, uninspected: 0,
      committed: 0, pending: 0, unsafeEntries: 0 },
  }
}

/** 执行一次无副作用诊断；即使目录损坏，返回值也只包含固定字段、状态枚举与计数。 */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const opts: RunDoctorOptions = typeof options === 'string' ? { home: options } : options
  const issues = new IssueCounter()
  const nodeVersion = safeVersion(opts.nodeVersion ?? process.versions.node)
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10)
  const nodeSupported = Number.isFinite(nodeMajor) && nodeMajor >= REQUIRED_NODE_MAJOR
  if (!nodeSupported) issues.add('NODE_VERSION_UNSUPPORTED', 'error')

  const packageInfo = await ownPackageInfo()
  const pluginVersion = safeVersion(opts.pluginVersion ?? packageInfo.pluginVersion)
  if (pluginVersion === 'unknown') issues.add('PLUGIN_VERSION_UNKNOWN', 'warning')
  const dshExpectedVersion = safeHostRange(opts.dshExpectedVersion ?? packageInfo.dshExpectedVersion)
  const dshInstalledVersion = safeVersion(opts.dshInstalledVersion ?? await installedDshVersion())
  const dshCompatible = areDshVersionsCompatible(dshInstalledVersion, dshExpectedVersion)
  if (dshExpectedVersion === 'unknown') issues.add('DSH_EXPECTED_VERSION_UNKNOWN', 'warning')
  if (dshInstalledVersion === 'unknown') issues.add('DSH_INSTALLED_VERSION_UNKNOWN', 'warning')
  if (dshExpectedVersion !== 'unknown' && dshInstalledVersion !== 'unknown' && !dshCompatible) {
    issues.add('DSH_VERSION_INCOMPATIBLE', 'error')
  }

  const requestedBudget = opts.readBudgetBytes
  const budgetLimit = typeof requestedBudget === 'number' && Number.isSafeInteger(requestedBudget) && requestedBudget > 0
    ? Math.min(requestedBudget, MAX_TOTAL_READ_BYTES) : MAX_TOTAL_READ_BYTES
  const budget: ReadBudget = { remaining: budgetLimit, exhausted: false }
  const requestedEntries = opts.scanEntryLimit
  const entryLimit = typeof requestedEntries === 'number' && Number.isSafeInteger(requestedEntries) && requestedEntries > 0
    ? Math.min(requestedEntries, MAX_SCANNED_ENTRIES) : MAX_SCANNED_ENTRIES
  const scanBudget: ScanBudget = { remaining: entryLimit, exhausted: false }

  const home = resolveDshHome(opts.home, opts.env ?? process.env)
  const homeDisplay = dshHomeDisplay(home) as DoctorReport['storage']['home']
  const paths = tavernPaths(home)
  const homeStatus = await probeDirectory(home)
  // home 本身是 symlink/junction 时，不再通过它探测子路径；否则
  // `lstat(home/dsh-tavern)` 会先跟随中间的 home 链接，与只读扫描边界不符。
  const dataRootStatus: DoctorDirectoryStatus = homeStatus === 'directory'
    ? await probeDirectory(paths.root)
    : homeStatus === 'link'
      ? 'link'
      : homeStatus === 'missing'
        ? 'missing'
        : 'unreadable'
  const names = {
    characters: paths.characters,
    lorebooks: paths.lorebooks,
    presets: paths.presets,
    personas: paths.personas,
    regex: paths.regexDir,
    sessions: paths.sessions,
  }
  const directories = {
    characters: 'missing', lorebooks: 'missing', presets: 'missing', personas: 'missing', regex: 'missing', sessions: 'missing',
  } as DoctorReport['storage']['directories']
  const statistics = emptyStatistics()

  if (dataRootStatus === 'missing') {
    issues.add('DATA_ROOT_NOT_INITIALIZED', 'info')
  } else if (dataRootStatus !== 'directory') {
    issues.add(dataRootStatus === 'link' ? 'DATA_ROOT_LINK_SKIPPED' : 'DATA_ROOT_UNREADABLE', 'error')
  } else {
    const verifiedDirs = new Set<string>([rootIdentity(paths.root)])
    for (const [name, path] of Object.entries(names) as Array<[keyof typeof names, string]>) {
      directories[name] = await probeDirectory(path, paths.root, verifiedDirs)
      if (directories[name] === 'missing') issues.add('STANDARD_DIRECTORY_MISSING', 'warning')
      else if (directories[name] !== 'directory') issues.add('STANDARD_DIRECTORY_INVALID', 'error')
    }
    const inspectedJson = new Map<string, ReadJsonResult['status']>()
    const presentCardFiles = new Set<string>()
    const knownStories = new Map<string, DiscoveredStory>()
    if (directories.characters === 'directory') {
      await inspectCharacters(paths.characters, statistics, issues, budget, scanBudget, inspectedJson, verifiedDirs, presentCardFiles, knownStories)
    }
    await inspectSessions(paths, directories, issues, budget, scanBudget, inspectedJson, presentCardFiles, knownStories)
    await inspectSessionImports(paths.root, issues, scanBudget, verifiedDirs)
    await inspectEditorDrafts(paths.root, issues, budget, scanBudget, inspectedJson, verifiedDirs)
    await inspectFiles(paths.root, statistics.files, issues, budget, scanBudget, inspectedJson)
  }
  if (scanBudget.exhausted) {
    statistics.files.scanTruncated = true
    issues.add('FILE_SCAN_LIMIT_REACHED', 'warning')
  }
  if (budget.exhausted) {
    statistics.files.scanTruncated = true
    issues.add('READ_BUDGET_EXCEEDED', 'warning')
  }
  const collected = issues.values()
  return {
    schemaVersion: 1,
    ok: !collected.some(issue => issue.severity === 'error'),
    runtime: { nodeVersion, requiredNodeMajor: REQUIRED_NODE_MAJOR, nodeSupported, pluginVersion,
      dsh: { installedVersion: dshInstalledVersion, expectedVersion: dshExpectedVersion, compatible: dshCompatible } },
    storage: {
      home: homeDisplay,
      dataRoot: `${homeDisplay}/dsh-tavern`,
      homeStatus,
      dataRootStatus,
      directories,
    },
    statistics,
    issues: collected,
  }
}

/** 仅包含静态脱敏修复建议；绝不拼接路径、文件名、角色名或对话正文。 */
const ISSUE_GUIDANCE: Readonly<Record<string, string>> = {
  NODE_VERSION_UNSUPPORTED: 'Upgrade Node.js to >= 24.0.0 before running dsh-liketavern.',
  DSH_VERSION_INCOMPATIBLE: 'Check docs/HOST_COMPATIBILITY.md and align dsh / dsh-liketavern versions.',
  DATA_ROOT_NOT_INITIALIZED: 'Start dsh with dsh-liketavern enabled once to initialize the plugin data directory.',
  DATA_ROOT_LINK_SKIPPED: 'Replace the symlink/junction at DSH_HOME or dsh-tavern with a real directory.',
  DATA_ROOT_UNREADABLE: 'Check filesystem permissions on the dsh-tavern data directory.',
  STANDARD_DIRECTORY_MISSING: 'Restart dsh with dsh-liketavern enabled to recreate missing standard directories.',
  STANDARD_DIRECTORY_INVALID: 'Remove or replace the non-directory or link occupying a standard dsh-tavern directory.',
  CHARACTER_ID_INVALID: 'Remove or rename invalid directories under dsh-tavern/characters/.',
  CHARACTER_METADATA_INVALID: 'Restore the damaged character card.json from a verified offline backup.',
  CHARACTER_METADATA_TOO_LARGE: 'Character card.json exceeds storage limit; restore a smaller valid card.json.',
  CHARACTER_ARCHIVE_MARKER_INVALID: 'Restore or remove the corrupt .archive.json marker in the affected character directory.',
  CHARACTER_AVATAR_INVALID: 'Replace or re-import the corrupt card.png avatar file with a valid PNG image.',
  CHARACTER_LINK_SKIPPED: 'Remove symlinks/junctions inside dsh-tavern/characters/.',
  CHARACTER_DRAFT_PRESENT: 'Interrupted character import/prepare draft detected; restart dsh to sweep stale drafts.',
  STORY_METADATA_INVALID: 'Restore the damaged story.json from a verified offline backup.',
  STORY_METADATA_TOO_LARGE: 'story.json exceeds size limit; restore from a verified offline backup.',
  STORY_LINK_SKIPPED: 'Remove symlinks/junctions inside character stories directories.',
  STORY_DRAFT_PRESENT: 'Interrupted story preparation draft detected; restart dsh to sweep stale drafts.',
  STORY_ORPHANED: 'Unbound story directories remain (e.g. after deleting host chats); review in character delete plan if reclaiming space.',
  WAL_INVALID: 'Corrupt WAL floor or recovery marker detected; restore the affected story from an offline backup.',
  WAL_FLOOR_MISSING: 'WAL coverage references a missing floor directory; restore the complete story WAL from backup.',
  WAL_COVERAGE_INVALID: 'state/wal-coverage.json is invalid; restore the story from a verified offline backup.',
  WAL_LINK_SKIPPED: 'Remove symlinks/junctions inside story state/wal directories.',
  WAL_UNCOMMITTED: 'Uncommitted WAL floor detected; let dsh finish or roll back the interrupted turn.',
  WAL_RECOVERY_IN_PROGRESS: 'An interrupted WAL rollback is locking story writes; retry rollback or reset the rollback cursor in the Memory panel before creating backups.',
  BINDING_INVALID: 'A session binding JSON in dsh-tavern/sessions/ is corrupt or malformed; re-bind the session or restore from backup.',
  BINDING_IDENTITY_INVALID: 'A session binding filename does not match its internal sessionId; restore or remove the mismatched binding.',
  BINDING_CARD_MISSING: 'A session binding points to a missing character; reopen the session to self-heal or clear the stale binding.',
  BINDING_STORY_MISSING: 'A session binding points to a missing story directory; restore the story from backup or clear the binding.',
  BINDING_STORY_IDENTITY_INVALID: 'A session binding points to a story owned by another session; restore from backup before resuming writes.',
  BINDING_ASSET_MISSING: 'A session references a deleted preset, persona, or lorebook; reselect assets in the session header (backups remain allowed).',
  SESSION_IMPORT_INCOMPLETE: 'An interrupted single-session import marker exists in dsh-tavern/session-imports/; retry import with the same archive and workspace.',
  EDITOR_DRAFT_INVALID: 'A saved editor draft in dsh-tavern/editor-drafts/ is malformed; discard or overwrite it from the editor UI.',
  EDITOR_DRAFT_TOO_LARGE: 'A saved editor draft exceeds the 2 MiB runtime limit; clear the oversized draft from the editor UI or editor-drafts/.',
  JSON_SYNTAX_INVALID: 'One or more JSON files have invalid syntax; restore affected files from a verified backup.',
  JSON_VALIDATION_LIMIT_EXCEEDED: 'One or more JSON files exceed the doctor scan size limit; inspect manually.',
  FILE_LINK_SKIPPED: 'Symlinks inside dsh-tavern were skipped; remove unexpected links before offline backup.',
  FILE_SCAN_LIMIT_REACHED: 'Directory entry scan limit reached; some entries were not inspected.',
  READ_BUDGET_EXCEEDED: 'Total read budget reached; some files were not inspected.',
}

export function formatDoctorText(report: DoctorReport): string {
  const { files, characters, stories, wal } = report.statistics
  const lines = [
    `dsh-liketavern doctor: ${report.ok ? 'OK' : 'FAILED'}`,
    `runtime: node=${report.runtime.nodeVersion} supported=${report.runtime.nodeSupported} plugin=${report.runtime.pluginVersion} dsh-installed=${report.runtime.dsh.installedVersion} dsh-expected=${report.runtime.dsh.expectedVersion} dsh-compatible=${report.runtime.dsh.compatible}`,
    `storage: home=${report.storage.home} home-status=${report.storage.homeStatus} data-root=${report.storage.dataRoot} data-status=${report.storage.dataRootStatus}`,
    `directories: ${Object.entries(report.storage.directories).map(([name, status]) => `${name}=${status}`).join(' ')}`,
    `files: total=${files.total} json=${files.json} invalid-json=${files.invalidJson} oversized-json=${files.oversizedJson} unreadable=${files.unreadable} skipped-links=${files.skippedLinks} truncated=${files.scanTruncated}`,
    `characters: directories=${characters.directories} healthy=${characters.healthy} unhealthy=${characters.unhealthy} uninspected=${characters.uninspected} archived=${characters.archived} drafts=${characters.drafts} invalid-ids=${characters.invalidIds} unsafe=${characters.unsafeEntries}`,
    `stories: directories=${stories.directories} healthy=${stories.healthy} unhealthy=${stories.unhealthy} uninspected=${stories.uninspected} drafts=${stories.drafts} unsafe=${stories.unsafeEntries}`,
    `wal: roots=${wal.roots} floors=${wal.floors} active=${wal.active} rolled-back=${wal.rolledBack} healthy=${wal.healthy} unhealthy=${wal.unhealthy} uninspected=${wal.uninspected} committed=${wal.committed} pending=${wal.pending} unsafe=${wal.unsafeEntries}`,
  ]
  for (const issue of report.issues) {
    lines.push(`issue: severity=${issue.severity} code=${issue.code} count=${issue.count}`)
    const hint = ISSUE_GUIDANCE[issue.code]
    if (hint) lines.push(`  hint: ${hint}`)
  }
  return lines.join('\n') + '\n'
}

interface CliArguments {
  json: boolean
  help: boolean
  version: boolean
  home?: string
}

export function parseDoctorArguments(args: string[]): CliArguments {
  const parsed: CliArguments = { json: false, help: false, version: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--json') parsed.json = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--version' || arg === '-v') parsed.version = true
    else if (arg === '--home' || arg.startsWith('--home=')) {
      const value = arg === '--home' ? args[++index] : arg.slice('--home='.length)
      if (!value || value.startsWith('-') || parsed.home !== undefined) throw new Error('invalid arguments')
      parsed.home = value
    } else throw new Error('invalid arguments')
  }
  return parsed
}

const HELP = `Usage: dsh-tavern-doctor [--json] [--home <path>]

Read-only options:
  --json               Emit stable JSON instead of text
  --home <path>        Inspect an explicit DSH home (also accepts --home=<path>; never printed)
  --version | -v       Print the plugin version
  --help | -h          Show this help

Exit codes:
  0  Healthy (no error-severity issues; info/warning issues may still be reported)
  1  One or more error-severity issues found
  2  Invalid CLI arguments or unexpected diagnosis failure

This command never repairs or modifies data.
`

/** CLI 只返回 0（健康）、1（发现错误）或 2（参数/运行失败），失败详情不回显私人路径。 */
export async function doctorMain(
  args = process.argv.slice(2),
  io: { out: (text: string) => void; err: (text: string) => void } = {
    out: text => process.stdout.write(text),
    err: text => process.stderr.write(text),
  },
): Promise<number> {
  let parsed: CliArguments
  try { parsed = parseDoctorArguments(args) } catch {
    io.err(args.includes('--json')
      ? JSON.stringify({ schemaVersion: 1, ok: false, code: 'INVALID_ARGUMENTS' }) + '\n'
      : 'dsh-liketavern doctor: invalid arguments; use --help\n')
    return 2
  }
  if (parsed.help) {
    io.out(HELP)
    return 0
  }
  if (parsed.version) {
    io.out(`${await ownPackageVersion()}\n`)
    return 0
  }
  try {
    const report = await runDoctor({ home: parsed.home })
    io.out(parsed.json ? JSON.stringify(report, null, 2) + '\n' : formatDoctorText(report))
    return report.ok ? 0 : 1
  } catch {
    io.err(parsed.json
      ? JSON.stringify({ schemaVersion: 1, ok: false, code: 'DIAGNOSIS_FAILED' }) + '\n'
      : 'dsh-liketavern doctor: diagnosis failed\n')
    return 2
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  // npm 在 Unix 的 .bin 中使用符号链接，argv[1] 与 ESM 已解析的模块路径可能不同。
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry)) } catch { return false }
}

if (isDirectExecution()) {
  void doctorMain().then(code => { process.exitCode = code }, () => {
    process.stderr.write('dsh-liketavern doctor: diagnosis failed\n')
    process.exitCode = 2
  })
}
