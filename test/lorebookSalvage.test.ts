/**
 * 永久删除角色时抢救内嵌世界书的真实文件系统回归。
 * 抢救必须新建独立副本：并发导入先提交、旧抢救后缀仍在或 Windows 大小写别名占位，
 * 都不能把库中既有正文当作同身份编辑覆盖；抢救写入失败则保留原角色可重试。
 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const book = (content: string) => ({ name: 'port-book', entries: { one: { key: ['灯塔'], content } } })
let root: string
let state: TavernState
let fs: WorkspaceFs

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-lore-salvage-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => resolveConfig({ cascadeDeleteEmbeddedBook: false }))
  await state.init()
  fs = new WorkspaceFs(root, null)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (!resolve(root).startsWith(resolve(join(tmpdir(), 'tavern-lore-salvage-')))) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})

async function archivedCard(content: string): Promise<string> {
  const { cardId } = await state.createCharacter('灯塔守卫')
  await state.saveCharacterLorebook(cardId, book(content))
  await state.archiveCharacter(cardId)
  return cardId
}

async function contents(id: string): Promise<string[]> {
  return (await state.loadLorebookEntries(id, 'global')).map(entry => entry.content)
}

describe('内嵌世界书的独立抢救副本', () => {
  it('并发导入在持有资产锁时先提交，永久删除随后另建抢救副本', async () => {
    const cardId = await archivedCard('角色内嵌旧正文')
    const writing = gate(), releaseWrite = gate(), cardRead = gate(), allocationRead = gate()
    const originalWrite = WorkspaceFs.prototype.writeText
    vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (path, content) {
      if (this.root === root && path === 'library/lorebooks/port-book.json' && content.includes('用户刚导入的新正文')) {
        writing.release()
        await releaseWrite.promise
      }
      return originalWrite.call(this, path, content)
    })
    const originalBookRead = state.loadCharacterLorebookRaw.bind(state)
    vi.spyOn(state, 'loadCharacterLorebookRaw').mockImplementation(async id => {
      const value = await originalBookRead(id)
      cardRead.release()
      return value
    })
    // 导入正文尚未替换时目录确实为空；同步提供该快照，让旧实现的锁外分配窗口可重复触发。
    vi.spyOn(state, 'listLorebooks').mockImplementation(async () => { allocationRead.release(); return [] })
    const importing = state.saveLorebook('port-book', book('用户刚导入的新正文'))
    await writing.promise
    const deleting = state.deleteCharacter(cardId)
    try {
      await cardRead.promise
      await Promise.race([allocationRead.promise, new Promise<void>(resolve => setImmediate(resolve))])
    } finally {
      releaseWrite.release()
    }
    const [imported, deleted] = await Promise.all([importing, deleting])
    expect(imported).toBe('port-book')
    expect(await contents(imported)).toEqual(['用户刚导入的新正文'])
    expect(deleted.salvagedLorebook).toBe('port-book-2')
    expect(await contents(deleted.salvagedLorebook!)).toEqual(['角色内嵌旧正文'])
    expect(await state.loadCharacter(cardId)).toBeNull()
  })

  it('基础槽删除后已有同名抢救后缀仍保留，下一次抢救使用空基础槽', async () => {
    await state.saveLorebook('port-book', book('被删除的基础占位'))
    await state.saveLorebook('port-book-2', book('先前角色的抢救正文'))
    await state.deleteLorebook('port-book')
    await contents('port-book-2')
    const cardId = await archivedCard('本次角色的抢救正文')
    const deleted = await state.deleteCharacter(cardId)
    expect(await contents('port-book-2')).toEqual(['先前角色的抢救正文'])
    expect(deleted).toEqual({ salvagedLorebook: 'port-book' })
    expect(await contents('port-book')).toEqual(['本次角色的抢救正文'])
    expect((await fs.list('library/lorebooks')).sort()).toEqual(['port-book-2.json', 'port-book.json'])
  })

  it.runIf(process.platform === 'win32')('Windows 大小写别名占位也不会被抢救覆写', async () => {
    await state.saveLorebook('port-book', book('库中既有正文'))
    await rename(join(root, 'library/lorebooks/port-book.json'), join(root, 'library/lorebooks/moving.json'))
    await rename(join(root, 'library/lorebooks/moving.json'), join(root, 'library/lorebooks/PORT-BOOK.JSON'))
    const cardId = await archivedCard('角色抢救正文')
    const deleted = await state.deleteCharacter(cardId)
    expect(await contents('PORT-BOOK')).toEqual(['库中既有正文'])
    expect(deleted).toEqual({ salvagedLorebook: 'port-book-2' })
    expect(await contents('port-book-2')).toEqual(['角色抢救正文'])
  })

  it('抢救写入失败时仍保留原角色及库中既有正文', async () => {
    await state.saveLorebook('port-book', book('库中既有正文'))
    const cardId = await archivedCard('尚未抢救的正文')
    const originalWrite = WorkspaceFs.prototype.writeText
    vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (path, content) {
      if (this.root === root && path === 'library/lorebooks/port-book-2.json') throw new Error('合成磁盘写入失败')
      return originalWrite.call(this, path, content)
    })
    await expect(state.deleteCharacter(cardId)).rejects.toThrow('合成磁盘写入失败')
    expect(await state.loadCharacterLorebookRaw(cardId)).toMatchObject({ json: book('尚未抢救的正文') })
    expect(await contents('port-book')).toEqual(['库中既有正文'])
    expect(await fs.readText('library/lorebooks/port-book-2.json')).toBeNull()
  })
})
