/** 离线备份真实文件系统演练：覆盖宿主与剧情/WAL、封闭硬链接附件、依赖链接排除、篡改、路径边界和发布失败的原子性。 */
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
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
    const { devDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(data.versions.dsh).toBe(devDependencies['@deepseek-ai/dsh'])
    expect(data.entries).toMatchObject([{ path: 'large.bin', kind: 'file', size: body.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    await restore(); expect(await readFile(join(target, 'large.bin'))).toEqual(body)
  })
  it('支持同根封闭硬链接（含宿主 LocalAttachmentStore 文件附件）的备份、校验、恢复与清理', async () => {
    const ctx = new Context()
    try {
      const store = new LocalAttachmentStore(ctx, { dshHome: home })
      const savedFile = await store.saveFile({ name: '附件说明.txt', data: Buffer.from('硬链接附件正文') })
      await mkdir(join(home, 'shared'), { recursive: true })
      await writeFile(join(home, 'shared/a.bin'), 'shared-content')
      await link(join(home, 'shared/a.bin'), join(home, 'shared/b.bin'))
      await link(join(home, 'shared/a.bin'), join(home, 'shared/c.bin'))

      // 发布前注入失败，验证 discardTemporary 能安全清理含封闭硬链接的临时草稿。
      await expect(createBackup({ home, backup, offline: true, hooks: { beforePublish: async () => { throw new Error('abort-hardlink-stage') } } }))
        .rejects.toThrow('abort-hardlink-stage')
      expect(await readdir(scratch)).toEqual(['home'])

      const created = await create()
      expect(created.ok).toBe(true)
      const data = parseBackupManifest(await manifest())
      const sharedEntries = data.entries.filter(entry => entry.path.startsWith('shared/'))
      expect(sharedEntries).toHaveLength(3)
      expect(sharedEntries.every(entry => entry.hardlinkGroup !== undefined && entry.hardlinkGroup === sharedEntries[0]!.hardlinkGroup)).toBe(true)

      expect((await verifyBackup({ backup })).ok).toBe(true)
      expect((await restore()).ok).toBe(true)

      const restoredStatA = await stat(join(target, 'shared/a.bin'), { bigint: true })
      const restoredStatB = await stat(join(target, 'shared/b.bin'), { bigint: true })
      const restoredStatC = await stat(join(target, 'shared/c.bin'), { bigint: true })
      expect(restoredStatA.ino).toBe(restoredStatB.ino)
      expect(restoredStatA.ino).toBe(restoredStatC.ino)
      expect(restoredStatA.nlink).toBe(3n)

      const restoredCtx = new Context()
      try {
        const restoredStore = new LocalAttachmentStore(restoredCtx, { dshHome: target })
        const chunks: Uint8Array[] = []
        for await (const chunk of restoredStore.readFileStream(savedFile)) chunks.push(chunk)
        expect(Buffer.concat(chunks).toString('utf8')).toBe('硬链接附件正文')
      } finally { await restoredCtx.fiber.dispose() }

      // 备份目录被普通工具拆成独立副本（nlink=1）后，只要 SHA-256 一致仍可通过 verify，且篡改单份仍被拦截。
      await rm(join(backup, 'data/shared/b.bin'))
      await writeFile(join(backup, 'data/shared/b.bin'), 'shared-content')
      expect((await verifyBackup({ backup })).ok).toBe(true)
      await writeFile(join(backup, 'data/shared/b.bin'), 'tampered-bytes')
      await expect(verifyBackup({ backup })).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('拒绝损坏与越界', () => {
  it('会话迁移存在未完成回执时不能把中间状态备份为成功', async () => {
    await mkdir(join(home, 'dsh-tavern/session-imports'), { recursive: true })
    await writeFile(join(home, 'dsh-tavern/session-imports', `${'a'.repeat(64)}.json`), '{}')
    await expect(create()).rejects.toMatchObject({
      code: 'SESSION_IMPORT_INCOMPLETE',
      issues: expect.arrayContaining([{ code: 'SESSION_IMPORT_INCOMPLETE', severity: 'error', count: 1 }]),
    })
    expect(await readdir(scratch)).not.toContain('backup')
  })
  it('拦截中断中的 WAL 回滚态（wal-recovery.json 与活跃 rollback-progress.json）', async () => {
    const cardId = 'recover-card-a1b2c3d4', storyId = 'story-00000000-0000-4000-8000-000000000020', sessionId = 'session-rec'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true })
    await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(card, 'card.json'), { name: '恢复中角色' })
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId, createdAt: new Date(0).toISOString(), migrated: false })
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), { sessionId, cardId, storyId,
      presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const wal = new Wal(join(story, 'state/wal')), fs = new WorkspaceFs(story, wal)
    await wal.beginFloor(`${sessionId}#t1`)
    await fs.withFloor(`${sessionId}#t1`).writeText('a.txt', 'v1')
    await wal.commitFloor(`${sessionId}#t1`)

    // 1. 仅存在合法 wal-recovery.json 标记即应阻断备份。
    await save(join(story, 'state/wal-recovery.json'), { version: 1, floors: [`${sessionId}#t1`], dirs: [`${sessionId}_t1`] })
    await expect(create()).rejects.toMatchObject({
      code: 'WAL_RECOVERY_IN_PROGRESS',
      issues: expect.arrayContaining([{ code: 'WAL_RECOVERY_IN_PROGRESS', severity: 'warning', count: 1 }]),
    })

    // 2. 仅存在活跃楼层合法 rollback-progress.json 同样阻断备份。
    await rm(join(story, 'state/wal-recovery.json'))
    const floorDir = join(story, 'state/wal', `${sessionId}_t1`)
    const records = (await readFile(join(floorDir, 'records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    await save(join(floorDir, 'rollback-progress.json'), {
      hash, next: 0, restored: [], preserved: [],
      pending: { path: 'a.txt', from: Buffer.from('v1').toString('base64'), to: null },
    })
    await expect(create()).rejects.toMatchObject({
      code: 'WAL_RECOVERY_IN_PROGRESS',
      issues: expect.arrayContaining([{ code: 'WAL_RECOVERY_IN_PROGRESS', severity: 'warning', count: 1 }]),
    })
  })
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
  it('拒绝指向备份根外部或被排除 node_modules 的硬链接', async () => {
    const outside = join(scratch, 'outside'); await writeFile(outside, 'secret'); await link(outside, join(home, 'link'))
    await expect(create()).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' })
    await rm(join(home, 'link'))
    // 指向被排除依赖目录内部的硬链接因 nlink > 备份根内计数，也必须拒绝。
    await mkdir(join(home, 'profiles/web/node_modules'), { recursive: true })
    await writeFile(join(home, 'profiles/web/node_modules/pkg.txt'), 'dep')
    await link(join(home, 'profiles/web/node_modules/pkg.txt'), join(home, 'leaked.txt'))
    await expect(create()).rejects.toMatchObject({ code: 'LINK_NOT_ALLOWED' })
  })
  it('拒绝已有目标（包括空目录）、缺失父目录及嵌套路径', async () => {
    await expect(createBackup({ home, backup: join(home, 'backup'), offline: true })).rejects.toMatchObject({ code: 'NESTED_PATHS' })
    await expect(createBackup({ home, backup: join(scratch, 'missing-parent', 'backup'), offline: true })).rejects.toMatchObject({ code: 'PARENT_DIRECTORY_MISSING' })
    await create(); await mkdir(target)
    await expect(restore()).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    await expect(restoreBackup({ backup, target: join(scratch, 'missing-parent', 'restored'), offline: true })).rejects.toMatchObject({ code: 'PARENT_DIRECTORY_MISSING' })
    await expect(restoreBackup({ backup, target: join(backup, 'restored'), offline: true })).rejects.toMatchObject({ code: 'NESTED_PATHS' })
    await expect(create()).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
  })
  it('拒绝缺失角色引用而非把有哈希当作可以恢复，并在错误中附带脱敏明细', async () => {
    await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(home, 'dsh-tavern/sessions/session-test.json'), { sessionId: 'session-test', cardId: 'missing-a1b2c3d4',
      presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    await expect(create()).rejects.toMatchObject({
      code: 'STRUCTURE_INVALID',
      issues: expect.arrayContaining([{ code: 'BINDING_CARD_MISSING', severity: 'error', count: 1 }]),
    })
  })
  it.each(['story', 'identity'] as const)('拒绝缺失剧情及串剧情绑定 %s 并附带具体问题码', async kind => {
    const cardId = 'reference-a1b2c3d4', sessionId = 'session-ref', storyId = 'story-00000000-0000-4000-8000-000000000000'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true }); await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(card, 'card.json'), { name: 'test' })
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId: kind === 'identity' ? 'another-session' : sessionId,
      createdAt: new Date(0).toISOString(), migrated: false })
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), { sessionId, cardId,
      storyId: kind === 'story' ? 'story-11111111-1111-4111-8111-111111111111' : storyId,
      presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    await expect(create()).rejects.toMatchObject({
      code: 'STRUCTURE_INVALID',
      issues: expect.arrayContaining([{
        code: kind === 'story' ? 'BINDING_STORY_MISSING' : 'BINDING_STORY_IDENTITY_INVALID',
        severity: 'error',
        count: 1,
      }]),
    })
  })
  it.each(['preset', 'persona', 'lorebook', 'persona-lorebook'] as const)('删除共享资产后仍允许离线备份并在报告中告警 %s', async kind => {
    const cardId = 'dangling-a1b2c3d4', sessionId = 'session-dangling', storyId = 'story-00000000-0000-4000-8000-000000000007'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true }); await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(card, 'card.json'), { name: 'test' })
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId, createdAt: new Date(0).toISOString(), migrated: false })
    if (kind === 'persona-lorebook') {
      await mkdir(join(home, 'dsh-tavern/personas'), { recursive: true })
      await save(join(home, 'dsh-tavern/personas/hero.json'), { id: 'hero', name: '主角', description: '', lorebookId: 'deleted-book' })
    }
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), { sessionId, cardId, storyId,
      presetId: kind === 'preset' ? 'missing' : null,
      personaId: kind === 'persona' ? 'missing' : kind === 'persona-lorebook' ? 'hero' : null,
      lorebookIds: kind === 'lorebook' ? ['missing'] : [], characterLorebookId: null,
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const result = await create()
    expect(result.ok).toBe(true)
    expect(result.issues).toContainEqual({ code: 'BINDING_ASSET_MISSING', severity: 'warning', count: 1 })
  })
  it('显式停机声明必需且活 PID 锁仍会阻断；session.lock 不是停机证据', async () => {
    await expect(createBackup({ home, backup, offline: false })).rejects.toMatchObject({ code: 'OFFLINE_DECLARATION_REQUIRED' })
    await writeFile(join(home, 'settings.lock'), `${process.pid}\n`)
    await expect(create()).rejects.toMatchObject({ code: 'HOST_ACTIVITY_DETECTED' })
    await rm(join(home, 'settings.lock')); await writeFile(join(home, 'session.lock'), '')
    expect((await create()).offlineVerified).toBe(false)
    await expect(restoreBackup({ backup, target, offline: false })).rejects.toMatchObject({ code: 'OFFLINE_DECLARATION_REQUIRED' })
  })
  it('允许 @dsh/character 占位绑定与碰撞后缀的预设/世界书引用，缺失目标时降级为告警', async () => {
    const cardId = 'collision-a1b2c3d4', sessionId = 'session-col', storyId = 'story-00000000-0000-4000-8000-000000000009'
    const card = join(home, 'dsh-tavern/characters', cardId), story = join(card, 'stories', storyId)
    await mkdir(story, { recursive: true }); await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await mkdir(join(home, 'dsh-tavern/library/lorebooks'), { recursive: true })
    await save(join(card, 'card.json'), { name: 'test' })
    await save(join(story, 'story.json'), { version: 1, id: storyId, sessionId, createdAt: new Date(0).toISOString(), migrated: false })
    await save(join(home, 'dsh-tavern/library/lorebooks/a_b-2.json'), { sourceId: 'a:b', name: 'book', entries: {} })
    await save(join(home, 'dsh-tavern/sessions', `${sessionId}.json`), { sessionId, cardId, storyId,
      presetId: null, personaId: null, lorebookIds: ['a:b'], characterLorebookId: '@dsh/character', characterLorebookIds: ['@dsh/character'],
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const clean = await create()
    expect(clean.operation).toBe('create')
    expect(clean.issues.map(issue => issue.code)).not.toContain('BINDING_ASSET_MISSING')
    await rm(backup, { recursive: true, force: true })
    await rm(join(home, 'dsh-tavern/library/lorebooks/a_b-2.json'))
    await save(join(home, 'dsh-tavern/library/lorebooks/a_b.json'), { sourceId: 'a_b', name: 'other', entries: {} })
    const dangling = await create()
    expect(dangling.ok).toBe(true)
    expect(dangling.issues).toContainEqual({ code: 'BINDING_ASSET_MISSING', severity: 'warning', count: 1 })
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
  it('CLI 拒绝隐式 home/重复/多余参数及短横标志误作路径；支持子命令 help、version、--flag=value 与失败明细输出', async () => {
    expect(() => parseBackupArguments(['create', '--backup', backup, '--offline'])).toThrow()
    expect(() => parseBackupArguments(['verify', '--backup', backup, '--backup', backup])).toThrow()
    expect(() => parseBackupArguments(['verify', '--backup', backup, '--home', home])).toThrow()
    expect(() => parseBackupArguments(['create', '--home', home, '--backup', '-h', '--offline'])).toThrow()
    expect(parseBackupArguments(['create', `--home=${home}`, `--backup=${backup}`, '--offline'])).toMatchObject({
      command: 'create', home, backup, offline: true, json: false,
    })

    const output: string[] = [], errors: string[] = []
    const io = { out: (text: string) => { output.push(text) }, err: (text: string) => { errors.push(text) } }
    expect(await backupMain(['--version'], io)).toBe(0)
    expect(output.join('').trim()).toMatch(/^\d+\.\d+\.\d+/)
    output.length = 0
    expect(await backupMain(['create', '--help'], io)).toBe(0)
    expect(output.join('')).toContain('dsh-tavern-backup')
    output.length = 0
    expect(await backupMain(['verify', '-h'], io)).toBe(0)
    expect(output.join('')).toContain('dsh-tavern-backup')
    output.length = 0; errors.length = 0
    // --backup -h 不能误把 -h 创建成目录，必须返回 INVALID_ARGUMENTS（退出码 2）。
    expect(await backupMain(['create', '--home', home, '--backup', '-h', '--offline', '--json'], io)).toBe(2)
    expect(JSON.parse(errors.join(''))).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
    errors.length = 0

    expect(await backupMain(['create', '--home', home, '--backup', backup, '--json'], io)).toBe(1)
    expect(JSON.parse(errors.join(''))).toMatchObject({ ok: false, code: 'OFFLINE_DECLARATION_REQUIRED' })
    expect(errors.join('')).not.toContain(home)
    errors.length = 0

    // 父目录不存在返回退出码 1（PARENT_DIRECTORY_MISSING）而非内部错误 2。
    expect(await backupMain(['create', '--home', home, '--backup', join(scratch, 'no-parent', 'backup'), '--offline', '--json'], io)).toBe(1)
    expect(JSON.parse(errors.join(''))).toMatchObject({ ok: false, code: 'PARENT_DIRECTORY_MISSING' })
    expect(errors.join('')).not.toContain('no-parent')
    errors.length = 0

    // 结构错误在 JSON 和文本错误输出中均附带脱敏 issues。
    await mkdir(join(home, 'dsh-tavern/sessions'), { recursive: true })
    await save(join(home, 'dsh-tavern/sessions/session-secret.json'), { sessionId: 'session-secret', cardId: 'missing-a1b2c3d4',
      presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    expect(await backupMain(['create', '--home', home, '--backup', backup, '--offline', '--json'], io)).toBe(1)
    expect(JSON.parse(errors.join(''))).toMatchObject({
      ok: false, code: 'STRUCTURE_INVALID',
      issues: expect.arrayContaining([{ code: 'BINDING_CARD_MISSING', severity: 'error', count: 1 }]),
    })
    expect(errors.join('')).not.toContain('session-secret')
    expect(errors.join('')).not.toContain('missing-a1b2c3d4')
    errors.length = 0
    expect(await backupMain(['create', '--home', home, '--backup', backup, '--offline'], io)).toBe(1)
    expect(errors.join('')).toContain('BINDING_CARD_MISSING')
    expect(errors.join('')).toContain('dsh-tavern-doctor')
    expect(errors.join('')).not.toContain('session-secret')
    await rm(join(home, 'dsh-tavern'), { recursive: true, force: true })

    output.length = 0; errors.length = 0
    expect(await backupMain(['create', `--home=${home}`, `--backup=${backup}`, '--offline', '--json'], io)).toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: true, operation: 'create' })
  })
})
