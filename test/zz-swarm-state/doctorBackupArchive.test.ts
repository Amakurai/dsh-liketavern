/**
 * 诊断（doctor）、全量离线备份（backup）与单会话迁移快照（sessionArchiveSnapshot）回归测试：
 * - backup 引用检查保留资产原始空白身份，并在 Windows 上对齐运行时大小写不敏感路径匹配；
 * - doctor 与 backup 对崩溃遗留的 `.importing-*` / `.preparing-*` 草稿目录套用运行时大文件上限，不误报超限；
 * - snapshotSessionArchive 按封存信封完整字节计费，近上限会话精确报大小超限而非误报文件损坏。
 */
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../../src/doctor.js'
import { createBackup } from '../../src/node/backup.js'
import * as backupFiles from '../../src/node/backupFiles.js'
import { resolveConfig } from '../../src/node/config.js'
import { SESSION_ARCHIVE_MAX_BYTES } from '../../src/node/sessionArchiveFormat.js'
import { snapshotSessionArchive } from '../../src/node/sessionArchiveSnapshot.js'
import { TavernState } from '../../src/node/state.js'
import { createBlankCard } from '../../src/state/card.js'
import { newStoryId, storyRoot } from '../../src/state/story.js'
import { TEMPLATE_STATE_PATH } from '../../src/state/template.js'
import { importCard } from '../../src/state/workspace.js'
import { closeLedger } from '../../src/state/writeLedger.js'

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    closeLedger(dir, { prefix: true })
    await rm(dir, { recursive: true, force: true })
  }
})

function makeTavernState(root: string): TavernState {
  return new TavernState(
    {
      root,
      characters: join(root, 'characters'),
      lorebooks: join(root, 'library/lorebooks'),
      presets: join(root, 'library/presets'),
      personas: join(root, 'personas'),
      regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions'),
    },
    () => resolveConfig({}),
  )
}

describe('backup 引用检查与 TavernState 身份及平台大小写对齐', () => {
  it('区分仅前后空白不同的冲突资产身份（" foo" 与 "\\tfoo"），不误判双命中也不放过悬空引用', async () => {
    const scratch = await makeTempDir('tavern-backup-ws-id-')
    const home = join(scratch, 'home')
    const dataRoot = join(home, 'dsh-tavern')
    const state = makeTavernState(dataRoot)
    await state.init()

    const card = await state.createCharacter('空白资产测试')
    // 两个不同空白前缀的世界书都净化到 `_foo` 槽位族：`_foo.json` 与 `_foo-2.json`
    await state.saveLorebook(' foo', { name: ' foo', entries: {} })
    await state.saveLorebook('\tfoo', { name: '\tfoo', entries: {} })

    await state.saveBinding({
      sessionId: 'sess-space',
      cardId: card.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [' foo'],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const backupOk = join(scratch, 'backup-ok')
    const report = await createBackup({ home, backup: backupOk, offline: true })
    expect(report.ok).toBe(true)
    expect(report.issues.map((issue) => issue.code)).not.toContain('BINDING_ASSET_MISSING')

    // 删除实际被引用的 `" foo"` 后，仅存的 `"\tfoo"` 不能替它通过引用校验；悬空共享资产降级为 warning 不锁死备份
    await state.deleteLorebook(' foo')
    const missingReport = await createBackup({ home, backup: join(scratch, 'backup-missing'), offline: true })
    expect(missingReport.ok).toBe(true)
    expect(missingReport.issues).toContainEqual({ code: 'BINDING_ASSET_MISSING', severity: 'warning', count: 1 })
  })

  it.runIf(process.platform === 'win32')('Windows 下会话绑定引用不同大小写的角色与资产文件时可正常备份', async () => {
    const scratch = await makeTempDir('tavern-backup-win-case-')
    const home = join(scratch, 'home')
    const dataRoot = join(home, 'dsh-tavern')
    for (const sub of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataRoot, sub), { recursive: true })
    }
    const ws = await importCard(join(dataRoot, 'characters'), createBlankCard('CaseCard'))
    const sid = newStoryId()
    const sRoot = storyRoot(ws.root, sid)
    await mkdir(sRoot, { recursive: true })
    await writeFile(
      join(sRoot, 'story.json'),
      JSON.stringify({ version: 1, id: sid, sessionId: 'sess-win', createdAt: '2026-01-01T00:00:00.000Z', migrated: false }) + '\n',
      'utf8',
    )
    await writeFile(join(dataRoot, 'library/lorebooks/HeroBook.JSON'), JSON.stringify({ name: 'herobook', entries: {} }) + '\n', 'utf8')
    await writeFile(
      join(dataRoot, 'sessions/SESS-WIN.JSON'),
      JSON.stringify({
        sessionId: 'sess-win',
        cardId: ws.cardId.toUpperCase(),
        storyId: sid,
        presetId: null,
        personaId: null,
        lorebookIds: ['herobook'],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      }) + '\n',
      'utf8',
    )

    const result = await createBackup({ home, backup: join(scratch, 'backup-win'), offline: true })
    expect(result.ok).toBe(true)
  })
})

describe('doctor 与 backup 对草稿目录大 JSON 上限的一致性', () => {
  it('崩溃遗留的 .importing-* 与 .preparing-* 草稿内含合法 >16MiB 角色卡或模板文件时不误报 oversizedJson', async () => {
    const scratch = await makeTempDir('tavern-doctor-draft-limit-')
    const home = join(scratch, 'home')
    const dataRoot = join(home, 'dsh-tavern')
    for (const sub of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataRoot, sub), { recursive: true })
    }
    const ws = await importCard(join(dataRoot, 'characters'), createBlankCard('正常角色'))

    const cardDraft = join(dataRoot, 'characters', '.importing-11111111-1111-4111-8111-111111111111')
    const storyDraft = join(ws.root, 'stories', '.preparing-22222222-2222-4222-8222-222222222222')
    await mkdir(cardDraft, { recursive: true })
    await mkdir(join(storyDraft, 'state'), { recursive: true })

    const largeText = '草稿大文本'.repeat(1_200_000) // ~18 MiB UTF-8 (> 16 MiB MAX_JSON_BYTES, <= 64/128 MiB)
    const largeCardJson = JSON.stringify({ name: '未发布大卡', description: largeText })
    const largeTemplateJson = JSON.stringify({ version: 1, variables: { global: {}, local: { text: largeText }, message: {} }, outputs: {} })
    expect(Buffer.byteLength(largeCardJson)).toBeGreaterThan(16 * 1024 * 1024)
    expect(Buffer.byteLength(largeTemplateJson)).toBeGreaterThan(16 * 1024 * 1024)

    await writeFile(join(cardDraft, 'card.json'), largeCardJson, 'utf8')
    await writeFile(join(storyDraft, TEMPLATE_STATE_PATH), largeTemplateJson, 'utf8')

    const report = await runDoctor({
      home,
      nodeVersion: '24.0.0',
      pluginVersion: '0.5.13',
      dshInstalledVersion: '0.2.2-rc.5',
      dshExpectedVersion: '*',
    })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters.drafts).toBe(1)
    expect(report.statistics.stories.drafts).toBe(1)
    expect(report.statistics.files.oversizedJson).toBe(0)

    const backupReport = await createBackup({ home, backup: join(scratch, 'backup-with-drafts'), offline: true })
    expect(backupReport.ok).toBe(true)
  }, 60_000)
})

describe('snapshotSessionArchive 近上限信封字节精确计费', () => {
  it('计入 binding 与归一化 session header 体积后超限时明确报大小上限，不在封存阶段误报文件损坏', async () => {
    const root = await makeTempDir('tavern-archive-envelope-')
    const state = makeTavernState(root)
    await state.init()
    const card = await state.createCharacter('近上限导出角色')
    await state.saveBinding({
      sessionId: 'sess-near-limit',
      cardId: card.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      authorNote: '作者备注'.repeat(200),
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const ctx = new Context()
    try {
      new SessionStore(ctx)
      const session = ctx.sessions.create(SessionId('sess-near-limit'))
      session.append('agent-preset/selected', { agentPreset: 'tavern' })
      const fakeCtx = {
        sessions: { get: () => session, flush: async () => true },
        get: (name: string) =>
          name === 'sessionPersistence'
            ? {
                open: async () => ({
                  header: session.header,
                  inheritedEventCount: 0,
                  read: async () => ({ events: session.snapshotEvents() }),
                  close: async () => {},
                }),
              }
            : undefined,
      } as unknown as Context

      const baseline = await snapshotSessionArchive(fakeCtx, state, 'sess-near-limit')
      const ws = await state.storyWorkspace(card.cardId, baseline.binding.storyId)
      const eventsOnlyBytes = Buffer.byteLength(JSON.stringify(baseline.session.events))
      const existingFileBytes = baseline.files.reduce((sum, f) => sum + f.size, 0)

      // 构造文件大小：若漏算 binding + session.header 开销则看似未超限，计入完整信封后恰好超限 32 字节
      const targetJournalPath = join(ws.fs.root, 'journal.md')
      const oldJournalSize = baseline.files.find((f) => f.area === 'story' && f.path === 'journal.md')!.size
      const fullEnvelopeBytes = Buffer.byteLength(
        JSON.stringify({
          binding: baseline.binding,
          session: baseline.session,
        }),
      )
      const syntheticJournalSize = SESSION_ARCHIVE_MAX_BYTES - fullEnvelopeBytes - (existingFileBytes - oldJournalSize) + 32
      expect(eventsOnlyBytes + (existingFileBytes - oldJournalSize) + syntheticJournalSize).toBeLessThan(SESSION_ARCHIVE_MAX_BYTES)

      const origBoundedBytes = backupFiles.boundedBytes
      vi.spyOn(backupFiles, 'boundedBytes').mockImplementation(async (path, maxBytes, opts) => {
        if (path === targetJournalPath) {
          if (syntheticJournalSize > maxBytes) throw new backupFiles.BackupError('SIZE_LIMIT')
          return Buffer.alloc(syntheticJournalSize, 0x61)
        }
        return origBoundedBytes(path, maxBytes, opts)
      })

      await expect(snapshotSessionArchive(fakeCtx, state, 'sess-near-limit')).rejects.toThrow(/超过大小上限|SIZE_LIMIT/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
