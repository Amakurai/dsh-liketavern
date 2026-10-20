/**
 * S4 回归：atomicWrite 在 rename 后对父目录做尽力而为的 fsync（Windows 优雅降级）。
 *
 * 目录 fsync 只影响崩溃一致性：open 目录失败（部分平台/权限）或 sync 失败（Windows 返回 EPERM）
 * 都必须静默降级，不能把已经提交的写入改报为失败，也不能留下临时文件。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWrite } from '../../src/state/atomicWrite.js'

const faults = vi.hoisted(() => ({
  dirOpen: 'ok' as 'ok' | 'fail',
  dirSync: 'ok' as 'ok' | 'fail',
  dirOpens: 0,
  dirSyncs: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0])
      const isDirectory = args[1] === 'r' && await actual.stat(target).then((info) => info.isDirectory(), () => false)
      if (isDirectory) {
        faults.dirOpens += 1
        if (faults.dirOpen === 'fail') throw Object.assign(new Error('测试：目录打开失败'), { code: 'EPERM' })
        const handle = await actual.open(...args)
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          faults.dirSyncs += 1
          if (faults.dirSync === 'fail') throw Object.assign(new Error('测试：目录同步失败'), { code: 'EPERM' })
          await sync()
        }
        return handle
      }
      return actual.open(...args)
    },
  }
})

let root: string
beforeEach(async () => {
  Object.assign(faults, { dirOpen: 'ok', dirSync: 'ok', dirOpens: 0, dirSyncs: 0 })
  root = await mkdtemp(join(tmpdir(), 'audit-atomic-dirsync-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('atomicWrite 目录同步', () => {
  it('rename 后尝试同步父目录，提交成功且无临时文件残留', async () => {
    const path = join(root, 'note.md')
    await writeFile(path, '旧正文')
    await atomicWrite(path, '新正文')
    expect(await readFile(path, 'utf8')).toBe('新正文')
    expect(faults.dirOpens).toBeGreaterThan(0)
    expect(faults.dirSyncs).toBeGreaterThan(0)
    expect(await readdir(root)).toEqual(['note.md'])
  })

  it('目录 sync 失败（Windows EPERM）时静默降级，不把已提交的写入改报为失败', async () => {
    const path = join(root, 'note.md')
    await writeFile(path, '旧正文')
    faults.dirSync = 'fail'
    await expect(atomicWrite(path, '新正文')).resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('新正文')
    expect(faults.dirSyncs).toBeGreaterThan(0)
    expect(await readdir(root)).toEqual(['note.md'])
  })

  it('目录 open 失败时静默降级，新建目录链仍可落盘', async () => {
    const path = join(root, 'state', 'wal', 'f1', 'records.jsonl')
    faults.dirOpen = 'fail'
    await expect(atomicWrite(path, '{}\n')).resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('{}\n')
    expect(await readdir(join(root, 'state', 'wal', 'f1'))).toEqual(['records.jsonl'])
  })
})
