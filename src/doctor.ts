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
import { CHARACTER_ARCHIVE_FILE, isValidCardId } from './state/workspace.js'
import { storyRoot } from './state/story.js'
import { WAL_BINARY_MARK } from './state/wal.js'
import { tavernPaths } from './node/paths.js'

const REQUIRED_NODE_MAJOR = 24
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_WAL_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_READ_BYTES = 256 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const MAX_SCANNED_ENTRIES = 100_000
const MAX_SCAN_DEPTH = 32
const ROLLED_BACK_MARK = '.rolled-back-'

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
      const length = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - position, budget.remaining)
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

async function readBoundedJson(path: string, maxBytes = MAX_JSON_BYTES, budget?: ReadBudget): Promise<ReadJsonResult> {
  const read = await readBoundedText(path, maxBytes, budget)
  if (read.status !== 'ok') return read
  try {
    return { status: 'ok', value: JSON.parse(read.text) as unknown }
  } catch {
    return { status: 'invalid' }
  }
}

async function probeDirectory(path: string, boundary?: string): Promise<DoctorDirectoryStatus> {
  if (boundary !== undefined) {
    const local = relative(resolve(boundary), resolve(path))
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return 'unreadable'
    let current = resolve(boundary)
    // 必须逐段检查 state/wal、library/* 等多级目录；只 lstat 末级仍会跟随中间的 junction。
    const parents = [current]
    for (const part of local.split(sep).filter(Boolean).slice(0, -1)) {
      current = join(current, part)
      parents.push(current)
    }
    for (const parent of parents) {
      const status = await probeDirectory(parent)
      if (status !== 'directory') return status
    }
  }
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
    return 'directory'
  } catch {
    return 'unreadable'
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

/** 目录项本身也有累计上限，避免结构检查的 readdir 在正文预算生效前耗尽内存。 */
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
  return entries
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validStoryMetadata(value: unknown, id: string): boolean {
  return isObject(value) && value.version === 1 && value.id === id && typeof value.sessionId === 'string'
    && typeof value.createdAt === 'string' && typeof value.migrated === 'boolean'
}

function validArchiveMetadata(value: unknown): boolean {
  return isObject(value) && value.version === 1 && validDate(value.archivedAt)
}

function sanitizeFloor(floor: string): string {
  return floor.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function isBase64(value: unknown): value is string {
  return typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value
}

function safeWalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':')
    && !value.startsWith('/') && value.split('/').every(part => part !== '..' && part !== '.' && part !== '')
    && !value.toLowerCase().startsWith('state/wal/')
}

/** WAL 楼层只消费首次有界快照；活跃与已回滚目录使用同一套事务格式约束。 */
async function validateWalArtifacts(directory: string, budget: ReadBudget): Promise<ValidationResult> {
  const recordsRead = await readBoundedText(`${directory}/records.jsonl`, MAX_WAL_BYTES, budget)
  if (recordsRead.status === 'oversized' || recordsRead.status === 'budget') return 'uninspected'
  if (recordsRead.status === 'unsafe' || recordsRead.status === 'invalid' || recordsRead.status === 'unreadable') return 'unhealthy'
  const records: Record<string, unknown>[] = []
  if (recordsRead.status === 'ok') {
    let previous = 0
    for (const line of recordsRead.text.split('\n')) {
      if (!line.trim()) continue
      let record: unknown
      try { record = JSON.parse(line) as unknown } catch { return 'unhealthy' }
      if (!isObject(record) || !safeWalPath(record.path) || !Number.isSafeInteger(record.seq)
        || (record.seq as number) < 1 || (record.seq as number) <= previous
        || !(record.before === null || typeof record.before === 'string')
        || ('after' in record && !(record.after === null || typeof record.after === 'string'))
        || (record.beforeEncoding !== undefined && record.beforeEncoding !== 'utf8' && record.beforeEncoding !== 'base64')
        || (record.afterEncoding !== undefined && record.afterEncoding !== 'utf8' && record.afterEncoding !== 'base64')) return 'unhealthy'
      const before = record.beforeEncoding === undefined && typeof record.before === 'string' && record.before.startsWith(WAL_BINARY_MARK)
        ? record.before.slice(WAL_BINARY_MARK.length) : record.before
      if ((before !== null && (record.beforeEncoding === 'base64' || before !== record.before) && !isBase64(before))
        || (record.afterEncoding === 'base64' && record.after !== null && !isBase64(record.after))) return 'unhealthy'
      previous = record.seq as number
      records.push(record)
    }
  }

  const progressRead = await readBoundedJson(`${directory}/rollback-progress.json`, MAX_JSON_BYTES, budget)
  if (progressRead.status === 'missing') return 'healthy'
  if (progressRead.status === 'oversized' || progressRead.status === 'budget') return 'uninspected'
  if (progressRead.status !== 'ok' || !isObject(progressRead.value)) return 'unhealthy'
  const progress = progressRead.value
  const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
  const paths = new Set(records.map(record => record.path as string))
  const isPaths = (items: unknown): items is string[] => Array.isArray(items)
    && items.every(item => typeof item === 'string' && paths.has(item))
  if (progress.hash !== hash || !Number.isSafeInteger(progress.next) || (progress.next as number) < -1
    || (progress.next as number) >= records.length || !isPaths(progress.restored) || !isPaths(progress.preserved)
    || progress.restored.length + progress.preserved.length !== records.length - (progress.next as number) - 1) return 'unhealthy'
  if ('pending' in progress) {
    const pending = progress.pending
    if (!isObject(pending) || typeof pending.path !== 'string' || pending.path !== records[progress.next as number]?.path
      || !(pending.from === null || isBase64(pending.from)) || !(pending.to === null || isBase64(pending.to))) return 'unhealthy'
  }
  return 'healthy'
}

async function inspectWalRoot(
  root: string,
  stats: DoctorReport['statistics']['wal'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
): Promise<void> {
  const pendingBefore = stats.pending
  const status = await probeDirectory(root, dirname(dirname(root)))
  if (status === 'missing') return
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
  for (const entry of entries) {
    if (budget.exhausted) break
    if (entry.isSymbolicLink()) {
      stats.unsafeEntries += 1
      issues.add('WAL_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    stats.floors += 1
    const rolledBack = entry.name.includes(ROLLED_BACK_MARK)
    if (rolledBack) stats.rolledBack += 1
    else stats.active += 1

    const directory = `${root}/${entry.name}`
    const metaRead = await readBoundedJson(`${directory}/meta.json`, 64 * 1024, budget)
    if (metaRead.status === 'oversized' || metaRead.status === 'budget') {
      stats.uninspected += 1
      issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
      continue
    }
    if (metaRead.status !== 'ok' || !isObject(metaRead.value)) {
      stats.unhealthy += 1
      issues.add('WAL_INVALID', 'error')
      continue
    }
    const meta = metaRead.value
    const baseName = entry.name.split(ROLLED_BACK_MARK)[0]
    if (typeof meta.floor !== 'string' || !meta.floor || sanitizeFloor(meta.floor) !== baseName
      || !validDate(meta.startedAt) || typeof meta.committed !== 'boolean') {
      stats.unhealthy += 1
      issues.add('WAL_INVALID', 'error')
      continue
    }
    if (meta.committed) stats.committed += 1
    else stats.pending += 1

    const validation = await validateWalArtifacts(directory, budget)
    if (validation === 'healthy') stats.healthy += 1
    else if (validation === 'uninspected') {
      stats.uninspected += 1
      issues.add('WAL_VALIDATION_LIMIT_EXCEEDED', 'warning')
    } else {
      stats.unhealthy += 1
      issues.add('WAL_INVALID', 'error')
    }
  }
  if (stats.pending > pendingBefore) issues.add('WAL_UNCOMMITTED', 'warning', stats.pending - pendingBefore)
}

async function inspectStories(
  cardRoot: string,
  stats: DoctorReport['statistics'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
): Promise<void> {
  const draftsBefore = stats.stories.drafts
  const storiesRoot = `${cardRoot}/stories`
  const status = await probeDirectory(storiesRoot)
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
    if (budget.exhausted) break
    if (entry.name.startsWith('.preparing-')) {
      if (entry.isDirectory()) stats.stories.drafts += 1
      else if (entry.isSymbolicLink()) stats.stories.unsafeEntries += 1
      continue
    }
    if (entry.isSymbolicLink()) {
      stats.stories.unsafeEntries += 1
      issues.add('STORY_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    stats.stories.directories += 1
    let root: string
    try { root = storyRoot(cardRoot, entry.name) } catch {
      stats.stories.unhealthy += 1
      issues.add('STORY_METADATA_INVALID', 'error')
      continue
    }
    const metadata = await readBoundedJson(`${root}/story.json`, 256 * 1024, budget)
    if (metadata.status === 'budget') {
      stats.stories.uninspected += 1
      continue
    }
    if (metadata.status !== 'ok') {
      stats.stories.unhealthy += 1
      issues.add(metadata.status === 'oversized' ? 'STORY_METADATA_TOO_LARGE' : 'STORY_METADATA_INVALID', 'error')
      continue
    }
    if (validStoryMetadata(metadata.value, entry.name)) {
      stats.stories.healthy += 1
    } else {
      stats.stories.unhealthy += 1
      issues.add('STORY_METADATA_INVALID', 'error')
      continue
    }
    await inspectWalRoot(`${root}/state/wal`, stats.wal, issues, budget, scanBudget)
  }
  if (stats.stories.drafts > draftsBefore) issues.add('STORY_DRAFT_PRESENT', 'info', stats.stories.drafts - draftsBefore)
}

async function inspectCharacters(
  charactersRoot: string,
  stats: DoctorReport['statistics'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
): Promise<void> {
  let entries
  try { entries = await readDirectoryEntries(charactersRoot, scanBudget) } catch {
    issues.add('CHARACTERS_DIRECTORY_UNREADABLE', 'error')
    return
  }
  for (const entry of entries) {
    if (budget.exhausted) break
    if (entry.isSymbolicLink()) {
      stats.characters.unsafeEntries += 1
      issues.add('CHARACTER_LINK_SKIPPED', 'error')
      continue
    }
    if (!entry.isDirectory()) continue
    stats.characters.directories += 1
    if (!isValidCardId(entry.name)) {
      stats.characters.invalidIds += 1
      stats.characters.unhealthy += 1
      issues.add('CHARACTER_ID_INVALID', 'error')
      continue
    }
    const cardRoot = `${charactersRoot}/${entry.name}`
    const card = await readBoundedJson(`${cardRoot}/card.json`, MAX_JSON_BYTES, budget)
    if (card.status === 'budget') {
      stats.characters.uninspected += 1
      break
    }
    let healthy = card.status === 'ok' && isObject(card.value)
    if (!healthy) issues.add(card.status === 'oversized' ? 'CHARACTER_METADATA_TOO_LARGE' : 'CHARACTER_METADATA_INVALID', 'error')

    const archive = await readBoundedJson(`${cardRoot}/${CHARACTER_ARCHIVE_FILE}`, 64 * 1024, budget)
    if (archive.status === 'budget') {
      stats.characters.uninspected += 1
      break
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

    if (healthy) stats.characters.healthy += 1
    else stats.characters.unhealthy += 1
    await inspectWalRoot(`${cardRoot}/state/wal`, stats.wal, issues, budget, scanBudget)
    await inspectStories(cardRoot, stats, issues, budget, scanBudget)
  }
}

/** 统计普通文件并只对 .json 做语法检查；不跟随任何链接，也不输出文件名。 */
async function inspectFiles(
  root: string,
  stats: DoctorReport['statistics']['files'],
  issues: IssueCounter,
  budget: ReadBudget,
  scanBudget: ScanBudget,
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
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          stats.skippedLinks += 1
          continue
        }
        const child = `${current.path}/${entry.name}`
        if (entry.isDirectory()) {
          if (current.depth < MAX_SCAN_DEPTH) pending.push({ path: child, depth: current.depth + 1 })
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
          const json = await readBoundedJson(child, MAX_JSON_BYTES, budget)
          if (json.status === 'oversized') stats.oversizedJson += 1
          else if (json.status === 'invalid') stats.invalidJson += 1
          else if (json.status === 'budget') {
            stats.scanTruncated = true
            break
          }
          else if (json.status !== 'ok') stats.unreadable += 1
        }
      }
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
    if (read.status !== 'ok' || !isObject(read.value)) return { pluginVersion: 'unknown', dshExpectedVersion: 'unknown' }
    const peers = isObject(read.value.peerDependencies) ? read.value.peerDependencies : null
    return {
      pluginVersion: safeVersion(read.value.version),
      dshExpectedVersion: safeVersion(peers?.['@deepseek-ai/dsh']),
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
    return json.status === 'ok' && isObject(json.value) ? safeVersion(json.value.version) : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function areDshVersionsCompatible(installedVersion: string, expectedVersion: string): boolean {
  const installed = safeVersion(installedVersion)
  const expected = safeVersion(expectedVersion)
  // 精确 peer 是本项目的宿主纪律；SemVer build metadata 不参与版本优先级与兼容判断。
  return installed !== 'unknown' && expected !== 'unknown'
    && installed.split('+')[0] === expected.split('+')[0]
}

async function ownPackageVersion(): Promise<string> {
  return (await ownPackageInfo()).pluginVersion
}

function emptyStatistics(): DoctorReport['statistics'] {
  return {
    files: { total: 0, json: 0, invalidJson: 0, oversizedJson: 0, unreadable: 0, skippedLinks: 0, scanTruncated: false },
    characters: { directories: 0, healthy: 0, unhealthy: 0, uninspected: 0, archived: 0, invalidIds: 0, unsafeEntries: 0 },
    stories: { directories: 0, healthy: 0, unhealthy: 0, uninspected: 0, drafts: 0, unsafeEntries: 0 },
    wal: { roots: 0, floors: 0, active: 0, rolledBack: 0, healthy: 0, unhealthy: 0, uninspected: 0,
      committed: 0, pending: 0, unsafeEntries: 0 },
  }
}

/** 执行一次无副作用诊断；即使目录损坏，返回值也只包含固定字段、状态枚举与计数。 */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const issues = new IssueCounter()
  const nodeVersion = safeVersion(options.nodeVersion ?? process.versions.node)
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10)
  const nodeSupported = Number.isFinite(nodeMajor) && nodeMajor >= REQUIRED_NODE_MAJOR
  if (!nodeSupported) issues.add('NODE_VERSION_UNSUPPORTED', 'error')

  const packageInfo = await ownPackageInfo()
  const pluginVersion = safeVersion(options.pluginVersion ?? packageInfo.pluginVersion)
  if (pluginVersion === 'unknown') issues.add('PLUGIN_VERSION_UNKNOWN', 'warning')
  const dshExpectedVersion = safeVersion(options.dshExpectedVersion ?? packageInfo.dshExpectedVersion)
  const dshInstalledVersion = safeVersion(options.dshInstalledVersion ?? await installedDshVersion())
  const dshCompatible = areDshVersionsCompatible(dshInstalledVersion, dshExpectedVersion)
  if (dshExpectedVersion === 'unknown') issues.add('DSH_EXPECTED_VERSION_UNKNOWN', 'warning')
  if (dshInstalledVersion === 'unknown') issues.add('DSH_INSTALLED_VERSION_UNKNOWN', 'warning')
  if (dshExpectedVersion !== 'unknown' && dshInstalledVersion !== 'unknown' && !dshCompatible) {
    issues.add('DSH_VERSION_INCOMPATIBLE', 'error')
  }

  const requestedBudget = options.readBudgetBytes
  const budgetLimit = typeof requestedBudget === 'number' && Number.isSafeInteger(requestedBudget) && requestedBudget > 0
    ? Math.min(requestedBudget, MAX_TOTAL_READ_BYTES) : MAX_TOTAL_READ_BYTES
  const budget: ReadBudget = { remaining: budgetLimit, exhausted: false }
  const requestedEntries = options.scanEntryLimit
  const entryLimit = typeof requestedEntries === 'number' && Number.isSafeInteger(requestedEntries) && requestedEntries > 0
    ? Math.min(requestedEntries, MAX_SCANNED_ENTRIES) : MAX_SCANNED_ENTRIES
  const scanBudget: ScanBudget = { remaining: entryLimit, exhausted: false }

  const home = resolveDshHome(options.home, options.env ?? process.env)
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
    for (const [name, path] of Object.entries(names) as Array<[keyof typeof names, string]>) {
      directories[name] = await probeDirectory(path, paths.root)
      if (directories[name] === 'missing') issues.add('STANDARD_DIRECTORY_MISSING', 'warning')
      else if (directories[name] !== 'directory') issues.add('STANDARD_DIRECTORY_INVALID', 'error')
    }
    if (directories.characters === 'directory') await inspectCharacters(paths.characters, statistics, issues, budget, scanBudget)
    await inspectFiles(paths.root, statistics.files, issues, budget, scanBudget)
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

export function formatDoctorText(report: DoctorReport): string {
  const { files, characters, stories, wal } = report.statistics
  const lines = [
    `dsh-liketavern doctor: ${report.ok ? 'OK' : 'FAILED'}`,
    `runtime: node=${report.runtime.nodeVersion} supported=${report.runtime.nodeSupported} plugin=${report.runtime.pluginVersion} dsh-installed=${report.runtime.dsh.installedVersion} dsh-expected=${report.runtime.dsh.expectedVersion} dsh-compatible=${report.runtime.dsh.compatible}`,
    `storage: home=${report.storage.home} home-status=${report.storage.homeStatus} data-root=${report.storage.dataRoot} data-status=${report.storage.dataRootStatus}`,
    `directories: ${Object.entries(report.storage.directories).map(([name, status]) => `${name}=${status}`).join(' ')}`,
    `files: total=${files.total} json=${files.json} invalid-json=${files.invalidJson} oversized-json=${files.oversizedJson} unreadable=${files.unreadable} skipped-links=${files.skippedLinks} truncated=${files.scanTruncated}`,
    `characters: directories=${characters.directories} healthy=${characters.healthy} unhealthy=${characters.unhealthy} uninspected=${characters.uninspected} archived=${characters.archived} invalid-ids=${characters.invalidIds} unsafe=${characters.unsafeEntries}`,
    `stories: directories=${stories.directories} healthy=${stories.healthy} unhealthy=${stories.unhealthy} uninspected=${stories.uninspected} drafts=${stories.drafts} unsafe=${stories.unsafeEntries}`,
    `wal: roots=${wal.roots} floors=${wal.floors} active=${wal.active} rolled-back=${wal.rolledBack} healthy=${wal.healthy} unhealthy=${wal.unhealthy} uninspected=${wal.uninspected} committed=${wal.committed} pending=${wal.pending} unsafe=${wal.unsafeEntries}`,
  ]
  for (const issue of report.issues) lines.push(`issue: severity=${issue.severity} code=${issue.code} count=${issue.count}`)
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
    else if (arg === '--home') {
      const value = args[++index]
      if (!value) throw new Error('invalid arguments')
      parsed.home = value
    } else throw new Error('invalid arguments')
  }
  return parsed
}

const HELP = `Usage: dsh-tavern-doctor [--json] [--home <path>]\n\nRead-only options:\n  --json         Emit stable JSON instead of text\n  --home <path>  Inspect an explicit DSH home (the path is never printed)\n  --version      Print the plugin version\n  --help         Show this help\n\nThis command never repairs or modifies data.\n`

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
    io.err('dsh-liketavern doctor: invalid arguments; use --help\n')
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
    io.err('dsh-liketavern doctor: diagnosis failed\n')
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
