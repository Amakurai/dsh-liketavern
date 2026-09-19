/** 用户数据离线快照与恢复：清单校验后发布新目录；依赖安装树明确排除，宿主历史与插件状态一起保存。 */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { runDoctor, type DoctorIssue } from '../doctor.js'
import { parseSessionBinding } from './bindings.js'
import { BACKUP_LIMITS, BackupError, assertAbsent, assertDirectory, assertSeparate, boundedJson, checkedPath,
  createDirectories, discardTemporary, fail, inventory, isDependencyPath, safeRelative, transferFile, type BackupEntry } from './backupFiles.js'

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
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function version(value: unknown): value is string { return typeof value === 'string' && /^(?:unknown|\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.test(value) }

export function parseBackupManifest(raw: unknown): BackupManifest {
  if (!object(raw) || raw.schemaVersion !== 1 || raw.format !== 'dsh-tavern-directory-backup'
    || raw.scope !== 'dsh-home-data-without-installed-dependencies' || raw.versionSource !== 'backup-runtime' || typeof raw.createdAt !== 'string'
    || !Number.isFinite(Date.parse(raw.createdAt)) || !object(raw.versions)
    || !['node', 'plugin', 'dsh', 'expectedDsh'].every(key => version((raw.versions as Record<string, unknown>)[key]))
    || !Array.isArray(raw.entries) || raw.entries.length > BACKUP_LIMITS.entries || !Array.isArray(raw.exclusions)) fail('INVALID_MANIFEST')
  const entries: BackupEntry[] = []
  const seen = new Set<string>()
  const directories = new Set<string>()
  let total = 0
  let pathBytes = 0
  for (const value of raw.entries) {
    if (!object(value) || !safeRelative(value.path) || (value.kind !== 'file' && value.kind !== 'directory')
      || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > BACKUP_LIMITS.fileBytes
      || typeof value.mode !== 'number' || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777
      || (value.kind === 'directory' && (value.size !== 0 || value.sha256 !== undefined))
      || (value.kind === 'file' && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))) fail('INVALID_MANIFEST')
    const key = value.path.normalize('NFC').toLocaleLowerCase('en-US')
    pathBytes += Buffer.byteLength(value.path)
    if (pathBytes > BACKUP_LIMITS.pathBytes) fail('METADATA_LIMIT')
    if (seen.has(key)) fail('PATH_COLLISION')
    seen.add(key)
    if (value.kind === 'directory') directories.add(value.path)
    total += value.size
    if (total > BACKUP_LIMITS.totalBytes) fail('SIZE_LIMIT')
    entries.push({ path: value.path, kind: value.kind, size: value.size, mode: value.mode,
      ...(value.kind === 'file' ? { sha256: value.sha256 as string } : {}) })
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
/** 所有引用只通过已经扫描且有界的清单定位；不让 JSON 中的 ID 参与任意文件读取。 */
async function references(home: string, entries: BackupEntry[]): Promise<DoctorIssue[]> {
  const files = new Map(entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]))
  const paths = new Set(files.keys())
  const issues = new Map<string, DoctorIssue>()
  const add = (code: string) => { const found = issues.get(code); if (found) found.count++; else issues.set(code, { code, severity: 'error', count: 1 }) }
  let budget = 64 * 1024 ** 2
  for (const entry of entries) {
    if (entry.kind !== 'file' || !/^dsh-tavern\/sessions\/[^/]+\.json$/.test(entry.path)) continue
    budget -= entry.size
    if (budget < 0) fail('REFERENCE_CHECK_LIMIT')
    let binding: ReturnType<typeof parseSessionBinding>
    try { binding = parseSessionBinding(await boundedJson(checkedPath(home, entry.path), 1024 * 1024)) }
    catch { add('BINDING_INVALID'); continue }
    const expected = `dsh-tavern/sessions/${binding.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
    if (expected !== entry.path) add('BINDING_IDENTITY_INVALID')
    const card = `dsh-tavern/characters/${binding.cardId}`
    if (!paths.has(`${card}/card.json`)) add('BINDING_CARD_MISSING')
    if (binding.storyId) {
      const story = `${card}/stories/${binding.storyId}/story.json`
      if (!paths.has(story)) add('BINDING_STORY_MISSING')
      else {
        budget -= files.get(story)!.size
        if (budget < 0) fail('REFERENCE_CHECK_LIMIT')
        const metadata = await boundedJson(checkedPath(home, story), 1024 * 1024)
        if (!object(metadata) || metadata.sessionId !== binding.sessionId) add('BINDING_STORY_IDENTITY_INVALID')
      }
    }
    for (const [id, directory] of [[binding.presetId, 'library/presets'], [binding.personaId, 'personas'],
      ...[...binding.lorebookIds, ...(binding.characterLorebookIds ?? []), binding.characterLorebookId].map(id => [id, 'library/lorebooks'])] as Array<[string | null, string]>) {
      if (id && !paths.has(`dsh-tavern/${directory}/${id.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_')}.json`)) add('BINDING_ASSET_MISSING')
    }
  }
  return [...issues.values()]
}
async function inspect(home: string, entries: BackupEntry[]): Promise<{ versions: BackupManifest['versions']; issues: DoctorIssue[] }> {
  const doctor = await runDoctor({ home })
  const issues = [...doctor.issues, ...await references(home, entries)]
  // 节点/安装版本由清单记录；结构失败或检查预算不足不能伪装为完整验证。
  const structural = issues.filter(issue => !/^(?:NODE_|PLUGIN_|DSH_)/.test(issue.code))
  if (structural.some(issue => issue.severity === 'error')) fail('STRUCTURE_INVALID')
  if (doctor.statistics.files.scanTruncated || doctor.statistics.characters.uninspected || doctor.statistics.stories.uninspected
    || doctor.statistics.wal.uninspected || doctor.statistics.files.oversizedJson) fail('STRUCTURE_CHECK_INCOMPLETE')
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
async function compare(home: string, expected: BackupEntry[], exclusions?: string[]): Promise<void> {
  const observedExclusions: string[] = []
  const actual = await inventory(home, exclusions ? observedExclusions : undefined)
  if (exclusions && JSON.stringify([...exclusions].sort()) !== JSON.stringify(observedExclusions.sort())) fail('SOURCE_CHANGED')
  if (actual.length !== expected.length) fail('INVENTORY_MISMATCH')
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!, b = expected[i]!
    if (a.path !== b.path || a.kind !== b.kind || a.size !== b.size || (process.platform !== 'win32' && a.mode !== b.mode)) fail('INVENTORY_MISMATCH')
    if (a.kind === 'file' && await transferFile(home, b) !== b.sha256) fail('HASH_MISMATCH')
  }
}
async function copy(home: string, target: string, entries: BackupEntry[]): Promise<BackupEntry[]> {
  await createDirectories(target, entries)
  const result: BackupEntry[] = []
  for (const entry of entries) {
    const { path, kind, size, mode } = entry
    result.push({ path, kind, size, mode, ...(kind === 'file' ? { sha256: await transferFile(home, entry, checkedPath(target, path)) } : {}) })
  }
  for (const entry of [...entries].reverse()) if (entry.kind === 'directory') await chmod(checkedPath(target, entry.path), entry.mode)
  return result
}
async function stage(target: string, action: (temporary: string) => Promise<void>, hooks?: BackupHooks): Promise<void> {
  await assertDirectory(dirname(target)); await assertAbsent(target)
  const temporary = join(dirname(target), `.tavern-backup-${randomUUID()}`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    await action(temporary)
    await hooks?.beforePublish?.()
    await assertDirectory(dirname(target)); await assertAbsent(target)
    await rename(temporary, target)
  } finally {
    // 唯一生成的同级临时目录；只删除已确认不是链接且仍位于原父目录的目录。
    if (dirname(resolve(temporary)) !== dirname(resolve(target))) fail('UNSAFE_CLEANUP')
    await assertDirectory(dirname(temporary))
    const info = await lstat(temporary).catch(() => null)
    if (info) { if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_CLEANUP'); await discardTemporary(temporary) }
  }
}
async function readBackup(backup: string): Promise<{ manifest: BackupManifest; issues: DoctorIssue[] }> {
  await assertDirectory(backup)
  if (JSON.stringify((await readdir(backup)).sort()) !== JSON.stringify(['data', 'manifest.json'])) fail('BACKUP_CONTENTS_INVALID')
  const manifest = parseBackupManifest(await boundedJson(join(backup, 'manifest.json')))
  await compare(join(backup, 'data'), manifest.entries)
  const { issues } = await inspect(join(backup, 'data'), manifest.entries)
  return { manifest, issues }
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
export async function restoreBackup(options: { backup: string; target: string; offline: boolean; hooks?: BackupHooks }): Promise<BackupReport> {
  if (!options.offline) fail('OFFLINE_DECLARATION_REQUIRED')
  if (!options.backup || !options.target) fail('EXPLICIT_PATH_REQUIRED')
  const backup = resolve(options.backup), target = resolve(options.target)
  assertSeparate(backup, target)
  await assertAbsent(target)
  const { manifest, issues } = await readBackup(backup)
  await stage(target, async temporary => {
    const copied = await copy(join(backup, 'data'), temporary, manifest.entries)
    if (JSON.stringify(copied) !== JSON.stringify(manifest.entries)) fail('HASH_MISMATCH')
    await options.hooks?.afterCopy?.()
    await compare(temporary, manifest.entries)
    await inspect(temporary, manifest.entries)
    await readBackup(backup)
  }, options.hooks)
  return report('restore', manifest, true, issues)
}
export { BackupError }
