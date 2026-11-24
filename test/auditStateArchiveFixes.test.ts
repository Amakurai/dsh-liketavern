/**
 * State 与会话迁移归档层缺陷修复回归测试：
 * 覆盖 templateStorage 选择缓存中途 LRU 淘汰不丢值不投毒、独立 WAL 非标准根恢复标记路径与 bodyRoot 保留、
 * sharedWalStates LRU 淘汰后代次单调递增不碰撞、WorkspaceFs 空/畸形恢复标记 fail-closed、
 * importSessionArchive 缺失 sessions 目录容错/大小写 JSON 检测/未归属 WAL 世系拒绝，以及 importCard 临时草稿 ledger 清理。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { archiveFile, sealSessionArchive } from '../src/node/sessionArchiveFormat.js'
import { importSessionArchive } from '../src/node/sessionArchiveImport.js'
import { snapshotSessionArchive } from '../src/node/sessionArchiveSnapshot.js'
import { TavernState } from '../src/node/state.js'
import {
  evictTemplateStoryCache,
  prepareTemplateDocument,
  readTemplateDocumentPaths,
  writeTemplateBlocks,
} from '../src/state/templateStorage.js'
import { Wal } from '../src/state/wal.js'
import { importCard } from '../src/state/workspace.js'
import { WAL_RECOVERY_PATH, WorkspaceFs, WORKSPACE_RECOVERING_MESSAGE } from '../src/state/workspaceFs.js'
import { openLedger, writtenSince } from '../src/state/writeLedger.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-state-audit-'))
})

afterEach(async () => {
  evictTemplateStoryCache(root, { prefix: true })
  await rm(root, { recursive: true, force: true })
})

describe('State 与归档层缺陷修复回归', () => {
  it('B1: readTemplateDocumentPaths 读大路径触发 trimParsed 淘汰已缓存路径时，不丢值也不向缓存写回 undefined', async () => {
    const storyDir = join(root, 'story-b1')
    await mkdir(storyDir, { recursive: true })
    const fs = new WorkspaceFs(storyDir, null)
    // 构造超过 16 MiB 解析缓存预算（同时单块不超过 4 MiB）的大路径 + 一个小热路径，使读取大块时 trimParsed 淘汰先前命中的小路径。
    const makeBig = (ch: string) => ({
      p0: ch.repeat(3 * 1024 * 1024),
      p1: ch.repeat(3 * 1024 * 1024),
      p2: ch.repeat(3 * 1024 * 1024),
    })
    const payload = {
      small: { answer: 42 },
      hugeA: makeBig('A'),
      hugeB: makeBig('B'),
    }
    const prepared = prepareTemplateDocument(payload)
    await writeTemplateBlocks(fs, prepared, null)
    await fs.writeText('state/template.json', prepared.raw)

    // 先预热 ['small'] 到 selections.values。
    expect(await readTemplateDocumentPaths(fs, 'state/template.json', [['small']])).toEqual([{ answer: 42 }])

    // 同一次调用里同时请求已缓存的 ['small'] 与两个超大未缓存路径（触发 trimParsed）。
    const batch = await readTemplateDocumentPaths(fs, 'state/template.json', [['hugeA'], ['hugeB'], ['small']])
    expect(batch).not.toBeNull()
    expect((batch![0] as { p0: string }).p0.length).toBe(3 * 1024 * 1024)
    expect((batch![1] as { p0: string }).p0.length).toBe(3 * 1024 * 1024)
    expect(batch![2]).toEqual({ answer: 42 })

    // 再次读取 ['small'] 仍能读出真值，没有被 undefined 毒化。
    expect(await readTemplateDocumentPaths(fs, 'state/template.json', [['small']])).toEqual([{ answer: 42 }])
  })

  it('B2: 独立 WAL（非 state/wal 布局）正确探测自身 wal-recovery.json 写屏障、清理失效标记并保留 bodyRoot', async () => {
    const walRoot = join(root, 'standalone-wal')
    const bodyRoot = join(root, 'body-ws')
    await mkdir(walRoot, { recursive: true })
    await mkdir(bodyRoot, { recursive: true })
    const wal = new Wal(walRoot)
    const fs = new WorkspaceFs(bodyRoot, wal).withFloor('s1#t1')
    await wal.beginFloor('s1#t1')
    await fs.writeText('note.txt', 'v1')
    await wal.commitFloor('s1#t1')

    // 模拟崩溃遗留：独立 WAL 目录下同时有 rollback-progress.json 与 wal-recovery.json（带 bodyRoot）。
    await writeFile(join(walRoot, 's1_t1', 'rollback-progress.json'), JSON.stringify({ hash: '0'.repeat(64), next: 0, restored: [], preserved: [] }))
    await writeFile(
      join(walRoot, 'wal-recovery.json'),
      JSON.stringify({ version: 1, floors: ['s1#t1'], dirs: ['s1_t1'], walDir: walRoot, bodyRoot }) + '\n',
    )

    // 写屏障必须拦截新楼层开启。
    await expect(wal.beginFloor('s1#t2')).rejects.toThrow(WORKSPACE_RECOVERING_MESSAGE)

    // 新增第二个游标后调用 recoveringFloors，重写标记时必须保留 bodyRoot。
    await wal.resetRollbackCursor('s1#t1')
    await wal.beginFloor('s1#t2')
    await fs.writeText('note.txt', 'v2')
    await wal.commitFloor('s1#t2')
    await writeFile(join(walRoot, 's1_t1', 'rollback-progress.json'), JSON.stringify({ hash: '0'.repeat(64), next: 0, restored: [], preserved: [] }))
    await writeFile(join(walRoot, 's1_t2', 'rollback-progress.json'), JSON.stringify({ hash: '0'.repeat(64), next: 0, restored: [], preserved: [] }))
    await writeFile(
      join(walRoot, 'wal-recovery.json'),
      JSON.stringify({ version: 1, floors: ['s1#t1'], dirs: ['s1_t1'], walDir: walRoot, bodyRoot }) + '\n',
    )
    const recovering = await wal.recoveringFloors()
    expect(recovering.sort()).toEqual(['s1#t1', 's1#t2'])
    const bodyMarker = await new WorkspaceFs(bodyRoot, null).readText(WAL_RECOVERY_PATH)
    expect(bodyMarker).not.toBeNull()
    expect(JSON.parse(bodyMarker!).bodyRoot).toBe(bodyRoot)

    // 删掉两个游标后，listFloors 必须自动清除独立 WAL 的失效标记。
    await rm(join(walRoot, 's1_t1', 'rollback-progress.json'))
    await rm(join(walRoot, 's1_t2', 'rollback-progress.json'))
    await wal.listFloors()
    expect(await new WorkspaceFs(walRoot, null).exists('wal-recovery.json')).toBe(false)
    expect(await new WorkspaceFs(bodyRoot, null).exists(WAL_RECOVERY_PATH)).toBe(false)
  })

  it('B3: sharedWalStates 经过 >256 个不同根淘汰后不重置 epoch/coverageEpoch，跨实例不会命中陈旧缓存', async () => {
    const wsRoot = join(root, 'target-story')
    const walA = new Wal(join(wsRoot, 'state', 'wal'))
    const walB = new Wal(join(wsRoot, 'state', 'wal'))
    await walA.beginFloor('s1#t1')
    await walA.commitFloor('s1#t1')
    expect((await walA.listFloors()).map((f) => f.floor)).toEqual(['s1#t1'])

    // 用 260 个其它 WAL 根把 target-story 从 sharedWalStates LRU 中挤出。
    for (let i = 0; i < 260; i++) {
      const other = new Wal(join(root, `other-${i}`, 'state', 'wal'))
      await other.listFloors()
    }

    // walB 修改同一根下的楼层（创建新楼层并修改 coverage），随后 walA 必须立即看到最新楼层与提交状态。
    await walB.beginFloor('s1#t2')
    await walB.commitFloor('s1#t2')
    expect((await walA.listFloors()).map((f) => f.floor).sort()).toEqual(['s1#t1', 's1#t2'])
  })

  it('B4: WorkspaceFs 遇到空 dirs 或畸形 state/wal-recovery.json 时 fail-closed 拒绝写入', async () => {
    const wsRoot = join(root, 'ws-b4')
    await mkdir(join(wsRoot, 'state'), { recursive: true })
    const fs = new WorkspaceFs(wsRoot, null)

    for (const malformed of [
      JSON.stringify({ dirs: [] }),
      JSON.stringify({ version: 2, floors: ['s1#t1'], dirs: ['s1_t1'] }),
      JSON.stringify({ version: 1, floors: ['s1#t1'], dirs: ['wrong_dir'] }),
    ]) {
      await writeFile(join(wsRoot, WAL_RECOVERY_PATH), malformed)
      await expect(fs.writeText('notes.md', 'blocked')).rejects.toThrow(WORKSPACE_RECOVERING_MESSAGE)
    }
  })

  it('B5 & B6: importSessionArchive 容错缺失 sessions 目录、识别大写 .JSON 并拒绝未归属 WAL 世系', async () => {
    const srcRoot = join(root, 'src')
    const dstRoot = join(root, 'dst')
    const makeState = (base: string) =>
      new TavernState(
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

    const srcState = makeState(srcRoot)
    await srcState.init()
    const cardId = (await srcState.createCharacter('归档测试角色')).cardId
    await srcState.saveRegexRules([
      {
        id: 'r1',
        name: 'Rule1',
        find: 'foo',
        replace: 'bar',
        trimStrings: [],
        enabled: true,
        scopes: ['output'],
        timing: ['render'],
        minDepth: null,
        maxDepth: null,
        substituteRegex: 0,
        source: 'user',
        flags: 'g',
      },
    ])
    await srcState.saveBinding({
      sessionId: 'session-src',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('session-src'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    const srcPersistence = {
      open: async () => ({
        header: session.header,
        inheritedEventCount: 0,
        read: async () => ({ events: session.snapshotEvents() }),
        close: async () => {},
      }),
    }
    const srcCtx = {
      sessions: { get: () => session, flush: async () => true },
      get: (name: string) => (name === 'sessionPersistence' ? srcPersistence : undefined),
    } as unknown as Context

    const archive = await snapshotSessionArchive(srcCtx, srcState, 'session-src')

    // 目标宿主缺少 sessions/ 目录时，包含全局 regex/rules.json 的导入不应因 ENOENT 崩溃。
    const dstState = makeState(dstRoot)
    await mkdir(dstRoot, { recursive: true })
    const savedSessions = new Map<string, { header: unknown; events: unknown[] }>()
    const dstCtx = {
      sessions: { get: () => undefined, messageProjections: ctx.sessions.messageProjections },
      get: (name: string) => {
        if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-1', path: dstRoot, attachSession: async () => {} }] }
        if (name === 'sessionPersistence') {
          return {
            stat: async (id: string) => savedSessions.get(id),
            create: async (header: { id: string }) => {
              const entry = { header, events: [] as unknown[] }
              savedSessions.set(header.id, entry)
              return {
                header,
                inheritedEventCount: 0,
                read: async () => ({ events: [...entry.events] }),
                append: async (ev: unknown[]) => { entry.events.push(...ev) },
                flush: async () => {},
                close: async () => {},
              }
            },
          }
        }
        return undefined
      },
    } as unknown as Context

    // B6: 往归档里伪造一个未在 walLineage 中登记的 foreign-session#t1 活动楼层（连同清单），导入必须拒绝。
    const badDraft = structuredClone(archive)
    const metaJson = JSON.stringify({ floor: 'foreign-session#t1', startedAt: new Date(0).toISOString(), committed: true })
    badDraft.files.push(
      archiveFile('story', 'state/wal/foreign-session_t1/meta.json', Buffer.from(metaJson)),
      archiveFile('story', 'state/wal/foreign-session_t1/records.jsonl', Buffer.from('')),
      archiveFile('story', 'state/wal-coverage.json', Buffer.from(JSON.stringify({ version: 1, floors: [{ floor: 'foreign-session#t1', startedAt: new Date(0).toISOString() }] }))),
    )
    const badArchive = sealSessionArchive(badDraft)
    await expect(importSessionArchive(dstCtx, dstState, badArchive, 'ws-1')).rejects.toThrow('无法确认活动 WAL 楼层的来源')

    // B5a: 目标目录存在大写后缀的其它会话文件 OTHER.JSON 时，导入全局 regex 必须识别冲突并拒绝。
    await mkdir(dstState.paths.sessions, { recursive: true })
    await writeFile(join(dstState.paths.sessions, 'OTHER.JSON'), '{}')
    await expect(importSessionArchive(dstCtx, dstState, archive, 'ws-1')).rejects.toThrow('导入全局正则或脚本会影响已有会话')

    // B5b: 删除 sessions/ 目录本身（ENOENT）后，导入应顺利完成。
    await rm(dstState.paths.sessions, { recursive: true, force: true })
    await expect(importSessionArchive(dstCtx, dstState, archive, 'ws-1')).resolves.toEqual({ sessionId: 'session-src' })
    await ctx.fiber.dispose()
  })

  it('B7: importCard 完成后释放临时 staging 的 WriteLedger 状态', async () => {
    const charsDir = join(root, 'chars')
    await mkdir(charsDir, { recursive: true })
    const ws = await importCard(
      charsDir,
      {
        spec: 'chara_card_v2',
        name: 'LedgerCard',
        description: 'd',
        personality: '',
        scenario: '',
        firstMes: '',
        alternateGreetings: [],
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        regexScripts: [],
        extensions: {},
      },
      null,
      false,
    )
    expect(ws.card.name).toBe('LedgerCard')
    const ledger = openLedger(ws.root)
    expect(writtenSince(ledger, 'card.json', 0)).toBe(false)
  })
})
