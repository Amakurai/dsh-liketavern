/** 原子写入故障边界：合法长文件名、临时文件所有权、原始错误与提交成功回执，使用真实临时文件系统。 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { atomicWrite } from '../src/state/atomicWrite.js'

const faults = vi.hoisted(() => ({
  collision: false, tempPath: '', cleanupCalls: 0,
  writeError: undefined as Error | undefined,
  syncError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  renameError: undefined as Error | undefined,
  cleanupError: undefined as Error | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] !== 'wx') return actual.open(...args)
      faults.tempPath = String(args[0])
      if (faults.collision) {
        // 模拟独占创建之前已有其它写入占位；该文件从未属于当前调用。
        await actual.writeFile(args[0], '其它写入的临时数据')
        throw Object.assign(new Error('临时文件被占用'), { code: 'EEXIST' })
      }
      const handle = await actual.open(...args)
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        if (faults.writeError) throw faults.writeError
        return write(...writeArgs)
      }
      handle.sync = async () => {
        if (faults.syncError) throw faults.syncError
        await sync()
      }
      handle.close = async () => {
        await close()
        if (faults.closeError) throw faults.closeError
      }
      return handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.renameError) throw faults.renameError
      return actual.rename(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      faults.cleanupCalls++
      if (faults.cleanupError) throw faults.cleanupError
      return actual.rm(...args)
    },
  }
})

let root: string
const reset = () => Object.assign(faults, {
  collision: false, tempPath: '', cleanupCalls: 0,
  writeError: undefined, syncError: undefined, closeError: undefined, renameError: undefined, cleanupError: undefined,
})
beforeEach(async () => { reset(); root = await mkdtemp(join(tmpdir(), 'tavern-atomic-boundary-')) })
afterEach(async () => { reset(); await rm(root, { recursive: true, force: true }) })

it.each([
  { label: 'ASCII 255 字节', name: `${'n'.repeat(252)}.md` },
  { label: '中文 254 字节', name: `${'界'.repeat(83)}.json` },
])('$label 的合法目标可以更新，临时名不占用目标文件名的剩余长度', async ({ name }) => {
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
  const path = join(root, name)
  // 原文件可由导入或外部编辑器写入；原子更新必须同样支持它的合法文件名。
  await writeFile(path, '更新前')
  await atomicWrite(path, '更新后')
  expect(await readFile(path, 'utf8')).toBe('更新后')
  expect(await readdir(root)).toEqual([name])
})

it('独占创建冲突不删除其它写入已占用的文件，也不修改原正文', async () => {
  const path = join(root, 'note.md')
  await writeFile(path, '原正文')
  faults.collision = true
  await expect(atomicWrite(path, '新正文')).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path, 'utf8')).toBe('原正文')
  expect(await readFile(faults.tempPath, 'utf8')).toBe('其它写入的临时数据')
  expect(faults.cleanupCalls).toBe(0)
})

it.each(['write', 'sync', 'close', 'rename'] as const)('%s 失败时保留原正文，关闭或清理失败不能掩盖最先发生的错误', async phase => {
  const path = join(root, 'note.md'), primary = new Error(`原始 ${phase} 故障`)
  await writeFile(path, '原正文')
  faults[`${phase}Error`] = primary
  if (phase === 'write' || phase === 'sync') faults.closeError = new Error('后续关闭失败')
  faults.cleanupError = new Error('后续清理失败')
  await expect(atomicWrite(path, '新正文')).rejects.toBe(primary)
  expect(await readFile(path, 'utf8')).toBe('原正文')
  expect(faults.cleanupCalls).toBe(1)
  expect(await readdir(root)).toContain(basename(faults.tempPath))
})

it('正文替换成功后直接确认成功，不让多余清理把已提交的修改报告为失败', async () => {
  const path = join(root, 'note.md')
  await writeFile(path, '原正文')
  faults.cleanupError = new Error('不应执行的清理')
  await expect(atomicWrite(path, '已提交正文')).resolves.toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe('已提交正文')
  expect(await readdir(root)).toEqual(['note.md'])
  expect(faults.cleanupCalls).toBe(0)
})

it('发布前失败仍清理当前调用创建的临时文件，原正文完整保留', async () => {
  const path = join(root, 'note.md'), failure = new Error('同步失败')
  await writeFile(path, '原正文')
  faults.syncError = failure
  await expect(atomicWrite(path, '新正文')).rejects.toBe(failure)
  expect(await readFile(path, 'utf8')).toBe('原正文')
  expect(await readdir(root)).toEqual(['note.md'])
})
