/**
 * 库世界书编辑的文件定位协议：真实临时 FS、服务入口与面板同一 exportLorebook 联合回归。
 * 修订保存只编辑选中的实际文件，保留原内部名称；净化、后缀、重复身份、删除和并发
 * 都不能把编辑改成新导入，也不能借有效版本覆盖另一文件或改写内部身份。
 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { exportLorebook, parseLorebook } from '../src/state/lorebook.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const prefix = join(tmpdir(), 'tavern-lore-file-id-')
const book = (name: string, content: string) => ({ name, entries: { one: { key: ['灯塔'], content } } })
let root: string
let state: TavernState
let service: TavernService
let fs: WorkspaceFs

beforeEach(async () => {
  root = await mkdtemp(prefix)
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  fs = new WorkspaceFs(root, null)
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state,
    { get: () => ({}), update: async () => {} } as TavernSettingsScope)
})

afterEach(async () => {
  if (!resolve(root).startsWith(resolve(prefix))) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})

function edited(json: unknown, id: string, content: string): unknown {
  return exportLorebook(parseLorebook(json, { source: 'global', sourceRef: id }).map(entry => ({ ...entry, content })), id)
}

async function contents(id: string): Promise<string[]> {
  return (await state.loadLorebookEntries(id, 'global')).map(entry => entry.content)
}

describe('库世界书的编辑文件身份', () => {
  it.each(['my book', 'my?book'])('原始名称 %s 净化后，面板导出的无 name 正文仍保存到选中文件', async name => {
    const id = await state.saveLorebook(name, book(name, '原正文'))
    const snapshot = await service.getLorebook({ name: id })
    const json = edited(snapshot.json, id, '面板新正文')
    expect(json).not.toHaveProperty('name')
    const saved = await service.saveLorebook({ name: id, json, expectedRevision: snapshot.revision })
    expect(saved.name).toBe(id)
    const current = await service.getLorebook({ name: id })
    expect(current.json).toMatchObject({ name })
    expect(current.revision).toBe(saved.revision)
    expect(await contents(id)).toEqual(['面板新正文'])
    expect(await state.listLorebooks()).toEqual([id])
  })

  it.each([false, true])('碰撞后缀编辑保留文件 ID（基础槽删除：%s）', async deleteBase => {
    const base = await state.saveLorebook('port book', book('port book', '另一书正文'))
    const id = await state.saveLorebook('port?book', book('port?book', '选中书正文'))
    const snapshot = await service.getLorebook({ name: id })
    if (deleteBase) await state.deleteLorebook(base)
    const saved = await service.saveLorebook({ name: id, json: edited(snapshot.json, id, '后缀新正文'), expectedRevision: snapshot.revision })
    expect(saved.name).toBe(id)
    expect((await service.getLorebook({ name: id })).json).toMatchObject({ name: 'port?book' })
    expect(await contents(id)).toEqual(['后缀新正文'])
    expect(await contents(base)).toEqual(deleteBase ? [] : ['另一书正文'])
    expect((await state.listLorebooks()).sort()).toEqual((deleteBase ? [id] : [base, id]).sort())
  })

  it.each([false, true])('重复内部身份仍严格保存选中后缀（两个文件修订相同：%s）', async sameRevision => {
    const base = await state.saveLorebook('dup book', book('dup book', '原基础正文'))
    const id = `${base}-2`
    await fs.writeText(`library/lorebooks/${id}.json`, JSON.stringify(book('dup book', sameRevision ? '原基础正文' : '原后缀正文')))
    const snapshot = await service.getLorebook({ name: id })
    const baseBefore = await fs.readText(`library/lorebooks/${base}.json`)
    const saved = await service.saveLorebook({ name: id, json: edited(snapshot.json, id, '只修改选中后缀'), expectedRevision: snapshot.revision })
    expect(saved.name).toBe(id)
    expect(await fs.readText(`library/lorebooks/${base}.json`)).toBe(baseBefore)
    expect(await contents(id)).toEqual(['只修改选中后缀'])
    expect((await state.listLorebooks()).sort()).toEqual([base, id].sort())
  })

  it('选中目标删除后不搜索同身份副本，也不重建文件', async () => {
    const base = await state.saveLorebook('dup book', book('dup book', '幸存正文'))
    const id = `${base}-2`
    await fs.writeText(`library/lorebooks/${id}.json`, JSON.stringify(book('dup book', '幸存正文')))
    const snapshot = await service.getLorebook({ name: id })
    const before = await fs.readText(`library/lorebooks/${base}.json`)
    await state.deleteLorebook(id)
    await expect(service.saveLorebook({ name: id, json: edited(snapshot.json, id, '不可复活'), expectedRevision: snapshot.revision }))
      .rejects.toThrow('修改或删除')
    expect(await fs.readText(`library/lorebooks/${base}.json`)).toBe(before)
    expect(await fs.readText(`library/lorebooks/${id}.json`)).toBeNull()
    expect(await state.listLorebooks()).toEqual([base])
  })

  it('旧修订与同修订并发编辑仍严格拒绝覆盖', async () => {
    const id = await state.saveLorebook('my book', book('my book', '原正文'))
    const snapshot = await service.getLorebook({ name: id })
    const results = await Promise.allSettled(['窗口 A', '窗口 B'].map(content => service.saveLorebook({
      name: id, json: edited(snapshot.json, id, content), expectedRevision: snapshot.revision,
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = ['窗口 A', '窗口 B'][results.findIndex(result => result.status === 'fulfilled')]
    await expect(service.saveLorebook({ name: id, json: edited(snapshot.json, id, '过期正文'), expectedRevision: snapshot.revision }))
      .rejects.toThrow('修改或删除')
    expect(await contents(id)).toEqual([winner])
    expect(await state.listLorebooks()).toEqual([id])
  })

  it.each(['', '.', '..', '../my_book', 'my/book', 'my\\book', 'my book', 'my_book.json', 'my_b'])('非法或不存在的文件 ID %j 不被净化成另一目标', async target => {
    const id = await state.saveLorebook('my book', book('my book', '必须保留的正文'))
    const snapshot = await service.getLorebook({ name: id })
    const before = await fs.readText(`library/lorebooks/${id}.json`)
    await expect(service.saveLorebook({ name: target, json: edited(snapshot.json, id, '不可写入'), expectedRevision: snapshot.revision }))
      .rejects.toThrow(/非法|修改或删除/)
    expect(await fs.readText(`library/lorebooks/${id}.json`)).toBe(before)
    expect(await service.getLorebook({ name: id })).toEqual(snapshot)
    expect(await state.listLorebooks()).toEqual([id])
  })

  it('显式内部名称更改被拒绝且保留原正文和修订', async () => {
    const id = await state.saveLorebook('my book', book('my book', '原正文'))
    const snapshot = await service.getLorebook({ name: id })
    const json = { ...(edited(snapshot.json, id, '非法更名正文') as object), name: '另一身份' }
    await expect(service.saveLorebook({ name: id, json, expectedRevision: snapshot.revision })).rejects.toThrow('名称不可修改')
    expect(await service.getLorebook({ name: id })).toEqual(snapshot)
    expect(await contents(id)).toEqual(['原正文'])
    expect(await state.listLorebooks()).toEqual([id])
  })

  it('新建仍原子拒绝同身份覆盖，原始名称导入仍编辑同身份文件', async () => {
    const created = await service.saveLorebook({ name: 'my book', json: { entries: { one: { key: ['灯塔'], content: '新建正文' } } }, expectedRevision: null })
    await expect(service.saveLorebook({ name: 'my book', json: book('my book', '不可当新建覆盖'), expectedRevision: null }))
      .rejects.toThrow('修改或删除')
    expect(await service.importLorebook({ name: 'my book', json: book('my book', '重新导入正文') })).toMatchObject({ name: created.name })
    expect(await contents(created.name)).toEqual(['重新导入正文'])
    expect(await state.listLorebooks()).toEqual([created.name])
  })

  it.runIf(process.platform === 'win32')('Windows 别名编辑返回实际文件拼写并使别名热缓存失效', async () => {
    const id = await state.saveLorebook('Mixed Book', book('Mixed Book', '原正文'))
    const actual = id.toUpperCase(), alias = id.toLowerCase()
    await rename(join(root, `library/lorebooks/${id}.json`), join(root, 'library/lorebooks/moving.json'))
    await rename(join(root, 'library/lorebooks/moving.json'), join(root, `library/lorebooks/${actual}.JSON`))
    expect(await contents(alias)).toEqual(['原正文'])
    const snapshot = await service.getLorebook({ name: alias })
    const saved = await service.saveLorebook({ name: alias, json: edited(snapshot.json, alias, '别名编辑正文'), expectedRevision: snapshot.revision })
    expect(saved.name).toBe(actual)
    expect(await contents(alias)).toEqual(['别名编辑正文'])
    expect(await contents(actual)).toEqual(['别名编辑正文'])
    expect((await service.getLorebook({ name: actual })).json).toMatchObject({ name: 'Mixed Book' })
  })
})
