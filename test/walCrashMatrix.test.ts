/**
 * WAL 崩溃矩阵：对楼层写入、单层回滚与多层回退逐一在第 N 次文件变更处模拟进程崩溃
 * （该次及之后的全部变更都失败，atomicWrite 的临时文件清理也不会执行），随后用全新
 * Wal / WorkspaceFs 句柄模拟重启并执行恢复。无论崩溃落在哪一步，恢复后的工作区必须与
 * 事务前逐字节一致；回滚恢复本身再次崩溃时同样如此。只用临时目录与手写文件，不调用模型。
 *
 * 楼层写入与单层回滚的首次崩溃逐点覆盖；多层回退与二次崩溃默认按步长抽样（含首尾），
 * 设置 WAL_CRASH_MATRIX=full 时全部逐点覆盖（Windows 上约需十余分钟）。
 */
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { sweepOrphanTemps } from '../src/state/atomicWrite.js'

const crash = vi.hoisted(() => ({ armed: false, at: 0, count: 0, crashed: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  // 只拦截会改变磁盘的操作；读取在崩溃前后都照常进行。
  const guard = <A extends unknown[], R>(op: (...args: A) => Promise<R>, mutates: (...args: A) => boolean = () => true) =>
    async (...args: A): Promise<R> => {
      if (crash.armed && mutates(...args)) {
        if (crash.crashed) throw new Error('测试：进程已崩溃')
        if (++crash.count === crash.at) { crash.crashed = true; throw new Error('测试：进程崩溃') }
      }
      return op(...args)
    }
  const writesFlag = (_path: unknown, flags?: unknown, ..._rest: unknown[]) => typeof flags === 'string' && /[wax+]/.test(flags)
  return {
    ...actual,
    mkdir: guard(actual.mkdir as (...args: unknown[]) => Promise<unknown>),
    // 崩溃点只看操作顺序，不依赖真实落盘；跳过 fsync 让数百轮矩阵在 Windows 上也能快速完成。
    open: guard(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      handle.sync = async () => {}
      return handle
    }, writesFlag),
    rename: guard(actual.rename),
    rm: guard(actual.rm),
    appendFile: guard(actual.appendFile as (...args: unknown[]) => Promise<void>),
    writeFile: guard(actual.writeFile as (...args: unknown[]) => Promise<void>),
  }
})

const FLOOR = 's#t1'
const LATER = 's#t2'
const WAL_DIR = 'state/wal'
const FULL = process.env.WAL_CRASH_MATRIX === 'full'
/** 1..total 的崩溃点：步长抽样但始终包含首尾，full 模式逐点。 */
const points = (total: number, stride: number): number[] => {
  const step = FULL ? 1 : stride
  const out: number[] = []
  for (let at = 1; at < total; at += step) out.push(at)
  out.push(total)
  return out
}
const binary = (seed: number) => Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + seed) % 256 | 0x80)

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tavern-crash-')) })
afterEach(async () => {
  Object.assign(crash, { armed: false, at: 0, count: 0, crashed: false })
  await rm(root, { recursive: true, force: true })
})

/** 模拟重启：每次都新建句柄，不复用崩溃前进程内的任何对象。 */
function open(): { wal: Wal; fs: WorkspaceFs } {
  const wal = new Wal(join(root, WAL_DIR))
  return { wal, fs: new WorkspaceFs(root, wal) }
}

/** 工作区可见内容（排除 WAL 自身）；崩溃遗留的原子写临时文件单独返回，不混入业务内容比较。 */
async function snapshot(): Promise<{ files: Record<string, string>; orphans: string[] }> {
  const files: Record<string, string> = {}
  const orphans: string[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (path === WAL_DIR) continue
      if (entry.isDirectory()) await walk(path)
      else if (/\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) orphans.push(path)
      else files[path] = (await readFile(join(root, path))).toString('base64')
    }
  }
  await walk('')
  return { files, orphans }
}

/** 事务前状态：文本修改、二进制修改、待删除文件与未触碰文件各一。 */
async function seed(): Promise<void> {
  const { fs } = open()
  await fs.writeText('notes/a.md', '第一版\n')
  await fs.writeText('state/gone.md', '将被删除\n')
  await fs.writeText('state/untouched.json', '{"keep":true}\n')
  await fs.writeBytes('avatar.png', binary(1))
}

/** 一层完整的楼层事务：同路径两次修改、新建、删除、二进制替换，最后提交。 */
async function floorTransaction(floor: string, tag: string): Promise<void> {
  const { wal, fs } = open()
  await wal.beginFloor(floor)
  const scoped = fs.withFloor(floor)
  await scoped.writeText('notes/a.md', `${tag}：第二版\n`)
  await scoped.writeText(`notes/${tag}.md`, `${tag} 新建\n`)
  await scoped.delete('state/gone.md')
  await scoped.writeBytes('avatar.png', binary(tag.length + 7))
  await scoped.writeText('notes/a.md', `${tag}：第三版\n`)
  await wal.commitFloor(floor)
}

/** 统计一段操作会产生多少次文件变更，作为矩阵的上界。 */
async function countMutations(task: () => Promise<unknown>): Promise<number> {
  Object.assign(crash, { armed: true, at: 0, count: 0, crashed: false })
  try { await task() } finally { crash.armed = false }
  return crash.count
}

/** 在第 at 次变更处崩溃；返回是否确实崩溃（at 超过总数时事务正常完成）。 */
async function runCrashingAt(at: number, task: () => Promise<unknown>): Promise<boolean> {
  Object.assign(crash, { armed: true, at, count: 0, crashed: false })
  try { await task() } catch (error) { if (!crash.crashed) throw error } finally { crash.armed = false }
  return crash.crashed
}

/** 目录仍在即表示楼层未被完整回滚；恢复就是对这些楼层重新回滚。 */
async function pendingFloors(floors: string[]): Promise<string[]> {
  const names = await readdir(join(root, WAL_DIR)).catch(() => [] as string[])
  return floors.filter((floor) => names.includes(floor.replace(/[^A-Za-z0-9_.-]/g, '_')))
}

async function recover(floors: string[]): Promise<void> {
  const pending = await pendingFloors(floors)
  if (pending.length) await open().wal.rollbackAfter(pending, root)
}

/**
 * 每轮在全新目录中重跑，避免上一轮崩溃遗留影响下一轮。准备步骤带 fsync 较慢，
 * 只在模板目录执行一次，之后每轮复制模板（复制不经崩溃注入）。
 */
async function template(prepare: () => Promise<void>): Promise<() => Promise<void>> {
  await rm(root, { recursive: true, force: true })
  root = await mkdtemp(join(tmpdir(), 'tavern-crash-'))
  await seed()
  await prepare()
  const source = root
  const copies: string[] = []
  return async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-crash-'))
    copies.push(root)
    await rm(root, { recursive: true, force: true })
    await cp(source, root, { recursive: true })
    // 上一轮副本立即清理，避免临时目录堆积。
    while (copies.length > 1) await rm(copies.shift()!, { recursive: true, force: true })
  }
}

describe('WAL 崩溃矩阵', () => {
  it('楼层写入任意一步崩溃后，回滚未完成楼层可逐字节恢复事务前状态', async () => {
    const fresh = await template(async () => {})
    const before = await snapshot()
    await fresh()
    const total = await countMutations(() => floorTransaction(FLOOR, 'x'))
    expect(total).toBeGreaterThan(10)

    let orphans = 0
    for (let at = 1; at <= total + 1; at++) {
      await fresh()
      const crashed = await runCrashingAt(at, () => floorTransaction(FLOOR, 'x'))
      expect(crashed, `第 ${at} 步`).toBe(at <= total)
      await recover([FLOOR])
      const after = await snapshot()
      expect(after.files, `第 ${at} 步崩溃后恢复`).toEqual(before.files)
      expect(await pendingFloors([FLOOR]), `第 ${at} 步`).toEqual([])
      // 真实崩溃不执行 atomicWrite 的 finally 清理；遗留临时文件不属于业务内容，
      // 超龄后由打开工作区时的回收清除（含 WAL 目录内的遗留）。
      orphans += after.orphans.length
      await sweepOrphanTemps(root, { now: Date.now() + 2 * 60 * 60 * 1000 })
      expect((await snapshot()).orphans, `第 ${at} 步回收后`).toEqual([])
      expect(await readdir(join(root, WAL_DIR), { recursive: true }).catch(() => [] as string[]),
        `第 ${at} 步 WAL 回收后`).not.toContainEqual(expect.stringMatching(/\.tmp$/))
    }
    expect(orphans).toBeGreaterThan(0)
  }, 60_000)

  it('回滚任意一步崩溃后，重启再回滚可完成，恢复过程再次崩溃也不丢失进度', async () => {
    await seed()
    const before = await snapshot()
    const fresh = await template(() => floorTransaction(FLOOR, 'x'))
    expect((await snapshot()).files).not.toEqual(before.files)
    await fresh()
    const total = await countMutations(() => open().wal.rollbackFloor(FLOOR, root))
    expect(total).toBeGreaterThan(5)

    for (let first = 1; first <= total; first++) {
      // 恢复不会比首次回滚做更多变更；total + 1 表示恢复过程不再崩溃。
      const seconds = first % 8 === 1 || first === total || FULL ? [...points(total, 8), total + 1] : [total + 1]
      for (const second of seconds) {
        await fresh()
        expect(await runCrashingAt(first, () => open().wal.rollbackFloor(FLOOR, root)), `首次第 ${first} 步`).toBe(true)
        await runCrashingAt(second, () => recover([FLOOR]))
        await recover([FLOOR])
        const label = `首次第 ${first} 步、恢复第 ${second} 步崩溃`
        expect((await snapshot()).files, label).toEqual(before.files)
        expect(await pendingFloors([FLOOR]), label).toEqual([])
      }
    }
  }, FULL ? 3_600_000 : 120_000)

  it('多层回退在任意一步崩溃后，重启重新回退可撤销全部楼层', async () => {
    await seed()
    const before = await snapshot()
    const fresh = await template(async () => { await floorTransaction(FLOOR, 'x'); await floorTransaction(LATER, 'yy') })
    await fresh()
    const total = await countMutations(() => open().wal.rollbackAfter([FLOOR, LATER], root))

    for (const at of points(total, 3)) {
      await fresh()
      expect(await runCrashingAt(at, () => open().wal.rollbackAfter([FLOOR, LATER], root)), `第 ${at} 步`).toBe(true)
      await recover([FLOOR, LATER])
      expect((await snapshot()).files, `第 ${at} 步崩溃后恢复`).toEqual(before.files)
      expect(await pendingFloors([FLOOR, LATER]), `第 ${at} 步`).toEqual([])
    }
  }, FULL ? 600_000 : 60_000)
})
