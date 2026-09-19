/**
 * 只读 doctor 回归：覆盖未初始化目录、真实角色/剧情/WAL、损坏聚合、隐私输出与
 * 无修复副作用与扫描入口链接拒绝。测试数据全部由工厂生成，不读取真实 DSH_HOME。
 */
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { areDshVersionsCompatible, doctorMain, formatDoctorText, parseDoctorArguments, runDoctor } from '../src/doctor.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'tavern-doctor-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function makeStandardDirectories(): Promise<string> {
  const root = join(home, 'dsh-tavern')
  await Promise.all([
    'characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions',
  ].map(path => mkdir(join(root, path), { recursive: true })))
  return root
}

describe('doctor 聚合报告', () => {
  it('未初始化数据根是安全的空状态，不会创建插件目录', async () => {
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7' })
    expect(report.ok).toBe(true)
    expect(report.storage).toMatchObject({
      home: '$DSH_HOME',
      dataRoot: '$DSH_HOME/dsh-tavern',
      homeStatus: 'directory',
      dataRootStatus: 'missing',
    })
    expect(report.statistics.files.total).toBe(0)
    expect(report.issues).toContainEqual({ code: 'DATA_ROOT_NOT_INITIALIZED', severity: 'info', count: 1 })
    expect(await readdir(home)).toEqual([])
  })

  it('复用剧情和 WAL 校验器，但报告与文本不泄露任何身份、正文或绝对路径', async () => {
    const root = await makeStandardDirectories()
    const cardId = 'private-card-a1b2c3d4'
    const cardRoot = join(root, 'characters', cardId)
    const storyId = 'story-00000000-0000-4000-8000-000000000000'
    const story = join(cardRoot, 'stories', storyId)
    const secretName = '绝密角色名称'
    const secretBody = '不可出现在诊断里的正文与 secret-token-123'
    const secretSession = 'private-session-id'
    const secretFloor = `${secretSession}#t1`
    await mkdir(story, { recursive: true })
    await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: secretName, description: secretBody }))
    await writeFile(join(cardRoot, '.archive.json'), JSON.stringify({ version: 1, archivedAt: new Date(0).toISOString() }))
    await writeFile(join(story, 'story.json'), JSON.stringify({
      version: 1, id: storyId, sessionId: secretSession, createdAt: new Date(0).toISOString(), migrated: false,
    }))
    const wal = new Wal(join(story, 'state/wal'))
    const fs = new WorkspaceFs(story, wal)
    await wal.beginFloor(secretFloor)
    await fs.withFloor(secretFloor).writeText('journal.md', secretBody)
    await wal.commitFloor(secretFloor)

    const report = await runDoctor({ home, nodeVersion: '24.1.0', pluginVersion: '9.8.7' })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 1, unhealthy: 0, archived: 1 })
    expect(report.statistics.stories).toMatchObject({ directories: 1, healthy: 1, unhealthy: 0 })
    expect(report.statistics.wal).toMatchObject({ roots: 1, floors: 1, active: 1, healthy: 1, committed: 1 })

    const outputs = [JSON.stringify(report), formatDoctorText(report)]
    for (const output of outputs) {
      expect(output).not.toContain(home)
      expect(output).not.toContain(cardId)
      expect(output).not.toContain(storyId)
      expect(output).not.toContain(secretSession)
      expect(output).not.toContain(secretFloor)
      expect(output).not.toContain(secretName)
      expect(output).not.toContain(secretBody)
      expect(output).not.toContain('secret-token-123')
    }
  })

  it('坏 JSON、非法角色目录与损坏 WAL 只汇总固定错误码', async () => {
    const root = await makeStandardDirectories()
    const cardId = 'broken-card-a1b2c3d4'
    const cardRoot = join(root, 'characters', cardId)
    const storyId = 'story-11111111-1111-4111-8111-111111111111'
    const story = join(cardRoot, 'stories', storyId)
    await mkdir(story, { recursive: true })
    await mkdir(join(root, 'characters', 'invalid id'), { recursive: true })
    await writeFile(join(cardRoot, 'card.json'), '{private broken card body')
    await writeFile(join(story, 'story.json'), JSON.stringify({
      version: 1, id: storyId, sessionId: 'hidden-session', createdAt: new Date(0).toISOString(), migrated: false,
    }))
    const wal = new Wal(join(story, 'state/wal'))
    await wal.beginFloor('hidden-session#t1')
    await wal.commitFloor('hidden-session#t1')
    await appendFile(join(story, 'state/wal/hidden-session_t1/records.jsonl'), '{private broken wal body\n')

    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7' })
    expect(report.ok).toBe(false)
    expect(report.statistics.files.invalidJson).toBe(1)
    expect(report.statistics.characters).toMatchObject({ directories: 2, healthy: 0, unhealthy: 2, invalidIds: 1 })
    expect(report.statistics.stories).toMatchObject({ directories: 1, healthy: 1, unhealthy: 0 })
    expect(report.statistics.wal).toMatchObject({ floors: 1, healthy: 0, unhealthy: 1 })
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'CHARACTER_ID_INVALID', 'CHARACTER_METADATA_INVALID', 'JSON_SYNTAX_INVALID', 'WAL_INVALID',
    ]))
    expect(JSON.stringify(report)).not.toContain('private broken')
    expect(JSON.stringify(report)).not.toContain('hidden-session')
  })

  it('缺失标准目录只告警且诊断前后目录结构和修改时间不变', async () => {
    const root = join(home, 'dsh-tavern')
    await mkdir(root)
    const before = await stat(root)
    const beforeEntries = await readdir(root)
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7' })
    const after = await stat(root)
    expect(report.ok).toBe(true)
    expect(report.issues).toContainEqual({ code: 'STANDARD_DIRECTORY_MISSING', severity: 'warning', count: 6 })
    expect(await readdir(root)).toEqual(beforeEntries)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('DSH home 本身为链接时不跟随扫描目标数据', async () => {
    const target = join(home, 'linked-target')
    const linkedHome = join(home, 'linked-home')
    const secret = '链接目标中的私密角色'
    await mkdir(join(target, 'dsh-tavern', 'characters', 'linked-card-a1b2c3d4'), { recursive: true })
    await writeFile(join(target, 'dsh-tavern', 'characters', 'linked-card-a1b2c3d4', 'card.json'), JSON.stringify({ name: secret }))
    try {
      await symlink(target, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return
      throw error
    }

    const report = await runDoctor({ home: linkedHome, nodeVersion: '24.0.0', pluginVersion: '9.8.7',
      dshInstalledVersion: '0.1.5-rc.2', dshExpectedVersion: '0.1.5-rc.2' })
    expect(report.ok).toBe(false)
    expect(report.storage).toMatchObject({ homeStatus: 'link', dataRootStatus: 'link' })
    expect(report.statistics.characters.directories).toBe(0)
    expect(report.statistics.files.total).toBe(0)
    expect(report.issues).toContainEqual({ code: 'DATA_ROOT_LINK_SKIPPED', severity: 'error', count: 1 })
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('JSON 形状正确但 archivedAt 日期无效的收纳标记仍报告损坏', async () => {
    const root = await makeStandardDirectories()
    const cardRoot = join(root, 'characters', 'bad-archive-date-a1b2c3d4')
    await mkdir(cardRoot)
    await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: '不应输出的角色' }))
    await writeFile(join(cardRoot, '.archive.json'), JSON.stringify({ version: 1, archivedAt: 'not-a-date' }))
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7',
      dshInstalledVersion: '0.1.5-rc.2', dshExpectedVersion: '0.1.5-rc.2' })
    expect(report.ok).toBe(false)
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 0, unhealthy: 1, archived: 0 })
    expect(report.issues).toContainEqual({ code: 'CHARACTER_ARCHIVE_MARKER_INVALID', severity: 'error', count: 1 })
    expect(JSON.stringify(report)).not.toContain('not-a-date')
    expect(JSON.stringify(report)).not.toContain('不应输出的角色')
  })

  it('WAL 的中间 state 目录为链接时，不检查链接目标中的事务', async () => {
    const root = await makeStandardDirectories()
    const cardRoot = join(root, 'characters', 'linked-state-a1b2c3d4')
    const target = join(home, 'external-state')
    await mkdir(cardRoot)
    await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: '私密角色' }))
    const wal = new Wal(join(target, 'wal'))
    await wal.beginFloor('external-session#t1')
    await wal.commitFloor('external-session#t1')
    try {
      await symlink(target, join(cardRoot, 'state'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }

    const report = await runDoctor({ home, nodeVersion: '24.0.0' })
    expect(report.ok).toBe(false)
    expect(report.statistics.wal).toMatchObject({ roots: 0, floors: 0, unsafeEntries: 1 })
    expect(report.issues).toContainEqual({ code: 'WAL_LINK_SKIPPED', severity: 'error', count: 1 })
    expect(JSON.stringify(report)).not.toContain('external-session')
  })

  it('library 中间目录为链接时，预设和世界书目录均标记跳过', async () => {
    const root = join(home, 'dsh-tavern')
    const target = join(home, 'external-library')
    await mkdir(root)
    await mkdir(join(target, 'presets'), { recursive: true })
    await mkdir(join(target, 'lorebooks'))
    await writeFile(join(target, 'presets', 'private.json'), '{broken external data')
    try {
      await symlink(target, join(root, 'library'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }

    const report = await runDoctor({ home, nodeVersion: '24.0.0' })
    expect(report.ok).toBe(false)
    expect(report.storage.directories).toMatchObject({ presets: 'link', lorebooks: 'link' })
    expect(report.statistics.files).toMatchObject({ total: 0, invalidJson: 0, skippedLinks: 1 })
    expect(report.issues).toContainEqual({ code: 'STANDARD_DIRECTORY_INVALID', severity: 'error', count: 2 })
  })

  it('超出单文件上限的 JSON 只按大小计数，不读取正文', async () => {
    const root = await makeStandardDirectories()
    const oversized = join(root, 'personas', 'private-oversized.json')
    await writeFile(oversized, '')
    await truncate(oversized, 16 * 1024 * 1024 + 1)
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7',
      dshInstalledVersion: '0.1.5-rc.2', dshExpectedVersion: '0.1.5-rc.2' })
    expect(report.ok).toBe(true)
    expect(report.statistics.files).toMatchObject({ total: 1, json: 1, oversizedJson: 1, invalidJson: 0 })
    expect(report.issues).toContainEqual({ code: 'JSON_VALIDATION_LIMIT_EXCEEDED', severity: 'warning', count: 1 })
  })

  it('累计读取预算耗尽时停止扫描并用固定 warning 标记未检查角色', async () => {
    const root = await makeStandardDirectories()
    const cardRoot = join(root, 'characters', 'budget-card-a1b2c3d4')
    await mkdir(cardRoot)
    await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: '预算内不应回显', description: 'x'.repeat(256) }))
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7', readBudgetBytes: 32,
      dshInstalledVersion: '0.1.5-rc.2', dshExpectedVersion: '0.1.5-rc.2' })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 0, unhealthy: 0, uninspected: 1 })
    expect(report.statistics.files.scanTruncated).toBe(true)
    expect(report.issues).toContainEqual({ code: 'READ_BUDGET_EXCEEDED', severity: 'warning', count: 1 })
    expect(JSON.stringify(report)).not.toContain('预算内不应回显')
  })

  it('角色结构检查也遵守累计目录项上限，不等待读取正文才限制扫描', async () => {
    const root = await makeStandardDirectories()
    for (let index = 0; index < 3; index++) {
      const cardRoot = join(root, 'characters', `bounded-card-${index}`)
      await mkdir(cardRoot)
      await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: '有界角色' }))
    }
    const report = await runDoctor({ home, nodeVersion: '24.0.0', scanEntryLimit: 2 })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters).toMatchObject({ directories: 2, healthy: 2 })
    expect(report.statistics.files.scanTruncated).toBe(true)
    expect(report.issues).toContainEqual({ code: 'FILE_SCAN_LIMIT_REACHED', severity: 'warning', count: 1 })
    expect(report.issues.map(issue => issue.code)).not.toContain('READ_BUDGET_EXCEEDED')
  })

  it('角色和剧情检查共用目录项预算，不能在每个子目录重新获得额度', async () => {
    const root = await makeStandardDirectories()
    const cardRoot = join(root, 'characters', 'bounded-stories-a1b2c3d4')
    for (let index = 0; index < 3; index++) {
      const id = `story-00000000-0000-4000-8000-00000000000${index}`
      const story = join(cardRoot, 'stories', id)
      await mkdir(story, { recursive: true })
      await writeFile(join(story, 'story.json'), JSON.stringify({
        version: 1, id, sessionId: 'session', createdAt: new Date(0).toISOString(), migrated: false,
      }))
    }
    await writeFile(join(cardRoot, 'card.json'), JSON.stringify({ name: '有界角色' }))
    const report = await runDoctor({ home, nodeVersion: '24.0.0', scanEntryLimit: 2 })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 1 })
    expect(report.statistics.stories).toMatchObject({ directories: 1, healthy: 1 })
    expect(report.statistics.files.scanTruncated).toBe(true)
    expect(report.issues).toContainEqual({ code: 'FILE_SCAN_LIMIT_REACHED', severity: 'warning', count: 1 })
  })
})

describe('doctor CLI', () => {
  it('发布清单提供编译后可执行入口和可导入的诊断 API', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.bin).toMatchObject({ 'dsh-tavern-doctor': './lib/doctor.js' })
    expect(packageJson.exports['./doctor']).toEqual({ types: './lib/doctor.d.ts', default: './lib/doctor.js' })
    expect(packageJson.scripts.doctor).toBe('node lib/doctor.js')
    expect(packageJson.peerDependencies['@deepseek-ai/dsh']).toBe('0.1.5-rc.2')
  })

  it('只接受只读参数，未知修复参数直接拒绝', () => {
    expect(parseDoctorArguments(['--json', '--home', home])).toEqual({ json: true, help: false, version: false, home })
    expect(() => parseDoctorArguments(['--fix'])).toThrow('invalid arguments')
  })

  it('JSON CLI 使用健康状态决定退出码且不回显输入路径', async () => {
    const output: string[] = []
    const errors: string[] = []
    const code = await doctorMain(['--json', '--home', home], { out: text => output.push(text), err: text => errors.push(text) })
    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(JSON.parse(output.join(''))).toMatchObject({ schemaVersion: 1, ok: true })
    expect(output.join('')).not.toContain(home)
  })
})

describe('doctor 宿主版本', () => {
  it('异常 Node 版本也归一化，不能回显注入内容或因数字前缀误判兼容', async () => {
    const secret = '24.0.0\nprivate C:/runtime/secret'
    const report = await runDoctor({ home, nodeVersion: secret })
    expect(report.ok).toBe(false)
    expect(report.runtime).toMatchObject({ nodeVersion: 'unknown', nodeSupported: false })
    expect(report.issues).toContainEqual({ code: 'NODE_VERSION_UNSUPPORTED', severity: 'error', count: 1 })
    expect(JSON.stringify(report)).not.toContain('private')
    expect(formatDoctorText(report)).not.toContain('private')
  })

  it('精确匹配 peer 版本时报告兼容', async () => {
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7' })
    expect(report.runtime.dsh).toEqual({ installedVersion: '0.1.5-rc.2', expectedVersion: '0.1.5-rc.2', compatible: true })
    expect(areDshVersionsCompatible('0.1.5-rc.2+host', '0.1.5-rc.2+plugin')).toBe(true)
  })

  it('已安装版本不匹配时固定报错并影响健康状态', async () => {
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7',
      dshInstalledVersion: '0.1.5-rc.1', dshExpectedVersion: '0.1.5-rc.2' })
    expect(report.ok).toBe(false)
    expect(report.runtime.dsh).toEqual({ installedVersion: '0.1.5-rc.1', expectedVersion: '0.1.5-rc.2', compatible: false })
    expect(report.issues).toContainEqual({ code: 'DSH_VERSION_INCOMPATIBLE', severity: 'error', count: 1 })
  })

  it('无法安全解析的版本折叠为 unknown，不回显元数据内容', async () => {
    const secret = 'invalid-version-C:/private/host'
    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7',
      dshInstalledVersion: secret, dshExpectedVersion: secret })
    expect(report.ok).toBe(true)
    expect(report.runtime.dsh).toEqual({ installedVersion: 'unknown', expectedVersion: 'unknown', compatible: false })
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'DSH_EXPECTED_VERSION_UNKNOWN', 'DSH_INSTALLED_VERSION_UNKNOWN',
    ]))
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(formatDoctorText(report)).not.toContain(secret)
  })
})
