/**
 * 原子写临时文件回收：新短名称与旧 `<目标>.<uuid>.tmp` 在启动及首次打开角色/剧情时清理。
 * 只删本模块命名格式且超龄的文件，新写入中的临时文件、相似名称的用户文件与正文保持原样；
 * 角色根不越过 stories/，兄弟剧情等到各自打开时才清理。全部使用临时目录与手写数据。
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORPHAN_TEMP_MAX_AGE_MS, sweepOrphanTemps } from '../src/state/atomicWrite.js'
import { resolveConfig } from '../src/node/config.js'
import { tavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'

const UUID = '0f8e2a3b-1c4d-4e5f-8a9b-0c1d2e3f4a5b'
const orphanName = (target: string) => `${target}.${UUID}.tmp`

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'tavern-orphans-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

/** 写文件并把修改时间调到 ageMs 之前。 */
async function file(path: string, ageMs = 0, body = 'x'): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  const at = new Date(Date.now() - ageMs)
  await utimes(path, at, at)
  return path
}
const old = ORPHAN_TEMP_MAX_AGE_MS + 60_000

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1).replace(/\\/g, '/'))
    .sort()
}

describe('sweepOrphanTemps', () => {
  it('只删除超龄的原子写临时文件，保留正在写入的临时文件与相似名称', async () => {
    await file(join(home, 'notes/a.md'), old, '正文')
    await file(join(home, 'notes', orphanName('a.md')), old)
    await file(join(home, 'state/wal/f1', orphanName('meta.json')), old)
    await file(join(home, 'notes', orphanName('b.md')), 1_000)
    await file(join(home, 'notes/user.tmp'), old)
    await file(join(home, 'notes/a.md.not-a-uuid.tmp'), old)

    expect(await sweepOrphanTemps(home)).toBe(2)
    expect(await names(home)).toEqual([
      'notes/a.md', 'notes/a.md.not-a-uuid.tmp', `notes/${orphanName('b.md')}`, 'notes/user.tmp',
    ])
  })

  it('skipDir 排除整棵子树，目录不存在视为无事可做', async () => {
    await file(join(home, 'stories/s1', orphanName('x.json')), old)
    await file(join(home, orphanName('card.json')), old)
    expect(await sweepOrphanTemps(home, { skipDir: rel => rel === 'stories' })).toBe(1)
    expect(await names(home)).toEqual([`stories/s1/${orphanName('x.json')}`])
    expect(await sweepOrphanTemps(join(home, 'missing'))).toBe(0)
  })

  it('同时回收新短名称与旧名称，保留新鲜短名称和用户相似文件', async () => {
    const short = `.dsh-tavern-write.${UUID}.tmp`
    await file(join(home, 'state', short), old)
    await file(join(home, 'notes', orphanName('long-note.md')), old)
    await file(join(home, 'memory', short), 1_000)
    await file(join(home, 'state/.dsh-tavern-write.not-a-uuid.tmp'), old, '用户文件')
    expect(await sweepOrphanTemps(home)).toBe(2)
    expect(await names(home)).toEqual([`memory/${short}`, 'state/.dsh-tavern-write.not-a-uuid.tmp'])
  })
})

describe('TavernState 打开时回收', () => {
  it('启动清理绑定与资产库但不深入角色目录，角色与剧情在首次打开时各自清理', async () => {
    const paths = tavernPaths(home)
    const cardId = 'orphan-card-a1b2c3d4'
    const cardRoot = join(paths.characters, cardId)
    const storyId = 'story-00000000-0000-4000-8000-000000000002'
    const sibling = 'story-00000000-0000-4000-8000-000000000003'
    await file(join(paths.sessions, orphanName('s.json')), old)
    await file(join(paths.presets, orphanName('p.json')), old)
    await file(join(cardRoot, 'card.json'), 0, JSON.stringify({ name: '回收' }))
    await file(join(cardRoot, orphanName('card.json')), old)
    for (const id of [storyId, sibling]) {
      await file(join(cardRoot, 'stories', id, 'story.json'), 0, JSON.stringify({
        version: 1, id, sessionId: `session-${id}`, createdAt: new Date(0).toISOString(), migrated: false,
      }))
      await file(join(cardRoot, 'stories', id, 'memory', orphanName('m.md')), old)
    }
    const warnings: string[] = []
    const state = new TavernState(paths, () => resolveConfig({}), message => warnings.push(message))

    await state.init()
    expect(await names(paths.sessions)).toEqual([])
    expect(await names(paths.presets)).toEqual([])
    expect(await names(cardRoot)).toContain(orphanName('card.json'))

    await state.workspace(cardId)
    expect(await names(cardRoot)).not.toContain(orphanName('card.json'))
    expect(await names(join(cardRoot, 'stories', storyId))).toContain(`memory/${orphanName('m.md')}`)

    await state.storyWorkspace(cardId, storyId)
    expect(await names(join(cardRoot, 'stories', storyId))).toEqual(['story.json'])
    expect(await names(join(cardRoot, 'stories', sibling))).toContain(`memory/${orphanName('m.md')}`)
    expect(warnings).toEqual([])
  })
})
