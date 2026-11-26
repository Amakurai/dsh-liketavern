/** 用户数据离线快照与恢复：清单校验后发布新目录；依赖安装树明确排除，宿主历史与插件状态一起保存。 */
import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { renameWithRetry } from '../state/rename.js'
import { runDoctor, type DoctorIssue } from '../doctor.js'
import { safeHostRange } from '../core/hostVersion.js'
import { BACKUP_LIMITS, BackupError, ancestorChainAbove, assertAbsent, assertDirectory, assertSeparate, boundedJson, checkedPath,
  createDirectories, discardTemporary, fail, inventory, isDependencyPath, safeRelative, transferFile, type BackupEntry, type ScannedEntry } from './backupFiles.js'
import { isRecord } from '../core/guards.js'

export interface BackupManifest {
  schemaVersion: 1
  format: 'dsh-tavern-directory-backup'
  scope: 'dsh-home-data-without-installed-dependencies'
  createdAt: string
  versionSource: 'backup-runtime'
  versions: { node: string; plugin: string; dsh: string; expectedDsh: string }
  exclusions: string[]
  entries: BackupEntry[]
}
export interface BackupReport {
  schemaVersion: 1
  ok: boolean
  operation: 'create' | 'verify' | 'restore'
  code: string
  files: number
  directories: number
  bytes: number
  excludedDependencyDirectories: number
  dependenciesNeedReinstall: boolean
  offlineDeclared: boolean
  offlineVerified: false
  issues: DoctorIssue[]
}
export interface BackupHooks {
  /** 只用于真实文件系统故障注入；CLI 不接受此入口。 */
  afterCopy?: () => Promise<void>
  beforePublish?: () => Promise<void>
}
function version(value: unknown): value is string { return typeof value === 'string' && /^(?:unknown|\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.test(value) }

export function parseBackupManifest(raw: unknown): BackupManifest {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.format !== 'dsh-tavern-directory-backup'
    || raw.scope !== 'dsh-home-data-without-installed-dependencies' || raw.versionSource !== 'backup-runtime' || typeof raw.createdAt !== 'string'
    || !Number.isFinite(Date.parse(raw.createdAt)) || !isRecord(raw.versions)
    || !['node', 'plugin', 'dsh'].every(key => version((raw.versions as Record<string, unknown>)[key]))
    || (raw.versions.expectedDsh !== 'unknown' && safeHostRange(raw.versions.expectedDsh) === 'unknown')
    || !Array.isArray(raw.entries) || raw.entries.length > BACKUP_LIMITS.entries || !Array.isArray(raw.exclusions)) fail('INVALID_MANIFEST')
  const entries: BackupEntry[] = []
  const seen = new Set<string>()
  const directories = new Set<string>()
  let total = 0
  let pathBytes = 0
  for (const value of raw.entries) {
    if (!isRecord(value) || !safeRelative(value.path) || (value.kind !== 'file' && value.kind !== 'directory')
      || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > BACKUP_LIMITS.fileBytes
      || typeof value.mode !== 'number' || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777
      || (value.kind === 'directory' && (value.size !== 0 || value.sha256 !== undefined || value.hardlinkGroup !== undefined))
      || (value.kind === 'file' && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
      || (value.hardlinkGroup !== undefined && (typeof value.hardlinkGroup !== 'number' || !Number.isSafeInteger(value.hardlinkGroup) || value.hardlinkGroup < 1))) fail('INVALID_MANIFEST')
    const key = value.path.normalize('NFC').toLocaleLowerCase('en-US')
    pathBytes += Buffer.byteLength(value.path)
    if (pathBytes > BACKUP_LIMITS.pathBytes) fail('METADATA_LIMIT')
    if (seen.has(key)) fail('PATH_COLLISION')
    seen.add(key)
    if (value.kind === 'directory') directories.add(value.path)
    total += value.size
    if (total > BACKUP_LIMITS.totalBytes) fail('SIZE_LIMIT')
    entries.push({ path: value.path, kind: value.kind, size: value.size, mode: value.mode,
      ...(value.kind === 'file' ? { sha256: value.sha256 as string } : {}),
      ...(value.hardlinkGroup !== undefined ? { hardlinkGroup: value.hardlinkGroup as number } : {}) })
  }
  const hardlinkGroups = new Map<number, BackupEntry[]>()
  for (const entry of entries) {
    if (entry.hardlinkGroup !== undefined) {
      const group = hardlinkGroups.get(entry.hardlinkGroup)
      if (group) group.push(entry)
      else hardlinkGroups.set(entry.hardlinkGroup, [entry])
    }
  }
  for (const group of hardlinkGroups.values()) {
    const first = group[0]!
    if (group.length < 2 || group.some(item => item.size !== first.size || item.sha256 !== first.sha256 || item.mode !== first.mode)) {
      fail('INVALID_MANIFEST')
    }
  }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    for (let n = 1; n < parts.length; n++) if (!directories.has(parts.slice(0, n).join('/'))) fail('INVALID_MANIFEST')
  }
  const exclusions: string[] = []
  for (const value of raw.exclusions) {
    if (!safeRelative(value) || !isDependencyPath(value) || exclusions.includes(value)
      || seen.has(value.normalize('NFC').toLocaleLowerCase('en-US')) || entries.some(entry => entry.path.startsWith(value + '/'))) fail('INVALID_MANIFEST')
    exclusions.push(value)
  }
  return { schemaVersion: 1, format: 'dsh-tavern-directory-backup', scope: 'dsh-home-data-without-installed-dependencies',
    createdAt: raw.createdAt, versionSource: 'backup-runtime', versions: raw.versions as BackupManifest['versions'], exclusions: exclusions.sort(),
    entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
}
function report(operation: BackupReport['operation'], manifest: BackupManifest, offlineDeclared: boolean, issues: DoctorIssue[]): BackupReport {
  return { schemaVersion: 1, ok: true, operation, code: 'OK',
    files: manifest.entries.filter(entry => entry.kind === 'file').length,
    directories: manifest.entries.filter(entry => entry.kind === 'directory').length,
    bytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    excludedDependencyDirectories: manifest.exclusions.length, dependenciesNeedReinstall: manifest.exclusions.length > 0,
    offlineDeclared, offlineVerified: false, issues }
}
async function inspect(home: string, entries: BackupEntry[]): Promise<{ versions: BackupManifest['versions']; issues: DoctorIssue[] }> {
  // 迁移中断可能已发布不完整会话；整库备份不能把这个恢复中间态报告为可用快照。
  const incompleteImportCount = entries.filter(entry => entry.kind === 'file' && /^dsh-tavern\/session-imports\/[a-f0-9]{64}\.json$/i.test(entry.path)).length
  if (incompleteImportCount > 0) {
    fail('SESSION_IMPORT_INCOMPLETE', [{ code: 'SESSION_IMPORT_INCOMPLETE', severity: 'error', count: incompleteImportCount }])
  }
  const doctor = await runDoctor({ home })
  const issues = doctor.issues
  // 节点/安装版本由清单记录；结构失败、回滚恢复中或检查预算不足不能伪装为完整验证。
  const structural = issues.filter(issue => !/^(?:NODE_|PLUGIN_|DSH_)/.test(issue.code))
  if (structural.some(issue => issue.code === 'SESSION_IMPORT_INCOMPLETE')) fail('SESSION_IMPORT_INCOMPLETE', structural)
  if (structural.some(issue => issue.code === 'WAL_RECOVERY_IN_PROGRESS')) fail('WAL_RECOVERY_IN_PROGRESS', structural)
  if (structural.some(issue => issue.severity === 'error')) fail('STRUCTURE_INVALID', structural)
  if (doctor.statistics.files.scanTruncated || doctor.statistics.characters.uninspected || doctor.statistics.stories.uninspected
    || doctor.statistics.wal.uninspected || doctor.statistics.files.oversizedJson) fail('STRUCTURE_CHECK_INCOMPLETE', structural)
  return { versions: { node: doctor.runtime.nodeVersion, plugin: doctor.runtime.pluginVersion,
    dsh: doctor.runtime.dsh.installedVersion, expectedDsh: doctor.runtime.dsh.expectedVersion }, issues }
}
/** *.lock 的 PID 来自宿主 atomic-write 约定；session.lock 属于内核锁，存在本身不能推断运行。 */
async function checkActivity(home: string, entries: BackupEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.path.endsWith('.lock') || basename(entry.path) === 'session.lock' || entry.size > 32) continue
    let value: unknown
    try { value = await boundedJson(checkedPath(home, entry.path), 32) }
    catch (error) { if (error instanceof BackupError && error.code === 'INVALID_JSON') continue; throw error }
    const pid = typeof value === 'number' ? value : NaN
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) continue
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; fail('HOST_ACTIVITY_DETECTED') }
    fail('HOST_ACTIVITY_DETECTED')
  }
}
async function compare(home: string, expected: BackupEntry[], exclusions?: string[]): Promise<ScannedEntry[]> {
  const observedExclusions: string[] = []
  const actual = await inventory(home, exclusions ? observedExclusions : undefined)
  if (exclusions && JSON.stringify([...exclusions].sort()) !== JSON.stringify(observedExclusions.sort())) fail('SOURCE_CHANGED')
  if (actual.length !== expected.length) fail('INVENTORY_MISMATCH')
  const aboveHome = ancestorChainAbove(home)
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!, b = expected[i]!
    if (a.path !== b.path || a.kind !== b.kind || a.size !== b.size || (process.platform !== 'win32' && a.mode !== b.mode)) fail('INVENTORY_MISMATCH')
    if (exclusions && a.hardlinkGroup !== b.hardlinkGroup) fail('SOURCE_CHANGED')
    if (a.kind === 'file' && await transferFile(home, b, undefined, aboveHome, { expectedNlink: a.expectedNlink }) !== b.sha256) fail('HASH_MISMATCH')
  }
  await assertDirectory(home)
  return actual
}
async function copy(home: string, target: string, entries: ReadonlyArray<BackupEntry | ScannedEntry>, sourceNlinks?: ReadonlyMap<string, number>): Promise<BackupEntry[]> {
  await assertDirectory(home)
  const aboveHome = ancestorChainAbove(home)
  await createDirectories(target, entries as BackupEntry[])
  const result: BackupEntry[] = []
  const hardlinkLeaders = new Map<number, { destPath: string; sha256: string; mode: number }>()
  for (const entry of entries) {
    const { path, kind, size, mode, hardlinkGroup } = entry
    if (kind === 'directory') {
      result.push({ path, kind, size, mode })
      continue
    }
    const expectedNlink = 'expectedNlink' in entry ? entry.expectedNlink : (sourceNlinks?.get(path) ?? 1)
    const destPath = checkedPath(target, path)
    if (hardlinkGroup !== undefined) {
      const leader = hardlinkLeaders.get(hardlinkGroup)
      if (!leader) {
        const sha256 = await transferFile(home, entry, destPath, aboveHome, { expectedNlink, deferChmod: true })
        hardlinkLeaders.set(hardlinkGroup, { destPath, sha256, mode })
        result.push({ path, kind, size, mode, sha256, hardlinkGroup })
      } else {
        const sha256 = await transferFile(home, entry, undefined, aboveHome, { expectedNlink })
        if (sha256 !== leader.sha256) fail('HASH_MISMATCH')
        await link(leader.destPath, destPath)
        result.push({ path, kind, size, mode, sha256, hardlinkGroup })
      }
    } else {
      const sha256 = await transferFile(home, entry, destPath, aboveHome, { expectedNlink })
      result.push({ path, kind, size, mode, sha256 })
    }
  }
  await assertDirectory(home)
  for (const leader of hardlinkLeaders.values()) await chmod(leader.destPath, leader.mode)
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'directory') continue
    // POSIX 上缺少属主 r-x 的目录（如旧版 Windows 清单里的 0o666）会导致后续校验 EACCES 且无法遍历，先明确拒绝。
    if (process.platform !== 'win32' && (entry.mode & 0o500) !== 0o500) fail('INVALID_MANIFEST')
    await chmod(checkedPath(target, entry.path), entry.mode)
  }
  return result
}
async function assertParentDirectory(target: string): Promise<void> {
  try { await assertDirectory(dirname(target)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') fail('PARENT_DIRECTORY_MISSING')
    throw error
  }
}
async function stage(target: string, action: (temporary: string) => Promise<void>, hooks?: BackupHooks): Promise<void> {
  await assertParentDirectory(target); await assertAbsent(target)
  const temporary = join(dirname(target), `.tavern-backup-${randomUUID()}`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    await action(temporary)
    await hooks?.beforePublish?.()
    await assertParentDirectory(target); await assertAbsent(target)
    await renameWithRetry(temporary, target)
  } finally {
    // 唯一生成的同级临时目录；只删除已确认不是链接且仍位于原父目录的目录。
    if (dirname(resolve(temporary)) !== dirname(resolve(target))) fail('UNSAFE_CLEANUP')
    await assertDirectory(dirname(temporary))
    const info = await lstat(temporary).catch(() => null)
    if (info) { if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_CLEANUP'); await discardTemporary(temporary) }
  }
}
async function readBackup(backup: string): Promise<{ manifest: BackupManifest; issues: DoctorIssue[]; actual: ScannedEntry[] }> {
  await assertDirectory(backup)
  if (JSON.stringify((await readdir(backup)).sort()) !== JSON.stringify(['data', 'manifest.json'])) fail('BACKUP_CONTENTS_INVALID')
  const manifest = parseBackupManifest(await boundedJson(join(backup, 'manifest.json')))
  const actual = await compare(join(backup, 'data'), manifest.entries)
  const { issues } = await inspect(join(backup, 'data'), manifest.entries)
  return { manifest, issues, actual }
}
export async function createBackup(options: { home: string; backup: string; offline: boolean; hooks?: BackupHooks }): Promise<BackupReport> {
  if (!options.offline) fail('OFFLINE_DECLARATION_REQUIRED')
  if (!options.home || !options.backup) fail('EXPLICIT_PATH_REQUIRED')
  const home = resolve(options.home), backup = resolve(options.backup)
  assertSeparate(home, backup)
  const exclusions: string[] = []
  const entries = await inventory(home, exclusions)
  await checkActivity(home, entries)
  const inspected = await inspect(home, entries)
  let manifest: BackupManifest | undefined
  await stage(backup, async temporary => {
    const data = join(temporary, 'data'); await mkdir(data, { mode: 0o700 })
    const saved = await copy(home, data, entries)
    manifest = { schemaVersion: 1, format: 'dsh-tavern-directory-backup', scope: 'dsh-home-data-without-installed-dependencies',
      createdAt: new Date().toISOString(), versionSource: 'backup-runtime', versions: inspected.versions, exclusions: exclusions.sort(), entries: saved }
    await options.hooks?.afterCopy?.()
    await compare(home, saved, exclusions); await checkActivity(home, entries)
    const file = await open(join(temporary, 'manifest.json'), 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await readBackup(temporary)
  }, options.hooks)
  return report('create', manifest!, true, inspected.issues)
}
export async function verifyBackup(options: { backup: string }): Promise<BackupReport> {
  if (!options.backup) fail('EXPLICIT_PATH_REQUIRED')
  const { manifest, issues } = await readBackup(resolve(options.backup))
  return report('verify', manifest, false, issues)
}
async function verifyBackupUnchanged(backup: string, expected: BackupManifest): Promise<void> {
  await assertDirectory(backup)
  if (JSON.stringify((await readdir(backup)).sort()) !== JSON.stringify(['data', 'manifest.json'])) fail('BACKUP_CONTENTS_INVALID')
  const manifest = parseBackupManifest(await boundedJson(join(backup, 'manifest.json')))
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) fail('SOURCE_CHANGED')
  await compare(join(backup, 'data'), manifest.entries)
}
export async function restoreBackup(options: { backup: string; target: string; offline: boolean; hooks?: BackupHooks }): Promise<BackupReport> {
  if (!options.offline) fail('OFFLINE_DECLARATION_REQUIRED')
  if (!options.backup || !options.target) fail('EXPLICIT_PATH_REQUIRED')
  const backup = resolve(options.backup), target = resolve(options.target)
  assertSeparate(backup, target)
  await assertParentDirectory(target)
  await assertAbsent(target)
  const { manifest, issues, actual } = await readBackup(backup)
  const sourceNlinks = new Map(actual.map(entry => [entry.path, entry.expectedNlink]))
  await stage(target, async temporary => {
    const copied = await copy(join(backup, 'data'), temporary, manifest.entries, sourceNlinks)
    if (JSON.stringify(copied) !== JSON.stringify(manifest.entries)) fail('HASH_MISMATCH')
    await options.hooks?.afterCopy?.()
    await compare(temporary, manifest.entries)
    await inspect(temporary, manifest.entries)
    await verifyBackupUnchanged(backup, manifest)
  }, options.hooks)
  return report('restore', manifest, true, issues)
}
export { BackupError }
