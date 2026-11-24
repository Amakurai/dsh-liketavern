/**
 * Core / State / WAL / Backup / Doctor 第四轮审计修复回归测试：
 * - D1: presentStreamingOutput(text, false) 与 presentRenderedOutput 在关闭互动卡及非代码边界容器内彻底剥离不透明元标签
 * - D2: cardMvu 保留 Zod v4 顶层 .refine() 校验、提前拒绝超预算命令并保留单步监听前的 delta_data/display_data 变更
 * - W1: Wal.preflightRollback 跨多楼层原子模拟记忆归并，旧层缺档时在任何磁盘改动前整体拒绝
 * - W2: Wal.reconcileRecoveryMarker / recoveringFloors 遇到缺 meta.json 的残留进度文件 fail-closed 不删恢复标记
 * - W3: Wal.validateRolledBackFloors 与 assertArchiveWalComplete 拦截缺少终止进度的已回滚楼层
 * - B1: portableMode 将 Windows 合成权限归一化为可移植私有 POSIX 权限，doctor 支持 >64 KiB 的 WAL meta.json
 */
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { attachHelperEvents } from '../src/client/helperEventRouter.js'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
import { presentRenderedOutput, presentStreamingOutput } from '../src/core/displaySanitize.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import { runDoctor } from '../src/doctor.js'
import { portableMode } from '../src/node/backupFiles.js'
import { assertArchiveWalComplete } from '../src/node/sessionArchiveWal.js'
import { createBlankCard } from '../src/state/card.js'
import { MemoryStore } from '../src/state/memory.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { Wal } from '../src/state/wal.js'
import { sanitizeFloor } from '../src/state/walFormat.js'
import { importCard } from '../src/state/workspace.js'
import { WAL_RECOVERY_PATH, WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
const cleanups: Array<() => void> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-core-state-audit4-'))
})

afterEach(async () => {
  for (const stop of cleanups.splice(0)) stop()
  await rm(root, { recursive: true, force: true })
})

function makeCardMvuWindow(snapshot: HelperSnapshot) {
  const listeners = new Set<(event: unknown) => void>()
  let vmParse: ((raw: string) => unknown) | undefined
  const send = (data: Record<string, unknown>) => {
    const payload = vmParse ? vmParse(JSON.stringify(data)) : structuredClone(data)
    for (const listener of listeners) listener({ source: parent, data: payload })
  }
  const endpoint = attachHelperEvents('audit4-session', snapshot.storyId, (message) => queueMicrotask(() => send(message)))
  const parent = {
    postMessage: (message: Record<string, unknown>) => {
      queueMicrotask(() => endpoint.receive(structuredClone(message)))
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
  scope.self = scope
  scope.globalThis = scope
  const ctx = createContext(scope)
  vmParse = runInContext('JSON.parse', ctx) as (raw: string) => unknown
  const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0, helperSnapshot: snapshot })
    .replace(/^<script[^>]*>/, '')
    .replace(/<\/script>$/, '')
  runInContext(script, ctx)
  cleanups.push(() => {
    try { runInContext('__dshTavernBridgeCleanup()', ctx) } catch { /* ignore */ }
    endpoint.dispose()
  })
  return { scope: scope as Record<string, any>, run: (code: string) => runInContext(code, ctx) }
}

describe('Core / State / WAL / Backup / Doctor 第四轮审计修复回归', () => {
  it('D1: presentStreamingOutput(false) 剥离 HTML 围栏内元标签，presentRenderedOutput 剥离非代码边界标签内元标签', () => {
    const streamed = presentStreamingOutput('```html\n<div><think>secret</think>hello</div>\n```', false)
    expect(streamed.text).not.toContain('secret')
    expect(streamed.text).toContain('hello')

    const rendered = presentRenderedOutput('<center style="color:red"><think>hidden</think>visible</center>', false)
    expect(rendered.html).toBeNull()
    expect(rendered.text).not.toContain('hidden')
    expect(rendered.text).toContain('visible')

    const renderedHtml = presentRenderedOutput('<center style="color:red"><think>hidden</think>visible</center>', true)
    expect(renderedHtml.html ?? '').not.toContain('hidden')
    expect(renderedHtml.text).not.toContain('hidden')
  })

  it('D2: cardMvu 保留 Zod v4 顶层 .refine() 校验、拦截超 256 条命令并保留预设 delta/display 变更', async () => {
    const snapshot: HelperSnapshot = {
      storyId: 's-mvu4',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: true,
      scopes: {},
      messages: [{ message_id: 0, role: 'assistant', name: 'A', message: 'hi', data: {}, extra: {}, is_hidden: false }],
    }
    const { scope: win, run } = makeCardMvuWindow(snapshot)
    const realSchema = z.object({ hp: z.number() }).refine((v: { hp: number }) => v.hp >= 0, 'hp must be >= 0')
    // 模拟同域沙箱内加载的 zod（返回当前 vm realm 的普通对象）
    const wrapSchema = (s: any): any => ({
      safeParse: (v: unknown) => {
        const res = s.safeParse(v)
        return res.success ? { success: true, data: run(`JSON.parse(${JSON.stringify(JSON.stringify(res.data))})`) } : res
      },
      loose: typeof s.loose === 'function' ? () => wrapSchema(s.loose()) : undefined,
      shape: s.shape,
    })
    win.z = z
    win.__dshTavernMvuZod.registerMvuSchema(wrapSchema(realSchema))

    // 1. 保留顶层 .refine() 校验（loose() 不丢 refine）：hp=-5 违背 refine，被回滚为原值 10
    const rejected = await run(`Mvu.parseMessage("<UpdateVariable>_.set('hp', 10, -5);</UpdateVariable>", { stat_data: { hp: 10 } })`)
    expect(rejected?.stat_data?.hp).toBe(10)

    // 2. 超 256 条命令直接拒绝
    const many = Array.from({ length: 260 }, (_, i) => `_.set('k${i}', null, ${i});`).join('\\n')
    await expect(run(`Mvu.parseMessage("<UpdateVariable>${many}</UpdateVariable>", { stat_data: {} })`)).rejects.toThrow(/256/)

    // 3. 独立剧情帧验证：变量更新开始监听写入的 delta_data / display_data 不被主循环清零覆盖
    const { run: run2 } = makeCardMvuWindow({ ...snapshot, storyId: 's-mvu4-2' })
    run2(`eventOn(Mvu.events.VARIABLE_UPDATE_STARTED, (next) => { next.delta_data = { presetDelta: 1 }; next.display_data = { presetDisplay: 'ok' }; })`)
    const updated = await run2(`Mvu.parseMessage("<UpdateVariable>_.set('hp', 10, 20);</UpdateVariable>", { stat_data: { hp: 10 } })`)
    expect(updated?.stat_data?.hp).toBe(20)
    expect(updated?.delta_data?.presetDelta).toBe(1)
    expect(updated?.display_data?.presetDisplay).toBe('ok')
  })

  it('W1: Wal.preflightRollback 多楼层模拟预检发现旧层缺档时在零落盘改动前整体拒绝', async () => {
    const wal = new Wal(join(root, 'state', 'wal'))
    const fs = new WorkspaceFs(root, wal)
    const mem = new MemoryStore(fs)

    await wal.beginFloor('s#t1')
    const mem1 = new MemoryStore(fs.withFloor('s#t1'))
    const a1 = await mem1.write({ body: '第一层原始记忆', importance: 0.7, tags: ['plot'], keys: ['k1'], floor: 's#t1' })
    await wal.commitFloor('s#t1')

    await wal.beginFloor('s#t2')
    const mem2 = new MemoryStore(fs.withFloor('s#t2'))
    await mem2.mergeBatch([a1], '压缩后的摘要', 'compress')
    await wal.commitFloor('s#t2')

    await wal.beginFloor('s#t3')
    await fs.withFloor('s#t3').writeText('notes/t3.txt', 't3-value')
    await wal.commitFloor('s#t3')

    const activeBefore = await mem.list()
    expect(activeBefore).toHaveLength(1)
    expect(activeBefore[0]!.body).toBe('压缩后的摘要')

    // 破坏归档文件：回滚 t3 本身合法，但同批回滚 [t3, t2] 时 t2 的记忆展开应先在 preflight 拒绝，t3 不得被部分回滚！
    await rm(join(root, 'memory', 'archive', `${a1.id}.md`))

    await expect(wal.rollbackAfter(['s#t3', 's#t2'], root)).rejects.toThrow(/记忆归并来源.*缺失/)
    expect(await fs.readText('notes/t3.txt')).toBe('t3-value')
    expect((await wal.validateFloor('s#t3')).rolledBack).toBe(false)
    expect((await wal.validateFloor('s#t2')).rolledBack).toBe(false)
    expect((await mem.list())[0]?.body).toBe('压缩后的摘要')
  })

  it('W2: 活动楼层存在 rollback-progress.json 但缺少 meta.json 时 fail-closed，不删除 wal-recovery.json', async () => {
    const walDir = join(root, 'state', 'wal')
    const wal = new Wal(walDir)
    const fs = new WorkspaceFs(root, wal)
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('notes/a.txt', 'v1')
    await wal.commitFloor('s#t1')

    // 模拟损坏：写入恢复标记与进度文件，同时删掉 meta.json
    const floorDir = join(walDir, sanitizeFloor('s#t1'))
    await writeFile(join(root, WAL_RECOVERY_PATH), JSON.stringify({ floors: ['s#t1'] }))
    await writeFile(join(floorDir, 'rollback-progress.json'), JSON.stringify({ next: 0 }))
    await rm(join(floorDir, 'meta.json'))

    await expect(wal.recoveringFloors()).rejects.toThrow()
    await expect(wal.reconcileRecoveryMarker()).rejects.toThrow()
    expect(await readFile(join(root, WAL_RECOVERY_PATH), 'utf8')).toContain('s#t1')
  })

  it('W3: Wal.validateRolledBackFloors 与 assertArchiveWalComplete 拦截缺少终止进度的已回滚楼层', async () => {
    const walDir = join(root, 'state', 'wal')
    const wal = new Wal(walDir)
    const fs = new WorkspaceFs(root, wal)
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('notes/a.txt', 'v1')
    await wal.commitFloor('s#t1')
    await wal.rollbackFloor('s#t1', root)

    // 正常已回滚楼层可通过校验
    await expect(wal.validateRolledBackFloors()).resolves.toBeUndefined()
    await expect(assertArchiveWalComplete(wal)).resolves.toBeUndefined()

    // 篡改已回滚楼层的 rollback-progress.json 为非终态
    const rolledDir = (await readdir(walDir)).find((name) => name.includes('.rolled-back-'))!
    await writeFile(join(walDir, rolledDir, 'rollback-progress.json'), JSON.stringify({ next: 0 }))
    await expect(wal.validateRolledBackFloors()).rejects.toThrow()
    await expect(assertArchiveWalComplete(wal)).rejects.toThrow()
  })

  it('B1: portableMode 归一化 Windows 合成权限；doctor 放行 >64 KiB 的 WAL meta.json', async () => {
    expect(portableMode('directory', 0o666, 'win32')).toBe(0o700)
    expect(portableMode('file', 0o666, 'win32')).toBe(0o600)
    expect(portableMode('directory', 0o444, 'win32')).toBe(0o500)
    expect(portableMode('file', 0o444, 'win32')).toBe(0o400)
    expect(portableMode('file', 0o644, 'linux')).toBe(0o644)

    const dshHome = join(root, 'dsh-home')
    const tavernRoot = join(dshHome, 'dsh-tavern')
    const cardId = 'big-meta-card'
    const cardRoot = join(tavernRoot, 'characters', cardId)
    await importCard(cardRoot, createBlankCard('大元数据卡'))
    const storyId = newStoryId()
    await snapshotStory({ cardRoot, sourceRoot: cardRoot, id: storyId, sessionId: 'sess-big' })
    const storyRoot = join(cardRoot, 'stories', storyId)
    const wal = new Wal(join(storyRoot, 'state', 'wal'))
    await wal.beginFloor('sess-big#t1')
    await wal.commitFloor('sess-big#t1')

    // 构造合法但超过 64 KiB 的 meta.json（如长会话或历史元数据扩展）
    const floorDir = join(storyRoot, 'state', 'wal', sanitizeFloor('sess-big#t1'))
    const metaPath = join(floorDir, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    meta.extraNote = 'x'.repeat(80 * 1024)
    await writeFile(metaPath, JSON.stringify(meta))

    await mkdir(join(tavernRoot, 'sessions'), { recursive: true })
    const report = await runDoctor(dshHome)
    const metaErrors = report.issues.filter((i) => i.severity === 'error' && i.path?.includes('meta.json'))
    expect(metaErrors).toEqual([])
  })
})
