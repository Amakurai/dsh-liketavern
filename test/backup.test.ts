/** 离线备份真实文件系统演练：覆盖宿主与剧情/WAL、依赖链接排除、篡改、路径边界和发布失败的原子性。 */
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupMain, parseBackupArguments } from '../src/backup.js'
import { createBackup, parseBackupManifest, restoreBackup, verifyBackup } from '../src/node/backup.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let scratch: string, home: string, backup: string, target: string
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'tavern-backup-test-'))
  home = join(scratch, 'home'); backup = join(scratch, 'backup'); target = join(scratch, 'restored')
  await mkdir(home)
})
afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })
async function save(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value)) }
async function manifest(): Promise<Record<string, unknown>> { return JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')) as Record<string, unknown> }
async function create(): Promise<Awaited<ReturnType<typeof createBackup>>> { return createBackup({ home, backup, offline: true }) }
async function restore(): Promise<Awaited<ReturnType<typeof restoreBackup>>> { return restoreBackup({ backup, target, offline: true }) }

describe('完整用户数据快照', () => {
  it('恢复宿主配置、二进制历史附件、空目录、剧情绑定和有效 WAL；verify 只读且结果不含私人信息', async () => {
    const cardId = 'private-card-a1b2c3d4', storyId = 'story-00000000-0000-4000-8000-000000000000', sessionId = 'session-private'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true })
    await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await mkdir(join(home, 'host/history/empty'), { recursive: true })
    await writeFile(join(home, 'config.yml'), 'apiKey: top-secret-token\n')
    const binary = Buffer.from([0, 1, 2, 255, 128, 12])
    await writeFile(join(home, 'host/history/attachment.bin'), binary)
    await save(join(card, 'card.json'), { name: '秘密角色', description: 'private narrative' })
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId, createdAt: new Date(0).toISOString(), migrated: false })
    const binding = { sessionId, cardId, storyId, presetId: null, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() }
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), binding)
    const wal = new Wal(join(story, 'state/wal')), fs = new WorkspaceFs(story, wal)
    await wal.beginFloor(`${sessionId}#t1`); await fs.withFloor(`${sessionId}#t1`).writeText('journal.md', 'private narrative'); await wal.commitFloor(`${sessionId}#t1`)
    const created = await create()
    const before = await readFile(join(backup, 'manifest.json'))
    expect((await verifyBackup({ backup })).ok).toBe(true)
    expect(await readFile(join(backup, 'manifest.json'))).toEqual(before)
    expect((await restore()).ok).toBe(true)
    expect(await readFile(join(target, 'host/history/attachment.bin'))).toEqual(binary)
    expect(await readdir(join(target, 'host/history/empty'))).toEqual([])
    expect(await readFile(join(target, 'dsh-tavern/characters', cardId, 'stories', storyId, 'journal.md'), 'utf8')).toBe('private narrative')
    const restoredWal = new Wal(join(target, 'dsh-tavern/characters', cardId, 'stories', storyId, 'state/wal'))
    await restoredWal.rollbackAfter([`${sessionId}#t1`], join(target, 'dsh-tavern/characters', cardId, 'stories', storyId))
    const restoredFs = new WorkspaceFs(join(target, 'dsh-tavern/characters', cardId, 'stories', storyId), null)
    expect(await restoredFs.readText('journal.md')).toBeNull()
    const output = JSON.stringify(created)
    for (const secret of [home, cardId, storyId, sessionId, 'top-secret-token', 'private narrative', '秘密角色']) expect(output).not.toContain(secret)
    expect(created.offlineVerified).toBe(false)
  })

  it('普通宿主 fallback/junction 安装可备份，精确记录排除且保留安装清单和 patch', async () => {
    const installed = join(scratch, 'installed'); await mkdir(installed); await writeFile(join(installed, 'private-outside.txt'), 'outside')
    await mkdir(join(home, 'profiles/web/.dsh-module-fallback'), { recursive: true })
    for (const relative of ['profiles/node_modules', 'profiles/web/node_modules', 'profiles/web/.dsh-module-fallback/node_modules']) {
      await symlink(installed, join(home, relative), process.platform === 'win32' ? 'junction' : 'dir')
    }
    await save(join(home, 'profiles/web/package.json'), { dependencies: { 'dsh-liketavern': '0.2.5' } })
    await writeFile(join(home, 'profiles/web/pnpm-lock.yaml'), 'lockfileVersion: 9')
    await writeFile(join(home, 'profiles/web/cordis.yml'), 'plugins: []')
    const result = await create()
    expect(result).toMatchObject({ dependenciesNeedReinstall: true, excludedDependencyDirectories: 3 })
    const data = await manifest()
    expect(data.exclusions).toHaveLength(3)
    expect(JSON.stringify(data)).not.toContain('private-outside')
    await restore()
    expect(await readFile(join(target, 'profiles/web/pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9')
    expect(await readdir(join(target, 'profiles/web'))).not.toContain('node_modules')
  })

  it('记录每文件 SHA256/大小和工具/宿主版本，支持跨多个读取块', async () => {
    const body = Buffer.alloc(400_000, 99); await writeFile(join(home, 'large.bin'), body)
    await create(); const data = parseBackupManifest(await manifest())
    expect(data.versions.plugin).toMatch(/^\d+\./)
    expect(data.versions.dsh).toBe('0.1.7-rc.2')
    expect(data.entries).toMatchObject([{ path: 'large.bin', kind: 'file', size: body.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    await restore(); expect(await readFile(join(target, 'large.bin'))).toEqual(body)
  })
})

describe('拒绝损坏与越界', () => {
  it.each(['../outside', '/absolute', 'C:/drive', 'a\\b', 'x/../y', 'file:stream', 'CON', 'trailing.', 'double//slash'])('拒绝清单中的非法路径 %s', async path => {
    await writeFile(join(home, 'safe'), 'safe'); await create()
    const data = await manifest(); (data.entries as Array<{ path: string }>)[0]!.path = path
    await save(join(backup, 'manifest.json'), data)
    await expect(restore()).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
    expect(await readdir(scratch)).not.toContain('restored')
  })
  it.each(['duplicate', 'case'])('拒绝重复及大小写清单碰撞 %s', async variant => {
    await writeFile(join(home, 'Safe'), 'safe'); await create()
    const data = await manifest(), entries = data.entries as Array<Record<string, unknown>>
    entries.push({ ...entries[0], path: variant === 'case' ? 'safe' : 'Safe' })
    await save(join(backup, 'manifest.json'), data)
    await expect(verifyBackup({ backup })).rejects.toMatchObject({ code: 'PATH_COLLISION' })
  })
  it.each(['missing', 'extra', 'changed', 'extra-root'])('拒绝缺文件、多文件、正文篡改或根多余文件 %s', async variant => {
    await writeFile(join(home, 'safe'), 'safe'); await create()
    if (variant === 'missing') await rm(join(backup, 'data/safe'))
    else if (variant === 'extra') await writeFile(join(backup, 'data/extra'), 'extra')
    else if (variant === 'extra-root') await writeFile(join(backup, 'extra'), 'extra')
    else await writeFile(join(backup, 'data/safe'), 'evil')
    await expect(restore()).rejects.toBeInstanceOf(Error)
    expect(await readdir(scratch)).not.toContain('restored')
  })
  it('拒绝资产目录链接与入口祖先链接；排除范围不能吞掉用户资产 node_modules', async () => {
    const outside = join(scratch, 'outside'); await mkdir(outside)
    await symlink(outside, join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(create()).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' })
    await rm(join(home, 'node_modules')); await mkdir(join(outside, 'nested'))
    const linked = join(scratch, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createBackup({ home: join(linked, 'nested'), backup, offline: true })).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' })
  })
  it('拒绝硬链接', async () => {
    const outside = join(scratch, 'outside'); await writeFile(outside, 'secret'); await link(outside, join(home, 'link'))
    await expect(create()).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' })
  })
  it('拒绝已有目标（包括空目录）及嵌套路径', async () => {
    await expect(createBackup({ home, backup: join(home, 'backup'), offline: true })).rejects.toMatchObject({ code: 'NESTED_PATHS' })
    await create(); await mkdir(target)
    await expect(restore()).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    await expect(restoreBackup({ backup, target: join(backup, 'restored'), offline: true })).rejects.toMatchObject({ code: 'NESTED_PATHS' })
    await expect(create()).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
  })
  it('拒绝缺失角色引用而非把有哈希当作可以恢复', async () => {
    await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(home, 'dsh-tavern/sessions/session-test.json'), { sessionId: 'session-test', cardId: 'missing-a1b2c3d4',
      presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    await expect(create()).rejects.toMatchObject({ code: 'STRUCTURE_INVALID' })
  })
  it.each(['story', 'identity', 'preset', 'persona', 'lorebook'])('拒绝缺失剧情/资产及串剧情绑定 %s', async kind => {
    const cardId = 'reference-a1b2c3d4', sessionId = 'session-ref', storyId = 'story-00000000-0000-4000-8000-000000000000'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true }); await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(card, 'card.json'), { name: 'test' })
    // 缺失剧情用另一个格式正确但不存在的 ID，避免仅靠 doctor 的元数据校验通过测试。
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId: kind === 'identity' ? 'another-session' : sessionId,
      createdAt: new Date(0).toISOString(), migrated: false })
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), { sessionId, cardId,
      storyId: kind === 'story' ? 'story-11111111-1111-4111-8111-111111111111' : storyId,
      presetId: kind === 'preset' ? 'missing' : null, personaId: kind === 'persona' ? 'missing' : null,
      lorebookIds: kind === 'lorebook' ? ['missing'] : [], characterLorebookId: null,
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    await expect(create()).rejects.toMatchObject({ code: 'STRUCTURE_INVALID' })
  })
  it('显式停机声明必需且活 PID 锁仍会阻断；session.lock 不是停机证据', async () => {
    await expect(createBackup({ home, backup, offline: false })).rejects.toMatchObject({ code: 'OFFLINE_DECLARATION_REQUIRED' })
    await writeFile(join(home, 'settings.lock'), `${process.pid}\n`)
    await expect(create()).rejects.toMatchObject({ code: 'HOST_ACTIVITY_DETECTED' })
    await rm(join(home, 'settings.lock')); await writeFile(join(home, 'session.lock'), '')
    expect((await create()).offlineVerified).toBe(false)
    await expect(restoreBackup({ backup, target, offline: false })).rejects.toMatchObject({ code: 'OFFLINE_DECLARATION_REQUIRED' })
  })
})

describe('失败原子性与 CLI', () => {
  it('复制后来源改变时不发布备份', async () => {
    await writeFile(join(home, 'safe'), 'safe')
    await expect(createBackup({ home, backup, offline: true, hooks: { afterCopy: async () => { await writeFile(join(home, 'safe'), 'evil') } } }))
      .rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    expect(await readdir(scratch)).toEqual(['home'])
  })
  it.each(['afterCopy', 'beforePublish'] as const)('恢复 %s 故障不出现半恢复目标并保留原备份', async hook => {
    await writeFile(join(home, 'safe'), 'safe'); await create()
    await expect(restoreBackup({ backup, target, offline: true, hooks: { [hook]: async () => { throw new Error('injected disk failure') } } })).rejects.toThrow('injected disk failure')
    expect((await readdir(scratch)).sort()).toEqual(['backup', 'home'])
    expect((await verifyBackup({ backup })).ok).toBe(true)
  })
  it.skipIf(process.platform === 'win32')('POSIX 只读目录复制后失败仍清理私密草稿', async () => {
    const readonly = join(home, 'readonly'); await mkdir(readonly); await writeFile(join(readonly, 'secret'), 'secret')
    await chmod(readonly, 0o555)
    try {
      await expect(createBackup({ home, backup, offline: true, hooks: { afterCopy: async () => { throw new Error('injected failure') } } })).rejects.toThrow('injected failure')
      expect(await readdir(scratch)).toEqual(['home'])
    } finally { await chmod(readonly, 0o700) }
  })
  it('发布前目标被占用时保留占用目录', async () => {
    await create()
    await expect(restoreBackup({ backup, target, offline: true, hooks: { beforePublish: async () => { await mkdir(target); await writeFile(join(target, 'keep'), 'keep') } } }))
      .rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('keep')
    expect((await readdir(scratch)).filter(name => name.startsWith('.tavern'))).toEqual([])
  })
  it('CLI 拒绝隐式 home/重复/多余参数；机器失败码不回显私密参数', async () => {
    expect(() => parseBackupArguments(['create', '--backup', backup, '--offline'])).toThrow()
    expect(() => parseBackupArguments(['verify', '--backup', backup, '--backup', backup])).toThrow()
    expect(() => parseBackupArguments(['verify', '--backup', backup, '--home', home])).toThrow()
    const output: string[] = [], io = { out: (text: string) => { output.push(text) }, err: (text: string) => { output.push(text) } }
    expect(await backupMain(['create', '--home', home, '--backup', backup, '--json'], io)).toBe(1)
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: false, code: 'OFFLINE_DECLARATION_REQUIRED' })
    expect(output.join('')).not.toContain(home)
    output.length = 0
    expect(await backupMain(['create', '--home', home, '--backup', backup, '--offline', '--json'], io)).toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: true, operation: 'create' })
  })
})
