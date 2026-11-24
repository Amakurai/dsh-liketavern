/**
 * 状态存储、WAL 事务、分块模板缓存与只读诊断回归审计测试。
 *
 * 覆盖：
 * 1. WriteLedger 在 closeLedger 关闭账本及 invalidate 显式作废后的跨实例/等长同刻度写入同步；
 * 2. Wal.recordChanges 落盘前格式守卫、多实例 metaCache/清单代次同步、以及楼层外改坏 template.json 时的回滚容错；
 * 3. WorkspaceFs 文件路径禁止指向工作区根目录自身（防临时文件落入父目录），以及楼层内删除 WAL 保留路径的前置拒绝；
 * 4. 分块模板生成恢复正文（state/template-generation）在外部丢失后的重写自愈，以及跨路径读取不污染 chunked 标记；
 * 5. MemoryStore 与 WorldDeltaStore 返回对象的缓存副本隔离、以及 mergeBatch 重复来源去重；
 * 6. HelperState 并发保存的互斥串行化与 swipes 归一化落盘；
 * 7. 角色/剧情元数据缺失或非对象 JSON 的拒绝边界与 hydrateStoredCard 安全默认值；
 * 8. doctor 与离线备份对合法超过 16 MiB 的模板生成恢复正文/聊天世界书文件对齐运行时上限，并拒绝无名 card.json。
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { runDoctor } from '../src/doctor.js'
import { createBackup } from '../src/node/backup.js'
import { applyCharacterPatch, cardToStJson, hydrateStoredCard } from '../src/state/card.js'
import { loadHelperState, saveHelperState } from '../src/state/helper.js'
import { MemoryStore } from '../src/state/memory.js'
import { newStoryId, readStory, storyRoot } from '../src/state/story.js'
import {
  loadTemplateState,
  saveTemplateMetadata,
  saveTemplateState,
  TEMPLATE_GENERATION_PATH,
  TEMPLATE_STATE_PATH,
} from '../src/state/template.js'
import type { PreparedTemplateGeneration } from '../src/state/templateGeneration.js'
import {
  loadTemplateDocument,
  prepareTemplateDocument,
  readTemplateDocumentPaths,
  TEMPLATE_DATA_PATH,
} from '../src/state/templateStorage.js'
import { Wal } from '../src/state/wal.js'
import { createBlankCard } from '../src/state/card.js'
import { importCard, loadCharacter } from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { WorldDeltaStore } from '../src/state/worlddelta.js'
import { closeLedger, invalidateLedger, openLedger } from '../src/state/writeLedger.js'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    closeLedger(dir, { prefix: true })
    await rm(dir, { recursive: true, force: true })
  }
})

function makePreparedGeneration(options: {
  sessionId: string
  cardId: string
  storyId: string
  turn: number
  standingText: string
}): PreparedTemplateGeneration {
  const zeroHash = '0'.repeat(64)
  const context: TemplateContext = {
    variables: emptyTemplateScopes(),
    char: 'Alice',
    user: 'Bob',
    card: {},
    entries: [],
    presets: [],
    history: [],
    now: 1,
    seed: 7,
    phase: 'generate',
    sessionId: options.sessionId,
    cardId: options.cardId,
  }
  return {
    version: 1,
    status: 'prepared',
    sessionId: options.sessionId,
    cardId: options.cardId,
    storyId: options.storyId,
    turn: options.turn,
    floor: `${options.sessionId}#t${options.turn}`,
    replay: {
      version: 2,
      formatterVersion: 2,
      context,
      operations: [],
      variables: emptyTemplateScopes(),
      messageVariablesHash: zeroHash,
    },
    plan: {
      standingKey: 'test',
      standing: options.standingText,
      turnContext: '',
      messages: [],
      history: [],
      logLines: [],
      userName: 'Bob',
      personaDescription: '',
      personaLorebookId: null,
      wiBudget: { limit: 1000, used: 0, overflowed: false },
      sampling: {
        temperature: 1,
        topP: 1,
        maxTokens: null,
        stop: [],
        presencePenalty: 0,
        frequencyPenalty: 0,
        thinking: 'disabled',
      },
      assembleLog: [],
      stats: { tokensBefore: 0, tokensAfter: 0, trimmedSections: [] },
    },
  }
}

describe('状态层与诊断深度审计回归', () => {
  it('closeLedger 与 invalidate 后，存活的 MemoryStore 与 WorldDeltaStore 仍能捕获同长度同刻度写入', async () => {
    const root = await makeTempDir('tavern-audit-ledger-')
    const fs = new WorkspaceFs(root, null)
    const memories = new MemoryStore(fs)
    const deltas = new WorldDeltaStore(fs)

    const written = await memories.write({ body: '北门未开', keys: ['北门'] })
    await deltas.append({
      type: 'update',
      ref: null,
      content: '北门未开',
      keys: ['北门'],
      order: 10,
      sourceRange: 't1',
      expires: null,
    })
    expect((await memories.list())[0]?.body).toBe('北门未开')
    expect((await deltas.list())[0]?.content).toBe('北门未开')

    // 关闭账本后再触发重建：旧实例不能继续持有失联的死账本引用
    closeLedger(root)
    expect((await memories.list())[0]?.body).toBe('北门未开')
    expect((await deltas.list())[0]?.content).toBe('北门未开')

    const memPath = join(root, 'memory', `${written.id}.md`)
    const deltaPath = join(root, 'state', 'world-delta.jsonl')
    const memBeforeStat = await stat(memPath)
    const deltaBeforeStat = await stat(deltaPath)
    const fixedTime = new Date(Math.floor(memBeforeStat.mtimeMs))

    const memRaw = await fs.readText(`memory/${written.id}.md`)
    const deltaRaw = await fs.readText('state/world-delta.jsonl')
    const nextMemRaw = memRaw!.replace('北门未开', '北门已开')
    const nextDeltaRaw = deltaRaw!.replace('北门未开', '北门已开')
    expect(Buffer.byteLength(nextMemRaw)).toBe(memBeforeStat.size)
    expect(Buffer.byteLength(nextDeltaRaw)).toBe(deltaBeforeStat.size)

    await fs.writeText(`memory/${written.id}.md`, nextMemRaw)
    await fs.writeText('state/world-delta.jsonl', nextDeltaRaw)
    await utimes(memPath, fixedTime, new Date(memBeforeStat.mtimeMs))
    await utimes(deltaPath, fixedTime, new Date(deltaBeforeStat.mtimeMs))

    expect((await memories.list())[0]?.body).toBe('北门已开')
    expect((await memories.search('北门已开'))[0]?.entry.id).toBe(written.id)
    expect((await deltas.list())[0]?.content).toBe('北门已开')

    // invalidate 推进全局单调 epoch，随后 close + reopen 不会撞上同一 epoch
    memories.invalidate()
    const epochAfterInvalidate = openLedger(root).epoch
    closeLedger(root)
    expect(openLedger(root).epoch).toBeGreaterThan(epochAfterInvalidate)
    invalidateLedger(root)
    expect(openLedger(root).epoch).toBeGreaterThan(epochAfterInvalidate + 1)
  })

  it('Wal.recordChanges 提前拒绝非法路径与坏 base64，且跨实例 metaCache 同步重新提交时间以拦截越序回滚', async () => {
    const root = await makeTempDir('tavern-audit-wal-')
    const walDir = join(root, 'state', 'wal')
    const walA = new Wal(walDir)
    const walB = new Wal(walDir)

    await walA.beginFloor('s#t1')
    for (const badPath of ['./a.md', 'a//b.md', '../escape.md', 'state/wal-recovery.json', 'state/wal/s_t1/meta.json']) {
      await expect(walA.recordChange('s#t1', badPath, null, 'x', 'utf8', 'utf8')).rejects.toThrow(/WAL/)
    }
    await expect(walA.recordChange('s#t1', 'bin.dat', 'not-valid-base64!', null, 'base64', 'utf8')).rejects.toThrow(/WAL/)
    expect(await readdir(join(walDir, 's_t1'))).toEqual(['meta.json'])

    // walA 提交 s#t1 并缓存其 committedAt；随后 s#t2 写入 journal.md = v2
    const fsA = new WorkspaceFs(root, walA)
    await fsA.withFloor('s#t1').writeText('journal.md', 'v1')
    await walA.commitFloor('s#t1')
    await walA.listFloors()

    await walA.beginFloor('s#t2')
    await fsA.withFloor('s#t2').writeText('journal.md', 'v2')
    await walA.commitFloor('s#t2')

    // 另一实例 walB 重新打开 s#t1 并在 s#t2 之后叠写 journal.md = v3 再提交（ISO 时间戳等长）
    const fsB = new WorkspaceFs(root, walB)
    await walB.reopenFloor('s#t1')
    await fsB.withFloor('s#t1').writeText('journal.md', 'v3')
    await walB.commitFloor('s#t1')

    // walA 不能因命中旧 metaCache（旧 committedAt < s#t2.startedAt）跳过 s#t1 的后继依赖检查
    await expect(walA.rollbackFloor('s#t2', root)).rejects.toThrow(/后继依赖/)
    expect(await fsA.readText('journal.md')).toBe('v3')
  })

  it('楼层外手工改坏 state/template.json 时，回滚同层分块写入保守保留数据块且不锁死工作区', async () => {
    const root = await makeTempDir('tavern-audit-wal-tpl-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('s#t1')
    const floorFs = new WorkspaceFs(root, wal).withFloor('s#t1')

    await floorFs.writeText('journal.md', '模型笔记')
    await saveTemplateState(floorFs, {
      version: 1,
      variables: { global: {}, local: { large: '块数据'.repeat(15_000) }, message: {} },
      outputs: {},
    })
    await wal.commitFloor('s#t1')
    const blocksBefore = await new WorkspaceFs(root, null).list(TEMPLATE_DATA_PATH)
    expect(blocksBefore.length).toBeGreaterThan(0)

    // 模拟楼层外把根文件改坏（非合法 JSON）
    await writeFile(join(root, TEMPLATE_STATE_PATH), '{corrupted-manual-edit', 'utf8')

    await wal.rollbackFloor('s#t1', root)
    const plain = new WorkspaceFs(root, null)
    expect(await plain.readText('journal.md')).toBeNull()
    expect(await plain.readText(TEMPLATE_STATE_PATH)).toBe('{corrupted-manual-edit')
    expect(await plain.list(TEMPLATE_DATA_PATH)).toEqual(blocksBefore)
    expect(await wal.recoveringFloors()).toEqual([])
    await expect(plain.writeText('journal.md', '恢复可写')).resolves.toBeUndefined()
  })

  it('WorkspaceFs 禁止将工作区根目录作为文件写删目标，且楼层内删除不存在的 WAL 保留路径立即拒绝', async () => {
    const sandbox = await makeTempDir('tavern-audit-fs-')
    const root = join(sandbox, 'child-workspace')
    const plain = new WorkspaceFs(root, null)

    for (const rootAlias of ['', '.', './', './.', 'sub/']) {
      await expect(plain.writeText(rootAlias, 'bad')).rejects.toThrow(/文件路径无效/)
      await expect(plain.writeBytes(rootAlias, new Uint8Array([1]))).rejects.toThrow(/文件路径无效/)
      await expect(plain.writeTextMany([[rootAlias, 'bad']])).rejects.toThrow(/文件路径无效/)
      await expect(plain.delete(rootAlias)).rejects.toThrow(/文件路径无效/)
      await expect(plain.deleteMany([rootAlias])).rejects.toThrow(/文件路径无效/)
    }
    // 父目录下不能留下任何临时文件，未创建的 root 也不能变成普通文件
    expect(await readdir(sandbox)).toEqual([])

    await mkdir(root, { recursive: true })
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('s#t1')
    const floorFs = new WorkspaceFs(root, wal).withFloor('s#t1')
    for (const reserved of ['state/wal-recovery.json', 'state/wal-coverage.json', 'state/wal/s_t1/records.jsonl']) {
      await expect(floorFs.delete(reserved)).rejects.toThrow(/无法记录快照/)
      await expect(floorFs.deleteMany([reserved])).rejects.toThrow(/无法记录快照/)
      await expect(floorFs.writeTextMany([[reserved, '{}']])).rejects.toThrow(/无法记录快照/)
    }
  })

  it('分离存放的生成恢复正文在外部丢失后再次保存可自动补写，且跨路径读取不污染主模板 chunked 标记', async () => {
    const root = await makeTempDir('tavern-audit-tpl-gen-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('s1#t1')
    const floorFs = new WorkspaceFs(root, wal).withFloor('s1#t1')
    const storyId = newStoryId()
    const generation = makePreparedGeneration({
      sessionId: 's1',
      cardId: 'alice-12345678',
      storyId,
      turn: 1,
      standingText: '大型冻结提示词'.repeat(12_000),
    })

    await saveTemplateMetadata(floorFs, {
      version: 1,
      variables: { global: {}, local: { step: 1 }, message: {} },
      generation,
    })
    const genDir = join(root, TEMPLATE_GENERATION_PATH)
    expect((await readdir(genDir)).length).toBe(1)

    // 外部误删 state/template-generation 目录后，命中内存 knownGenerationBody 的后续保存仍须补齐落盘
    await rm(genDir, { recursive: true, force: true })
    await saveTemplateMetadata(floorFs, {
      version: 1,
      variables: { global: {}, local: { step: 2 }, message: {} },
      generation,
    })
    expect((await readdir(genDir)).length).toBe(1)

    closeLedger(root)
    const reloaded = await loadTemplateState(floorFs)
    expect(reloaded.variables.local).toEqual({ step: 2 })
    expect(reloaded.generation?.status).toBe('prepared')

    // 另一分块模板加载成功后，再用 readTemplateDocumentPaths 读取其它内联文件，不得清空主模板的 chunked 检查
    const chunkedRoot = await makeTempDir('tavern-audit-tpl-chunked-')
    const chunkedWal = new Wal(join(chunkedRoot, 'state', 'wal'))
    await chunkedWal.beginFloor('s#t1')
    const chunkedFs = new WorkspaceFs(chunkedRoot, chunkedWal).withFloor('s#t1')
    await saveTemplateState(chunkedFs, {
      version: 1,
      variables: { global: {}, local: { payload: '内容'.repeat(25_000) }, message: {} },
      outputs: {},
    })
    await chunkedFs.withFloor(null).writeText('state/other-inline.json', JSON.stringify({ kind: 'inline', flag: true }))
    expect(await readTemplateDocumentPaths(chunkedFs, 'state/other-inline.json', [['flag']])).toEqual([true])

    // 外部移走 state/template-data 后，主模板的暖读仍须识别块目录缺失并报错（不能被 other-inline 误标为非分块）
    await rm(join(chunkedRoot, TEMPLATE_DATA_PATH), { recursive: true, force: true })
    await expect(loadTemplateDocument(chunkedFs, TEMPLATE_STATE_PATH, (v) => v)).rejects.toThrow(/数据块缺失/)
    expect(prepareTemplateDocument({ a: 1 }).bytes).toBeGreaterThan(0)
  })

  it('MemoryStore 与 WorldDeltaStore 返回隔离副本，调用方原地修改不污染缓存，且 mergeBatch 去重重复来源', async () => {
    const root = await makeTempDir('tavern-audit-copy-')
    const fs = new WorkspaceFs(root, null)
    const memories = new MemoryStore(fs)

    const m1 = await memories.write({ body: '海港灯塔在午夜亮起蓝光', tags: ['地点'], keys: ['灯塔'] })
    const m2 = await memories.write({ body: '守塔人留下一把铜钥匙', tags: ['线索'], keys: ['铜钥匙'] })

    const listed = await memories.list()
    listed[0]!.tags.push('脏标签')
    listed[0]!.keys.push('脏关键词')
    listed[0]!.body = '被调用方篡改的正文'
    listed.pop()

    const similar = await memories.findSimilar('海港灯塔', ['灯塔'])
    similar[0]!.entry.tags.push('相似脏标签')
    similar[0]!.entry.body = '相似篡改'

    const searched = await memories.search('灯塔')
    searched[0]!.entry.keys.push('检索脏键')

    const candidates = await memories.aliasCandidates(10)
    candidates[0]!.tags.push('候选脏标签')

    const cleanList = await memories.list()
    expect(cleanList).toHaveLength(2)
    const cleanM1 = cleanList.find((item) => item.id === m1.id)!
    expect(cleanM1.body).toBe('海港灯塔在午夜亮起蓝光')
    expect(cleanM1.tags).toEqual(['地点'])
    expect(cleanM1.keys).toEqual(['灯塔'])

    // mergeBatch 传入含重复项的数组时去重来源 ID，不产生重复 source_range
    const freshEntries = await memories.list()
    const mergedCount = await memories.mergeBatch([freshEntries[0]!, freshEntries[0]!, freshEntries[1]!], '灯塔与铜钥匙摘要', 'compress')
    expect(mergedCount).toBe(2)
    const afterMerge = await memories.list()
    expect(afterMerge).toHaveLength(1)
    expect(afterMerge[0]!.sourceRange).toBe(`compress:${m1.id},${m2.id}`)

    const deltas = new WorldDeltaStore(fs)
    const inputKeys = ['灯塔']
    const created = await deltas.append({
      type: 'add',
      ref: null,
      content: '灯塔顶层已封锁',
      keys: inputKeys,
      order: 1,
      sourceRange: 't1',
      expires: null,
    })
    inputKeys.push('外部追加')
    created.keys.push('返回值篡改')
    const deltaList = await deltas.list()
    expect(deltaList[0]!.keys).toEqual(['灯塔'])
    deltaList[0]!.keys.push('列表篡改')
    expect((await deltas.list())[0]!.keys).toEqual(['灯塔'])
  })

  it('saveHelperState 并发写入经工作区锁串行化，且落盘与缓存的 swipes 均完成归一化', async () => {
    const root = await makeTempDir('tavern-audit-helper-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('s#t1')
    const floorFs = new WorkspaceFs(root, wal).withFloor('s#t1')

    const chatScope = JSON.stringify(['chat', ''])
    await saveHelperState(floorFs, {
      scopes: { [chatScope]: { step: 'A' } },
      extras: {},
      swipes: {
        '0': {
          active: 0,
          pages: [{ message: '第一页', data: { ok: 1 }, extra: {} }],
        },
      },
    })

    // 并发执行 A -> B 与写回 A：加锁串行化后最终状态必须与最后排队的写入一致，不因锁外预读丢写
    await Promise.all([
      saveHelperState(floorFs, { scopes: { [chatScope]: { step: 'B' } }, extras: {} }),
      saveHelperState(floorFs, { scopes: { [chatScope]: { step: 'A' } }, extras: {} }),
    ])
    const cached = await loadHelperState(floorFs)
    closeLedger(root)
    const fromDisk = await loadHelperState(floorFs)
    expect(cached).toEqual(fromDisk)
    expect(fromDisk.scopes).toEqual({ [chatScope]: { step: 'A' } })
  })

  it('拒绝无名 card.json 与非对象 story.json，hydrateStoredCard 为最小卡补齐安全默认值', async () => {
    const root = await makeTempDir('tavern-audit-meta-')
    const characters = join(root, 'characters')
    const imported = await importCard(characters, createBlankCard('测试角色'))

    // card.json 被篡改为空对象或空名时 loadCharacter 返回 null
    await writeFile(join(imported.root, 'card.json'), '{}\n', 'utf8')
    expect(await loadCharacter(characters, imported.cardId)).toBeNull()
    await writeFile(join(imported.root, 'card.json'), '{"name":""}\n', 'utf8')
    expect(await loadCharacter(characters, imported.cardId)).toBeNull()

    // 最小合法存储卡（仅含 name）水合后可正常导出和打补丁，不抛 TypeError
    const hydrated = hydrateStoredCard({ name: '极简卡' })
    expect(hydrated.regexScripts).toEqual([])
    expect(hydrated.tags).toEqual([])
    expect(hydrated.alternateGreetings).toEqual([])
    expect(() => cardToStJson(hydrated)).not.toThrow()
    expect(applyCharacterPatch(hydrated, { description: '补充描述' }).description).toBe('补充描述')

    // story.json 为 null、数组或语法损坏时统一抛中文业务错误，不泄漏 TypeError/SyntaxError
    const sid = newStoryId()
    const sRoot = storyRoot(imported.root, sid)
    await mkdir(sRoot, { recursive: true })
    for (const badJson of ['null', '[]', '123', '{broken']) {
      await writeFile(join(sRoot, 'story.json'), badJson, 'utf8')
      await expect(readStory(imported.root, sid)).rejects.toThrow('剧情状态元数据损坏')
    }
  })

  it('doctor 与离线备份接受合法超过 16 MiB 的模板生成恢复正文，并拒绝无名 card.json', async () => {
    const scratch = await makeTempDir('tavern-audit-doctor-')
    const home = join(scratch, 'home')
    const dataRoot = join(home, 'dsh-tavern')
    for (const sub of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataRoot, sub), { recursive: true })
    }
    const doctorVersions = {
      nodeVersion: '24.0.0',
      pluginVersion: '0.5.12',
      dshInstalledVersion: '0.2.2-rc.3',
      dshExpectedVersion: '*',
    }

    const ws = await importCard(join(dataRoot, 'characters'), createBlankCard('大状态角色'))
    const sid = newStoryId()
    const sRoot = storyRoot(ws.root, sid)
    await mkdir(join(sRoot, TEMPLATE_GENERATION_PATH), { recursive: true })
    await writeFile(
      join(sRoot, 'story.json'),
      JSON.stringify({ version: 1, id: sid, sessionId: 's1', createdAt: new Date(0).toISOString(), migrated: false }) + '\n',
      'utf8',
    )
    const largeGenFile = join(sRoot, TEMPLATE_GENERATION_PATH, `s1_t1.${'a'.repeat(64)}.json`)
    const largePayload = JSON.stringify({ plan: '长篇生成恢复正文'.repeat(800_000) })
    expect(Buffer.byteLength(largePayload)).toBeGreaterThan(16 * 1024 * 1024)
    await writeFile(largeGenFile, largePayload, 'utf8')

    const healthyReport = await runDoctor({ home, ...doctorVersions })
    expect(healthyReport.ok).toBe(true)
    expect(healthyReport.statistics.files.oversizedJson).toBe(0)
    expect(healthyReport.issues.filter((i) => i.severity === 'error')).toEqual([])

    const backupDir = join(scratch, 'backup-ok')
    const backupResult = await createBackup({ home, backup: backupDir, offline: true })
    expect(backupResult.ok).toBe(true)

    // 无名空对象 card.json 必须被 doctor 判为 CHARACTER_METADATA_INVALID
    const badCardDir = join(dataRoot, 'characters', 'nameless-12345678')
    await mkdir(badCardDir, { recursive: true })
    await writeFile(join(badCardDir, 'card.json'), '{}\n', 'utf8')
    const brokenReport = await runDoctor({ home, ...doctorVersions })
    expect(brokenReport.ok).toBe(false)
    expect(brokenReport.issues).toContainEqual({ code: 'CHARACTER_METADATA_INVALID', severity: 'error', count: 1 })
  }, 60_000)
})
