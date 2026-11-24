/**
 * Core / State / Doctor / Backup 第三轮审计修复回归测试（#1–#8，含 8a/8b/8c）：
 * - #1: Wal.preflightRollback 不因 before-only 记录导致 changesByPath 为空而早退，整批预检记忆归并谱系
 * - #2: cardMvu + cardEvents + helperEventRouter 支持 4 MiB MVU 事件载荷，保持普通事件 256 KiB 上限，零监听不回传冗余 args
 * - #3: card.pickRegexScripts 与 presetStore 对 regex_scripts 归一化并强制条数/字长上限
 * - #4: card depthPrompt 在 parseDepthPrompt / hydrateStoredCard / applyCharacterPatch 全路径约束非负安全整数与角色枚举
 * - #5: doctor 识别 characters/.importing-* 为 info 草稿而不误报 CHARACTER_ID_INVALID，离线备份正常放行
 * - #6: doctor WAL 校验接入 isValidWalFloorDir，且 doctor/backup 对齐 library/(lorebooks|presets)/*.json 的 128 MiB 上限
 * - #7: assemblePrompt 在模板序列与 transformPrompt 中保护非聊天历史（!chatFlags[index]）正文不被执行或改写
 * - #8a/8b/8c: cardVariables scope 与服务端对齐；helperWorldbook/helperLorebook 拒绝小数深度/计时器；MVU 命令前导标识符与 initvar-box 边界
 */
import { webcrypto } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachHelperEvents } from '../src/client/helperEventRouter.js'
import { assemblePrompt, defaultPreset } from '../src/core/assemble.js'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
import { inspectCharacterCompatibility } from '../src/core/characterCompatibility.js'
import { createHelperLorebookCodec } from '../src/core/helperLorebook.js'
import { createHelperMvuCommandCodec } from '../src/core/helperMvuCommands.js'
import { createHelperMvuInitialData } from '../src/core/helperMvuInitial.js'
import { helperJson, type HelperSnapshot } from '../src/core/helperRuntime.js'
import { parseHelperWorldbook } from '../src/core/helperWorldbook.js'
import { markdownCodeScanner } from '../src/core/markdownCode.js'
import { PromptLayoutSchema } from '../src/core/promptLayout.js'
import { runDoctor } from '../src/doctor.js'
import { createBackup } from '../src/node/backup.js'
import { applyCharacterPatch, createBlankCard, hydrateStoredCard, parseJsonCard } from '../src/state/card.js'
import { readHelperWorldbook } from '../src/state/helperWorldbook.js'
import { MemoryStore } from '../src/state/memory.js'
import { parseStPreset, parseStoredPreset } from '../src/state/presetStore.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { Wal } from '../src/state/wal.js'
import { importCard } from '../src/state/workspace.js'
import { WAL_RECOVERY_PATH, WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
const cleanups: Array<() => void> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-core-state-audit3-'))
})

afterEach(async () => {
  for (const stop of cleanups.splice(0)) stop()
  await rm(root, { recursive: true, force: true })
})

const BASE_SNAPSHOT: HelperSnapshot = {
  storyId: 'audit3-story',
  historyRevision: 'audit3-rev',
  currentMessageId: 0,
  writable: true,
  scopes: {},
  messages: [{ message_id: 0, role: 'assistant', name: '角色', message: '出发', data: {}, extra: {}, is_hidden: false }],
}

function makeCardFrame(input: HelperSnapshot = BASE_SNAPSHOT) {
  const listeners = new Set<(event: unknown) => void>()
  const posts: Record<string, unknown>[] = []
  const hostResults: Record<string, unknown>[] = []
  const varRequests: Record<string, unknown>[] = []
  const send = (data: Record<string, unknown>) => {
    if (data.action === 'helperEventResult') hostResults.push(structuredClone(data))
    for (const listener of listeners) listener({ source: parent, data: structuredClone(data) })
  }
  const endpoint = attachHelperEvents('audit3-session', input.storyId, (message) => queueMicrotask(() => send(message)))
  const parent = {
    postMessage: (message: Record<string, unknown>) => {
      const cloned = structuredClone(message)
      posts.push(cloned)
      if (message.action === 'helperVariablesCommit') varRequests.push(cloned)
      else queueMicrotask(() => endpoint.receive(cloned))
    },
  }
  const scope: Record<string, unknown> = {
    parent,
    TextEncoder,
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'loading',
      body: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      open: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
      currentScript: null,
      querySelector: () => null,
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      if (name === 'message') listeners.add(listener)
    },
    removeEventListener: (_name: string, listener: (event: unknown) => void) => listeners.delete(listener),
  }
  scope.window = scope
  const context = createContext(scope)
  const run = (code: string) => runInContext(code, context)
  run(tavernCardBridgeScript({ greetings: [], greetingIndex: 0, helperSnapshot: input }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    run('__dshTavernBridgeCleanup()')
    endpoint.dispose()
  }
  cleanups.push(close)
  return { run, posts, hostResults, varRequests, close }
}

describe('Core / State / Doctor / Backup 第三轮审计修复 (#1–#8)', () => {
  it('#1: 旧版 before-only 批量回滚仍执行记忆归并预检，来源缺失时整批拒绝且不提前回滚较新楼层', async () => {
    const wsRoot = join(root, 'wal-before-only')
    const walRoot = join(wsRoot, 'state/wal')
    await mkdir(join(wsRoot, 'memory/archive'), { recursive: true })
    await mkdir(walRoot, { recursive: true })
    const plainFs = new WorkspaceFs(wsRoot, null)
    const plainMemory = new MemoryStore(plainFs)

    const m1 = await plainMemory.write({ body: '事实甲', tags: [], keys: ['k1'], floor: 1 })
    const m2 = await plainMemory.write({ body: '事实乙', tags: [], keys: ['k2'], floor: 1 })
    await plainMemory.mergeBatch([m1, m2], '归并摘要', 'merge')
    await plainFs.delete(`memory/archive/${m2.id}.md`)
    await plainFs.writeText('journal.md', '第二层正文')

    // 构造两层兼容旧格式（无 after 字段）的已提交 WAL：f1 涉及记忆，f2 仅改 journal.md。
    await mkdir(join(walRoot, 'f1'), { recursive: true })
    await writeFile(join(walRoot, 'f1/meta.json'), JSON.stringify({
      floor: 'f1', startedAt: '2026-01-01T00:00:01.000Z', committed: true, committedAt: '2026-01-01T00:00:02.000Z',
    }))
    await writeFile(join(walRoot, 'f1/records.jsonl'), `${JSON.stringify({
      seq: 1, path: `memory/${m1.id}.md`, before: null,
    })}\n`)

    await mkdir(join(walRoot, 'f2'), { recursive: true })
    await writeFile(join(walRoot, 'f2/meta.json'), JSON.stringify({
      floor: 'f2', startedAt: '2026-01-01T00:00:03.000Z', committed: true, committedAt: '2026-01-01T00:00:04.000Z',
    }))
    await writeFile(join(walRoot, 'f2/records.jsonl'), `${JSON.stringify({
      seq: 1, path: 'journal.md', before: '第一层正文',
    })}\n`)

    const wal = new Wal(walRoot)
    await expect(wal.rollbackAfter(['f1', 'f2'], wsRoot)).rejects.toThrow(/缺失/)

    // 较新楼层 f2 必须完好保留，既未被回滚正文也未被改名归档，工作区仍可写。
    expect(await plainFs.readText('journal.md')).toBe('第二层正文')
    const dirs = await readdir(walRoot)
    expect(dirs).toContain('f2')
    expect(dirs.some((name) => name.startsWith('f2.rolled-back-'))).toBe(false)
    await expect(lstat(join(wsRoot, WAL_RECOVERY_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(wal.assertWorkspaceWritable()).resolves.toBeUndefined()
  })

  it('#2: MVU 生命周期事件支持 >256 KiB 状态且零监听不回传 args，普通事件仍保持 256 KiB 上限', async () => {
    const a = makeCardFrame()
    const b = makeCardFrame()
    const bigPad = 'a'.repeat(160 * 1024)

    // 零监听：stat_data=160 KiB 时 next(含 display_data)≈320 KiB、[next,before]≈640 KiB，均超过 256 KiB 仍须成功。
    const zeroListenerResult = await a.run(
      `Mvu.parseMessage("_.add('hp', 5);", { stat_data: { hp: 10, pad: ${JSON.stringify(bigPad)} } })`,
    )
    expect(zeroListenerResult.stat_data.hp).toBe(15)
    expect(a.hostResults.length).toBeGreaterThan(0)
    // 无监听命中时路由回执省略 args，避免零监听下的冗余大载荷跨帧回传。
    expect(a.hostResults.every((msg) => msg.ok === true && !('args' in msg))).toBe(true)

    // 跨卡面监听：监听修改同样可超过 256 KiB 并在两个 iframe 间正确传播。
    b.run('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (next, before) => { next.stat_data.hp += before.stat_data.hp })')
    const withListenerResult = await a.run(
      `Mvu.parseMessage("_.add('hp', 5);", { stat_data: { hp: 10, pad: ${JSON.stringify(bigPad)} } })`,
    )
    expect(withListenerResult.stat_data.hp).toBe(25)

    // 普通自定义跨卡面事件仍严格维持 256 KiB 上限。
    await expect(a.run('eventEmit("custom_evt", "x".repeat(256 * 1024))')).rejects.toThrow(/256 KiB/)
  })

  it('#3: 角色卡与预设 regex_scripts 容错归一化且校验条数/长度上限', async () => {
    // ST 预设常见变体：placement 字符串数组、可空字段为 null、混入非对象元素。
    const { preset } = parseStPreset({
      name: 'regex-compat',
      identifier: 'regex-compat',
      prompts: [{ identifier: 'main', content: '规则' }],
      extensions: {
        regex_scripts: [
          null,
          'ignored-primitive',
          {
            id: 42,
            scriptName: null,
            findRegex: '/foo/g',
            replaceString: null,
            placement: ['2', 1, 'bad', null],
            disabled: null,
            markdownOnly: 1,
            promptOnly: 'false',
            runOnEdit: null,
            trimStrings: null,
            trimStringsRegex: ['a', 123],
            substituteRegex: true,
            minDepth: '',
            maxDepth: '3',
          },
        ],
      },
    })
    expect(preset.regexScripts).toHaveLength(1)
    expect(preset.regexScripts![0]).toMatchObject({
      id: '42',
      findRegex: '/foo/g',
      placement: [2, 1],
      markdownOnly: true,
      promptOnly: false,
      trimStringsRegex: ['a'],
      substituteRegex: 1,
      minDepth: null,
      maxDepth: 3,
    })
    expect(parseStoredPreset(preset).regexScripts).toHaveLength(1)

    // 角色卡畸形 regex_scripts 经 parseJsonCard + importCard + hydrateStoredCard 不再抛出 TypeError。
    const card = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: 'MalformedRegexCard',
        extensions: {
          regex_scripts: [null, { findRegex: 'abc', placement: 2, trimStrings: 'not-array', disabled: null }],
        },
      },
    })
    expect(card.regexScripts).toEqual([{ findRegex: 'abc' }])
    const imported = await importCard(join(root, 'characters'), card)
    expect(imported.cardId).toBeTruthy()
    const hydrated = hydrateStoredCard({
      name: 'Hydrated',
      regexScripts: [null, { findRegex: 'x', placement: ['2'], trimStrings: 123 }],
    })
    expect(hydrated.regexScripts).toEqual([{ findRegex: 'x', placement: [2] }])

    // 兼容报告不因 regex_scripts 归一化拷贝而重复上报 regexScripts 与 extensions.regex_scripts。
    const compatCard = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: 'CompatNormalizedRegex',
        extensions: {
          regex_scripts: [{ findRegex: '/a/', replaceString: '<script>generateRaw()</script>', placement: ['2'], disabled: null }],
        },
      },
    })
    const compatReport = inspectCharacterCompatibility(compatCard)
    expect(compatReport.findings.find((f) => f.code === 'unsupportedApi')?.locations).toEqual(['regexScripts[0].replaceString'])

    // 预设 regex_scripts 条数与单字段长度超限均拒绝导入与保存。
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ findRegex: `r${i}` }))
    expect(() => parseStPreset({ prompts: [{ identifier: 'main', content: 'x' }], extensions: { regex_scripts: tooMany } })).toThrow(/上限 500/)
    expect(() => parseStPreset({
      prompts: [{ identifier: 'main', content: 'x' }],
      extensions: { regex_scripts: [{ findRegex: 'a'.repeat(100_001) }] },
    })).toThrow(/100000 字符上限/)
    expect(() => parseStoredPreset({ ...preset, regexScripts: tooMany })).toThrow()
  })

  it('#4: depthPrompt 在导入、回读与补丁全路径约束非负安全整数与合法角色，避免破坏 PromptLayoutSchema', () => {
    const imported = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: 'HugeDepth',
        extensions: { depth_prompt: { prompt: 'KEEP', depth: 1e30, role: 'bogus' } },
      },
    })
    expect(imported.depthPrompt).toEqual({ prompt: 'KEEP', depth: Number.MAX_SAFE_INTEGER, role: 'system' })

    const hydratedNeg = hydrateStoredCard({
      name: 'DiskCard',
      depthPrompt: { prompt: 'DISK', depth: -5, role: 'invalid' },
    })
    expect(hydratedNeg.depthPrompt).toEqual({ prompt: 'DISK', depth: 0, role: 'system' })

    const hydratedFloat = hydrateStoredCard({
      name: 'DiskCard2',
      depthPrompt: { prompt: 'DISK2', depth: 1.6, role: 'user' },
    })
    expect(hydratedFloat.depthPrompt).toEqual({ prompt: 'DISK2', depth: 2, role: 'user' })

    // 归一化后的 depthPrompt 可直接通过 assemblePrompt + PromptLayoutSchema。
    const assembled = assemblePrompt({
      card: imported,
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'HugeDepth', user: 'User' },
      history: [{ role: 'user', content: 'hi' }],
      historyMessageIds: ['m0'],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 4096, reserveForOutput: 256 },
      estimateTokens: (text) => text.length,
    })
    expect(() => PromptLayoutSchema.parse(assembled.layout)).not.toThrow()

    // applyCharacterPatch 明确拒绝负数、小数、超安全整数与非法角色。
    const blank = createBlankCard('PatchCard')
    for (const bad of [
      { prompt: 'DP', depth: -1, role: 'system' },
      { prompt: 'DP', depth: 1.5, role: 'system' },
      { prompt: 'DP', depth: 1e30, role: 'system' },
      { prompt: 'DP', depth: 2, role: 'tool' },
    ]) {
      expect(() => applyCharacterPatch(blank, { depthPrompt: bad as never })).toThrow(/depthPrompt 无效/)
    }
  })

  it('#5: doctor 识别 characters/.importing-* 为 info 草稿且离线备份放行，链接型 .importing-* 仍报错', async () => {
    const home = join(root, 'home-draft')
    const dataRoot = join(home, 'dsh-tavern')
    for (const dir of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataRoot, dir), { recursive: true })
    }
    const created = await importCard(join(dataRoot, 'characters'), createBlankCard('DraftOwner'))
    const storyId = newStoryId()
    await snapshotStory({
      cardRoot: join(dataRoot, 'characters', created.cardId),
      sourceRoot: join(dataRoot, 'characters', created.cardId),
      id: storyId,
      sessionId: 'sess-draft',
    })
    // 模拟角色导入崩溃遗留的 .importing-* 草稿目录。
    const draftDir = join(dataRoot, 'characters', '.importing-00000000-0000-4000-8000-000000000000')
    await mkdir(draftDir, { recursive: true })
    await writeFile(join(draftDir, 'card.json'), JSON.stringify({ name: 'Incomplete' }))

    const report = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '1.0.0' })
    expect(report.ok).toBe(true)
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 1, unhealthy: 0, drafts: 1, invalidIds: 0 })
    expect(report.issues).toContainEqual({ code: 'CHARACTER_DRAFT_PRESENT', severity: 'info', count: 1 })
    expect(report.issues.map((issue) => issue.code)).not.toContain('CHARACTER_ID_INVALID')

    // 离线备份不得被崩溃遗留草稿误拦为 STRUCTURE_INVALID。
    const backup = await createBackup({ home, backup: join(root, 'backup-draft'), offline: true })
    expect(backup.ok).toBe(true)

    // 若 .importing-* 是符号链接/联接，仍必须报 CHARACTER_LINK_SKIPPED 错误。
    const extTarget = join(root, 'external-dir')
    await mkdir(extTarget, { recursive: true })
    try {
      await symlink(extTarget, join(dataRoot, 'characters', '.importing-evil-link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    const linkReport = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '1.0.0' })
    expect(linkReport.ok).toBe(false)
    expect(linkReport.issues).toContainEqual({ code: 'CHARACTER_LINK_SKIPPED', severity: 'error', count: 1 })
  })

  it('#6: doctor 拒绝非法 WAL 目录名（与 Wal.floorDir 一致）并放行 >16 MiB 合法共享世界书/预设及离线备份', async () => {
    // 6a: 双重 .rolled-back-* 目录在全平台合法创建，但 baseName 不满足 isValidWalFloorDir。
    const homeWal = join(root, 'home-wal-invalid')
    const dataWal = join(homeWal, 'dsh-tavern')
    for (const dir of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataWal, dir), { recursive: true })
    }
    const card = await importCard(join(dataWal, 'characters'), createBlankCard('WalCheck'))
    const storyId = newStoryId()
    const cardRoot = join(dataWal, 'characters', card.cardId)
    await snapshotStory({ cardRoot, sourceRoot: cardRoot, id: storyId, sessionId: 'sess-wal' })
    const badFloorDir = join(cardRoot, 'stories', storyId, 'state/wal', 't1.rolled-back-1.rolled-back-2')
    await mkdir(badFloorDir, { recursive: true })
    await writeFile(join(badFloorDir, 'meta.json'), JSON.stringify({
      floor: 't1.rolled-back-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      committed: true,
      rolledBackAt: '2026-01-01T00:00:01.000Z',
    }))
    const walReport = await runDoctor({ home: homeWal, nodeVersion: '24.0.0', pluginVersion: '1.0.0' })
    expect(walReport.ok).toBe(false)
    expect(walReport.issues.map((issue) => issue.code)).toContain('WAL_INVALID')

    // 6b: >16 MiB 合法共享世界书与预设在 doctor 与离线备份（含别名候选读取）中均不再误报超限。
    const homeBig = join(root, 'home-big-lib')
    const dataBig = join(homeBig, 'dsh-tavern')
    for (const dir of ['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']) {
      await mkdir(join(dataBig, dir), { recursive: true })
    }
    const bigCard = await importCard(join(dataBig, 'characters'), createBlankCard('BigLibCard'))
    const bigStoryId = newStoryId()
    const bigCardRoot = join(dataBig, 'characters', bigCard.cardId)
    await snapshotStory({ cardRoot: bigCardRoot, sourceRoot: bigCardRoot, id: bigStoryId, sessionId: 'sess-big' })

    const bigPayload = 'x'.repeat(17 * 1024 * 1024)
    await writeFile(join(dataBig, 'library/lorebooks/Lore_Big.json'), JSON.stringify({
      name: 'Lore:Big',
      entries: { '0': { uid: 0, key: ['k'], content: bigPayload } },
    }))
    await writeFile(join(dataBig, 'library/presets/Preset_Big.json'), JSON.stringify({
      identifier: 'Preset:Big',
      name: 'Preset:Big',
      entries: [{ identifier: 'main', name: 'main', enabled: true, role: 'system', position: 'relative', depth: 0, order: 10, content: bigPayload, marker: false }],
    }))
    await writeFile(join(dataBig, 'sessions/sess-big.json'), JSON.stringify({
      sessionId: 'sess-big',
      cardId: bigCard.cardId,
      storyId: bigStoryId,
      presetId: 'Preset:Big',
      personaId: null,
      characterLorebookId: null,
      lorebookIds: ['Lore:Big'],
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }))

    const bigDoctor = await runDoctor({ home: homeBig, nodeVersion: '24.0.0', pluginVersion: '1.0.0' })
    expect(bigDoctor.ok).toBe(true)
    expect(bigDoctor.statistics.files.oversizedJson).toBe(0)
    const bigBackup = await createBackup({ home: homeBig, backup: join(root, 'backup-big-lib'), offline: true })
    expect(bigBackup.ok).toBe(true)
  })

  it('#7: assemblePrompt 隔离显式非聊天与宿主合成历史，同时保留未排除的普通 system 历史供 generate 阶段使用', () => {
    const renderedKeys: string[] = []
    const seqContents: string[] = []
    const transformSeen: Array<[string, number]> = []
    const flaggedLiteral = 'NOTICE <% throw new Error("must not run") %>'
    const syntheticLiteral = '【Tavern 步骤】<% throw new Error("synthetic") %>'

    const res = assemblePrompt({
      card: createBlankCard('Tester'),
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'Tester', user: 'User' },
      history: [
        { role: 'system', content: flaggedLiteral },
        { role: 'user', content: syntheticLiteral },
        { role: 'user', content: 'CHAT-MSG' },
      ],
      historyMessageIds: ['h0', 'h1', 'h2'],
      historyChatFlags: [false, true, true],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 4096, reserveForOutput: 256 },
      estimateTokens: (text) => text.length,
      renderTemplate: (text, source) => {
        renderedKeys.push(source)
        return text
      },
      processTemplateSequence: (items) => {
        for (const item of items) {
          if (item.history) {
            seqContents.push(item.message.content)
            item.historyInsertions = { before: '', after: '' }
          }
        }
        return {}
      },
      transformPrompt: (text, meta) => {
        transformSeen.push([text, meta.depth])
        return `[T]${text}`
      },
    })

    expect(renderedKeys).toContain('history:2')
    expect(renderedKeys).not.toContain('history:0')
    expect(renderedKeys).not.toContain('history:1')
    expect(seqContents).toEqual(['[T]CHAT-MSG'])
    // 兼容既有契约：transformPrompt 仍可观测冻结 depth，但显式非聊天与合成正文不被改写。
    expect(transformSeen.some(([text]) => text === flaggedLiteral)).toBe(true)
    expect(res.messages.some((m) => m.role === 'system' && m.content === flaggedLiteral)).toBe(true)
    expect(res.messages.some((m) => m.role === 'user' && m.content === syntheticLiteral)).toBe(true)
    expect(res.messages.some((m) => m.role === 'user' && m.content === '[T]CHAT-MSG')).toBe(true)

    // 未经 historyChatFlags 排除的普通 system 历史仍进入模板序列（对齐 templateApiParity 的 generate 默认含 system 契约）。
    const systemSeq: string[] = []
    assemblePrompt({
      card: createBlankCard('Tester'),
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'Tester', user: 'User' },
      history: [
        { role: 'system', content: 'SYS-HISTORY' },
        { role: 'user', content: 'USER-HISTORY' },
      ],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 4096, reserveForOutput: 256 },
      estimateTokens: (text) => text.length,
      renderTemplate: (text) => text,
      processTemplateSequence: (items) => {
        for (const item of items) if (item.history) systemSeq.push(item.message.content)
        return {}
      },
    })
    expect(systemSeq).toEqual(['SYS-HISTORY', 'USER-HISTORY'])
  })

  it('#8a: cardVariables.scope 同步拒绝负数/小数及超长作用域 ID，避免锁死持久化状态', () => {
    const f = makeCardFrame()
    expect(() => f.run('replaceVariables({ a: 1 }, { type: "script", script_id: -1 })')).toThrow(/Invalid variable scope id/)
    expect(() => f.run('replaceVariables({ a: 1 }, { type: "script", script_id: 1.5 })')).toThrow(/Invalid variable scope id/)
    expect(() => f.run('replaceVariables({ a: 1 }, { type: "extension", extension_id: "x".repeat(257) })')).toThrow(/Invalid variable scope id/)
    expect(f.varRequests).toEqual([])
    expect(f.run('getHelperPersistenceStatus()')).toBe('saved')
  })

  it('#8b: helperWorldbook/helperLorebook 拒绝小数深度与计时器，readHelperWorldbook 容错读取旧落盘数据', () => {
    expect(() => parseHelperWorldbook([{ position: { type: 'at_depth', depth: 1.5, order: 100 } }])).toThrow(/整数字段无效/)
    expect(() => parseHelperWorldbook([{ strategy: { scan_depth: 2.5 } }])).toThrow(/整数字段无效/)
    expect(() => parseHelperWorldbook([{ recursion: { delay_until: 1.2 } }])).toThrow(/整数字段无效/)
    expect(() => parseHelperWorldbook([{ effect: { sticky: 0.5 } }])).toThrow(/整数字段无效/)
    expect(() => parseHelperWorldbook([{ effect: { cooldown: 1.1 } }])).toThrow(/整数字段无效/)
    expect(() => parseHelperWorldbook([{ effect: { delay: 3.3 } }])).toThrow(/整数字段无效/)

    const legacyCodec = createHelperLorebookCodec(helperJson)
    expect(() => legacyCodec.replace([{ position: 'at_depth_as_system', depth: 1.5 }])).toThrow(/整数字段无效/)
    expect(() => legacyCodec.replace([{ sticky: 0.5 }])).toThrow(/整数字段无效/)

    // 既有磁盘世界书含小数非 at_depth 深度或计时器时，readHelperWorldbook 仍可正常读出并归一化。
    const read = readHelperWorldbook({
      entries: { '0': { uid: 0, key: ['k'], content: 'c', position: 0, depth: 1.6, sticky: 2.4, scanDepth: 3.2 } },
    })
    expect(read.entries[0]!.position.depth).toBe(2)
    expect(read.entries[0]!.effect.sticky).toBe(2)
    expect(read.entries[0]!.strategy.scan_depth).toBe(3)
  })

  it('#8c: MVU 命令解析跳过标识符后缀 _.set/_.add，initvar 忽略自定义短横线标签 <initvar-box>', () => {
    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)
    const commands = codec.parse("说明：foo_.set('hp', 99) 与 obj_.add('hp', 1) 不是命令\n正文_.add('hp', 3);")
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ type: 'add', args: ["'hp'", '3'] })

    const parsedYaml = (text: string) => {
      const match = /^(\w+):\s*(\d+)$/.exec(text.trim())
      return match ? { [match[1]!]: Number(match[2]) } : {}
    }
    const init = createHelperMvuInitialData(
      [],
      '<initvar-box>面板说明</initvar-box>\n<initvar>\nhp: 42\n</initvar>',
      { stat_data: {} },
      parsedYaml,
      helperJson,
    )
    expect(init.stat_data).toEqual({ hp: 42 })
    expect(() => createHelperMvuInitialData([], '<initvar class="x">hp: 1</initvar>', { stat_data: {} }, parsedYaml, helperJson))
      .toThrow(/不支持属性/)
  })
})
