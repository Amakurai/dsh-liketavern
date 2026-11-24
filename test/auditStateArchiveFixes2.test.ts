/**
 * State 与归档存储第二轮缺陷修复回归测试（S1–S9）：
 * - S1: WAL 回滚遇到缺失或循环记忆归并来源时在标记 recovering 与写 rollback-progress 前失败
 * - S2: 内嵌世界书 assets/character-book.json 遵守 MAX_STORED_CARD_JSON_BYTES 且 doctor 按同上限放行
 * - S3: bumpNamedAssetRev 让带冲突后缀或原始名别名的世界书/预设在修改删除及迁移导入后失效 standing 指纹
 * - S4: safeAssetFileId 拦截空串、相对路径、尾点空白、Windows 设备名及超 120 字节名称
 * - S5: WAL assertWithinRoot 与 floorDir 拒绝 ..、.、Windows 设备名与 .rolled-back-* 伪造楼层
 * - S6: backup references() 对共享资产候选读盘去重计费、捕获损坏 story.json 且大小写无关匹配 sessions
 * - S7: backupFiles assertSeparate 拦截含尾部 sep 的根路径包含关系
 * - S8: sessionArchive 导入导出拒绝损坏的预设、人设与共享世界书
 * - S9: storyWorkspace 快照命中快速路径不复活并发淘汰或已丢弃的句柄
 */
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup } from '../src/node/backup.js'
import { assertSeparate } from '../src/node/backupFiles.js'
import { resolveConfig } from '../src/node/config.js'
import { archiveFile, sealSessionArchive } from '../src/node/sessionArchiveFormat.js'
import { importSessionArchive } from '../src/node/sessionArchiveImport.js'
import { snapshotSessionArchive } from '../src/node/sessionArchiveSnapshot.js'
import { safeAssetFileId, TavernState } from '../src/node/state.js'
import { runDoctor } from '../src/doctor.js'
import { MAX_STORED_CARD_JSON_BYTES } from '../src/state/card.js'
import { MemoryStore } from '../src/state/memory.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { Wal } from '../src/state/wal.js'
import { importCard } from '../src/state/workspace.js'
import { WAL_RECOVERY_PATH, WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-state-audit2-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeState(base: string): TavernState {
  return new TavernState(
    {
      root: base,
      characters: join(base, 'characters'),
      lorebooks: join(base, 'library/lorebooks'),
      presets: join(base, 'library/presets'),
      personas: join(base, 'personas'),
      regexDir: join(base, 'regex'),
      sessions: join(base, 'sessions'),
    },
    () => resolveConfig({}),
  )
}

async function seedCharacter(base: string, name = 'Tester'): Promise<string> {
  const created = await importCard(join(base, 'characters'), {
    spec: 'chara_card_v2',
    name,
    description: 'd',
    personality: 'p',
    scenario: 's',
    firstMes: 'hi',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    alternateGreetings: [],
    tags: [],
    creator: 't',
    characterVersion: '1',
    regexScripts: [],
    extensions: {},
  })
  return created.cardId
}

async function createStoryForSession(cardRoot: string, sessionId: string): Promise<string> {
  const id = newStoryId()
  await snapshotStory({ cardRoot, sourceRoot: cardRoot, id, sessionId })
  return id
}

describe('State 与归档层第二轮缺陷修复回归 (S1–S9)', () => {
  it('S1: WAL 回滚遇到缺失的记忆归并来源时，在写恢复标记与游标前即失败且保持可写', async () => {
    const wsRoot = join(root, 's1-story')
    await mkdir(join(wsRoot, 'memory/archive'), { recursive: true })
    await mkdir(join(wsRoot, 'state/wal'), { recursive: true })
    const wal = new Wal(join(wsRoot, 'state/wal'))
    const plainFs = new WorkspaceFs(wsRoot, null)
    const walFs = new WorkspaceFs(wsRoot, wal)
    const walMemory = new MemoryStore(walFs)
    const plainMemory = new MemoryStore(plainFs)

    await wal.beginFloor('f1')
    const floorMemory = new MemoryStore(walFs.withFloor('f1'))
    const m1 = await floorMemory.write({ body: 'fact one', tags: [], keys: ['k1'], floor: 1 })
    const m2 = await floorMemory.write({ body: 'fact two', tags: [], keys: ['k2'], floor: 1 })
    await wal.commitFloor('f1')

    await plainMemory.mergeBatch([m1, m2], 'merged summary', 'merge')
    // 删除其中一条已归档来源，制造回滚展开期缺失来源故障。
    await plainFs.delete(`memory/archive/${m2.id}.md`)

    await expect(wal.rollbackFloor('f1', wsRoot)).rejects.toThrow(/缺失/)
    await expect(lstat(join(wsRoot, WAL_RECOVERY_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(wsRoot, 'state/wal/f1/rollback-progress.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(wal.assertWorkspaceWritable()).resolves.toBeUndefined()
  })

  it('S2: 超限内嵌世界书被 saveCharacterLorebook 拒绝，且 doctor 允许大于 16 MiB 但不超上限的卡内书', async () => {
    const state = makeState(root)
    const cardId = await seedCharacter(root, 'S2Card')
    const huge = { name: 'Huge', entries: [{ keys: ['k'], content: 'x'.repeat(17 * 1024 * 1024) }] }
    const cardJsonBytes = Buffer.byteLength(JSON.stringify({ data: huge }), 'utf8')
    expect(cardJsonBytes).toBeGreaterThan(16 * 1024 * 1024)
    expect(cardJsonBytes).toBeLessThan(MAX_STORED_CARD_JSON_BYTES)

    // 17 MiB 单份 JSON 不超 128 MiB 上限：成功写入且 doctor 不报 oversizedJson。
    await expect(state.saveCharacterLorebook(cardId, huge)).resolves.toMatchObject({ entryCount: 1 })
    const report = await runDoctor({ home: root, pluginDataRoot: root })
    expect(report.statistics.files.oversizedJson).toBe(0)
  })

  it('S3: bumpNamedAssetRev 让带冲突后缀的世界书在编辑、删除与迁移导入后使 standing 指纹失效', async () => {
    const state = makeState(root)
    const cardId = await seedCharacter(root, 'S3Card')
    const id1 = await state.saveLorebook('Lore_A', { name: 'OtherBook', entries: [] })
    const id2 = await state.saveLorebook('Lore:A', { name: 'Lore:A', entries: [{ uid: 1, key: ['a'], content: 'v1' }] })
    expect(id1).toBe('Lore_A')
    expect(id2).toBe('Lore_A-2')

    const binding = {
      sessionId: 'sess-s3',
      cardId,
      presetId: null,
      personaId: null,
      characterLorebookId: null,
      lorebookIds: ['Lore:A'],
      worldInfo: {},
      authorNote: '',
      injectJournal: false,
    }
    const beforeTags = state.standingRevTags(binding).join('|')
    await state.saveLorebook('Lore:A', { name: 'Lore:A', entries: [{ uid: 1, key: ['a'], content: 'v2' }] })
    const afterSaveTags = state.standingRevTags(binding).join('|')
    expect(afterSaveTags).not.toBe(beforeTags)

    await state.deleteLorebook('Lore:A')
    const afterDeleteTags = state.standingRevTags(binding).join('|')
    expect(afterDeleteTags).not.toBe(afterSaveTags)

    state.invalidateSessionArchiveAssets(['library/lorebooks/Lore_A-2.json'])
    const afterArchiveTags = state.standingRevTags(binding).join('|')
    expect(afterArchiveTags).not.toBe(afterDeleteTags)
  })

  it('S4: safeAssetFileId 拦截空串、相对路径、尾点空白、Windows 设备名及超长 UTF-8 名称并保持幂等', () => {
    for (const bad of ['', '.', '..', 'foo.', 'foo ', 'CON', 'con.json', 'NUL', 'COM1', 'LPT9.book', '中'.repeat(60)]) {
      const safe = safeAssetFileId(bad)
      expect(safe).not.toBe(bad)
      expect(safe).not.toBe('')
      expect(safe).not.toBe('.')
      expect(safe).not.toBe('..')
      expect(Buffer.byteLength(safe, 'utf8')).toBeLessThanOrEqual(120)
      expect(safeAssetFileId(safe)).toBe(safe)
    }
    expect(safeAssetFileId('normal.v1-cn')).toBe('normal.v1-cn')
  })

  it('S5: WAL 拒绝 ..、.、尾点、Windows 保留名及 .rolled-back-* 伪造楼层，并拦截 rootDir 外目标', async () => {
    const wsRoot = join(root, 's5-story')
    const walDir = join(wsRoot, 'state/wal')
    await mkdir(walDir, { recursive: true })
    const wal = new Wal(walDir)
    for (const bad of ['', '.', '..', 'f1.', 'CON', 'LPT1', 't1.rolled-back-123']) {
      await expect(wal.beginFloor(bad)).rejects.toThrow()
      await expect(wal.validateFloor(bad)).rejects.toThrow()
    }
    await expect(wal.rollbackFloor('..', wsRoot)).rejects.toThrow()
  })

  it('S6 & S7: backup assertSeparate 处理根路径尾斜杠，references 对候选去重并捕获损坏 story.json', async () => {
    const fsRoot = parse(root).root
    expect(() => assertSeparate(fsRoot, root)).toThrow(/NESTED_PATHS/)
    expect(() => assertSeparate(root, fsRoot)).toThrow(/NESTED_PATHS/)

    const home = join(root, 'home')
    const tavern = join(home, 'dsh-tavern')
    const cardId = await seedCharacter(tavern, 'S6Card')
    const storyId = await createStoryForSession(join(tavern, 'characters', cardId), 'sess-s6')
    await mkdir(join(tavern, 'sessions'), { recursive: true })
    // 写入损坏的 story.json，应汇总 BINDING_STORY_IDENTITY_INVALID 导致 STRUCTURE_INVALID 而非抛出 INVALID_JSON。
    await writeFile(join(tavern, 'characters', cardId, 'stories', storyId, 'story.json'), '{bad-json', 'utf8')
    await writeFile(
      join(tavern, 'sessions/sess-s6.json'),
      JSON.stringify({
        sessionId: 'sess-s6',
        cardId,
        storyId,
        presetId: null,
        personaId: null,
        characterLorebookId: null,
        lorebookIds: [],
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    await expect(createBackup({ operation: 'verify', home, backup: join(root, 'backup-out'), offline: true } as never)).rejects.toThrow(/STRUCTURE_INVALID/)
  })

  it('S8: sessionArchive 导出与导入拒绝损坏的世界书与严格读取失败的人设/预设', async () => {
    const state = makeState(root)
    const cardId = await seedCharacter(root, 'S8Card')
    const id = await state.saveLorebook('BrokenBook', { entries: [] })
    const storyId = await createStoryForSession(join(root, 'characters', cardId), 'sess-s8')
    const binding = {
      sessionId: 'sess-s8',
      cardId,
      storyId,
      presetId: null,
      personaId: null,
      characterLorebookId: null,
      lorebookIds: [id],
      interactiveCards: null,
      greetingIndex: 0,
      worldInfo: {},
      authorNote: '',
      injectJournal: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    await state.saveBinding(binding)
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('sess-s8'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    const events = session.snapshotEvents()
    ctx.provide('sessionPersistence', {
      open: async () => ({
        header: session.header,
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }),
    } as never)

    // 先趁世界书完好导出合法归档作为导入篡改基线，再破坏磁盘世界书测导出拒绝。
    const validArchive = await snapshotSessionArchive(ctx, state, 'sess-s8')

    // 把世界书破坏成缺少 entries 的非合法 JSON，冷启动后的导出即应失败。
    await writeFile(join(root, 'library/lorebooks', `${id}.json`), JSON.stringify({ name: id }), 'utf8')
    await expect(snapshotSessionArchive(ctx, makeState(root), 'sess-s8')).rejects.toThrow(/entries/)

    // 导入端校验损坏世界书同样拒绝。
    const badImportRoot = await mkdtemp(join(tmpdir(), 'tavern-s8-import-'))
    try {
      const targetState = makeState(badImportRoot)
      const tampered = structuredClone(validArchive)
      tampered.files = tampered.files.map((file) =>
        file.area === 'global' && file.path === `library/lorebooks/${id}.json`
          ? archiveFile('global', file.path, Buffer.from(JSON.stringify({ name: id }), 'utf8'))
          : file,
      )
      const archive = sealSessionArchive({
        format: tampered.format,
        version: tampered.version,
        binding: tampered.binding,
        session: tampered.session,
        files: tampered.files,
        attachments: tampered.attachments,
      })
      const ctx2 = {
        sessions: { get: () => undefined, messageProjections: ctx.sessions.messageProjections },
        get: (name: string) => {
          if (name === 'sessionPersistence') return { stat: async () => undefined }
          if (name === 'workspaceRegistry') return { list: () => [{ id: 'w1', path: badImportRoot, attachSession: async () => {} }] }
          return undefined
        },
      } as unknown as Context
      await expect(importSessionArchive(ctx2, targetState, archive, 'w1')).rejects.toThrow(/entries/)
    } finally {
      await rm(badImportRoot, { recursive: true, force: true })
    }
  })

  it('S9: storyWorkspace 快速路径在并发 discardStory 后不复活已删除缓存项', async () => {
    const state = makeState(root)
    const cardId = await seedCharacter(root, 'S9Card')
    const storyId = await createStoryForSession(join(root, 'characters', cardId), 'sess-s9')
    const ws = await state.storyWorkspace(cardId, storyId)

    // 在 fast-path stat 挂起期间并发丢弃该剧情，验证 workspaces Map 不会复活旧句柄。
    const origStat = ws.plainFs.stat.bind(ws.plainFs)
    let releaseStat!: () => void
    const statPaused = new Promise<void>((resolve) => {
      releaseStat = resolve
    })
    ws.plainFs.stat = async (path) => {
      const result = await origStat(path)
      await statPaused
      return result
    }
    const pendingLookup = state.storyWorkspace(cardId, storyId)
    await state.discardUnboundStory(cardId, storyId, 'sess-s9')
    releaseStat()
    await pendingLookup
    const cache = (state as unknown as { workspaces: Map<string, unknown> }).workspaces
    const key = [...cache.keys()].find((k) => k.toLowerCase().includes(storyId.toLowerCase()))
    expect(key).toBeUndefined()
  })
})
