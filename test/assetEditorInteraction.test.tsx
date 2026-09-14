/** 资产编辑交互回归：真实文件系统与服务适配器覆盖预设身份、收纳与删除失败恢复、导入重试及搜索恢复。 */
import type { ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { PersonasSection } from '../src/client/panel/personas.js'
import { PresetsSection } from '../src/client/panel/presets.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { PersistentEditor } from '../src/client/draftPersistence.js'
import { Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, SearchInput, Tabs, fileToBase64 } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
  IconArchiveOutline20: () => null, IconDownloadOutline16: () => null, IconEditOutline16: () => null, IconFolderOpenOutline16: () => null,
  IconListPenOutline16: () => null, IconTrashOutline16: () => null, IconPlusOutline16: () => null,
  IconRefreshOutline16: () => null,
}))
vi.mock('../src/client/util.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/util.js')>(),
  fileToBase64: vi.fn(async (file: File) => Buffer.from(await file.arrayBuffer()).toString('base64')),
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'test', message } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const mounted: ReactTestRenderer[] = []
const directories: string[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
async function settle(operation: () => void, completed: () => boolean) {
  await act(async () => {
    operation()
    await vi.waitFor(() => expect(completed()).toBe(true))
  })
}
async function click(view: ReactTestRenderer, label: string) {
  await act(async () => view.root.findAllByType(Btn).find(item => item.props.children === label)!.props.onClick())
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-asset-editor-'))
  directories.push(root)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as SettingsScope<TavernConfigRaw>)
  const remote = {
    listPresets: vi.fn(async () => ok(await service.listPresets({}))),
    getPreset: vi.fn(async (request: Parameters<TavernRemote['getPreset']>[0]) => ok(await service.getPreset(request))),
    savePreset: vi.fn(async (request: Parameters<TavernRemote['savePreset']>[0]) => ok(await service.savePreset(request))),
    deletePreset: vi.fn(async (request: Parameters<TavernRemote['deletePreset']>[0]) => ok(await service.deletePreset(request))),
    listCharacters: vi.fn(async () => ok(await service.listCharacters({}))),
    listArchivedCharacters: vi.fn(async () => ok(await service.listArchivedCharacters({}))),
    archiveCharacter: vi.fn(async (request: Parameters<TavernRemote['archiveCharacter']>[0]) => ok(await service.archiveCharacter(request))),
    restoreCharacter: vi.fn(async (request: Parameters<TavernRemote['restoreCharacter']>[0]) => ok(await service.restoreCharacter(request))),
    deleteCharacter: vi.fn(async (request: Parameters<TavernRemote['deleteCharacter']>[0]) => ok(await service.deleteCharacter(request))),
    inspectCharacter: vi.fn(async (request: Parameters<TavernRemote['inspectCharacter']>[0]) => ok(await service.inspectCharacter(request))),
    importCharacter: vi.fn(async (request: Parameters<TavernRemote['importCharacter']>[0]) => ok(await service.importCharacter(request))),
    getAvatar: async () => ok({ dataUrl: null }),
  } as unknown as TavernRemote
  return { state, service, remote }
}
function completed(remoteMethod: (...args: never[]) => unknown) {
  return vi.mocked(remoteMethod).mock.settledResults.at(-1)?.type === 'fulfilled'
}
beforeEach(() => { setTavernLocale('zh'); vi.clearAllMocks() })
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('预设删除使用磁盘身份', () => {
  it('同名净化冲突的预设删除后关闭对应编辑器，删除另一预设不丢当前草稿', async () => {
    const f = await fixture()
    const otherId = await f.state.savePreset({ identifier: 'group?name', name: '另一预设', entries: [] })
    const editingId = await f.state.savePreset({ identifier: 'group/name', name: '正在编辑', entries: [] })
    expect(editingId).not.toBe('group/name')
    expect(editingId).not.toBe(otherId)
    const view = await render(<PresetsSection remote={f.remote} />)
    await settle(() => {}, () => completed(f.remote.listPresets))
    const tile = (name: string) => view.root.findAllByProps({ className: 'dsh-tavern-tile' }).find(item =>
      item.findByProps({ className: 'dsh-tavern-tileName' }).children.join('') === name)!
    await settle(() => tile('正在编辑').props.onClick(), () => completed(f.remote.getPreset))
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '保留我的修改' } }))
    const remove = async (name: string) => {
      await act(async () => tile(name).findAllByType(IconBtn).find(item => item.props.label === t('presets.delete'))!.props.onClick())
      const count = vi.mocked(f.remote.listPresets).mock.calls.length
      await settle(() => view.root.findAllByType(ConfirmDialog).find(item => item.props.open && item.props.danger)!.props.onConfirm(),
        () => vi.mocked(f.remote.listPresets).mock.calls.length > count && completed(f.remote.listPresets))
    }
    await remove('另一预设')
    expect(view.root.findByType('input').props.value).toBe('保留我的修改')
    await remove('正在编辑')
    expect(view.root.findAllByType('fieldset')).toHaveLength(0)
    expect(await f.state.listPresets()).toEqual([])
    expect(f.remote.savePreset).not.toHaveBeenCalled()
  })

  it('自动草稿恢复后仍按保存的磁盘身份关闭已删除预设', async () => {
    const f = await fixture()
    const preset = { identifier: 'draft/name', name: '恢复的预设', entries: [] }
    const id = await f.state.savePreset(preset)
    const draft = { version: 1, fields: { 'presets:editing': { ...preset, name: '恢复的修改' },
      'presets:baseline': JSON.stringify(preset), 'presets:editingId': id } }
    Object.assign(f.remote, { getEditorDraft: async () => ok({ draft: { value: draft } }),
      saveEditorDraft: async () => ok({ saved: true }), deleteEditorDraft: async () => ok({ deleted: true }) })
    const view = await render(<PersistentEditor remote={f.remote} scope="preset-delete-test"><PresetsSection remote={f.remote} /></PersistentEditor>)
    await settle(() => {}, () => completed(f.remote.listPresets))
    expect(view.root.findByType('input').props.value).toBe('恢复的修改')
    await act(async () => view.root.findAllByType(IconBtn).find(item => item.props.label === t('presets.delete'))!.props.onClick())
    await settle(() => view.root.findAllByType(ConfirmDialog).find(item => item.props.open && item.props.danger)!.props.onConfirm(),
      () => vi.mocked(f.remote.listPresets).mock.calls.length === 2 && completed(f.remote.listPresets))
    expect(view.root.findAllByType('fieldset')).toHaveLength(0)
    expect(await f.state.loadPreset(id)).toBeNull()
  })
})

/** 真实文件系统与服务边界：失败不创建资产，保留名称的重试只创建并打开目标世界书。 */
it('世界书新建失败后原地重试，实际目录只新增一次目标文件', async () => {
  const f = await fixture()
  f.remote.listLorebooks = vi.fn(async () => ok(await f.service.listLorebooks({})))
  f.remote.getLorebook = vi.fn(async request => ok(await f.service.getLorebook(request)))
  f.remote.importLorebook = vi.fn(async request => ok(await f.service.importLorebook(request)))
  vi.mocked(f.remote.importLorebook).mockRejectedValueOnce(new Error('模拟连接中断'))
  const view = await render(<LorebooksSection remote={f.remote}/>)
  await click(view, '新建空书')
  const dialog = () => view.root.findAllByType(Dialog).find(item => item.props.open)!
  await act(async () => dialog().findByType('input').props.onChange({ target: { value: '港口重试' } }))
  await click(view, '创建')
  expect(dialog().findByProps({ role: 'alert' }).children.join('')).toContain('模拟连接中断')
  expect(dialog().findByType('input').props.value).toBe('港口重试')
  expect((await f.service.listLorebooks({})).items).toEqual([])
  await settle(() => view.root.findAllByType(Btn).find(item => item.props.children === '创建')!.props.onClick(), () => completed(f.remote.getLorebook))
  expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'library', name: '港口重试' })
  expect((await f.service.listLorebooks({})).items).toEqual(['港口重试'])
  expect((await f.service.getLorebook({ name: '港口重试' })).json).toEqual({ name: '港口重试', entries: {} })
  expect(f.remote.importLorebook).toHaveBeenCalledTimes(2)
})

describe('角色卡导入失败恢复', () => {
  const file = () => new File([JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: '测试旅人', description: '手写测试卡', first_mes: '你好', character_book: { name: '测试港口', entries: [
      { id: 1, keys: ['港口'], content: '测试设定', enabled: true, insertion_order: 10 },
    ] },
  } })], 'traveler.json', { type: 'application/json' })
  const dialog = (view: ReactTestRenderer) => view.root.findAllByType(Dialog).find(item => item.props.title === t('characters.importBook.title'))
  const choose = (view: ReactTestRenderer, importBook: boolean) => dialog(view)!.findAllByType(Button).find(item =>
    item.props.children === t(importBook ? 'characters.importBook.import' : 'characters.importBook.skip'))!

  it.each([true, false])('导入失败后原地重试，沿用文件并尊重内嵌书选择：%s', async importBook => {
    const f = await fixture(), pending = deferred<Envelope<Awaited<ReturnType<TavernService['importCharacter']>>>>()
    vi.mocked(f.remote.importCharacter).mockImplementationOnce(() => importBook ? pending.promise : Promise.reject(new Error('导入暂时失败')))
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => view.root.findByType(FileBtn).props.onFile(file()), () => completed(f.remote.inspectCharacter))
    await act(async () => choose(view, importBook).props.onClick())
    if (importBook) await act(async () => pending.resolve(fail('导入暂时失败')))
    expect(dialog(view)).toBeDefined()
    expect(dialog(view)!.findAllByType(Err).some(item => item.props.message === '导入暂时失败')).toBe(true)
    expect(await f.state.listCharacters()).toHaveLength(0)
    expect(choose(view, importBook).props.disabled).toBe(false)
    await settle(() => choose(view, importBook).props.onClick(), () => completed(f.remote.importCharacter))
    expect(dialog(view)).toBeUndefined()
    expect(f.remote.inspectCharacter).toHaveBeenCalledOnce()
    expect(fileToBase64).toHaveBeenCalledOnce()
    const items = await f.state.listCharacters()
    expect(items).toHaveLength(1)
    expect(items[0]!.hasCharacterBook).toBe(importBook)
    expect(vi.mocked(f.remote.importCharacter).mock.calls.map(([request]) => request.importWorldBook)).toEqual([importBook, importBook])
  })

  it('导入进行中不能关闭确认框丢失文件，失败后可以取消', async () => {
    const f = await fixture(), pending = deferred<Envelope<Awaited<ReturnType<TavernService['importCharacter']>>>>()
    vi.mocked(f.remote.importCharacter).mockImplementationOnce(() => pending.promise)
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => view.root.findByType(FileBtn).props.onFile(file()), () => completed(f.remote.inspectCharacter))
    await act(async () => choose(view, true).props.onClick())
    expect(choose(view, true).props.disabled).toBe(true)
    await act(async () => dialog(view)!.props.onClose())
    expect(dialog(view)).toBeDefined()
    await act(async () => pending.resolve(fail('导入暂时失败')))
    await act(async () => dialog(view)!.props.onClose())
    expect(dialog(view)).toBeUndefined()
    expect(await f.state.listCharacters()).toHaveLength(0)
  })
})

/** 收纳是可逆的列表迁移；只有收纳箱展示永久删除入口，不能再从活跃列表误触清空工作区。 */
describe('角色卡收纳箱交互', () => {
  it('活跃卡可收纳、恢复并在收纳箱永久删除，两个列表和危险入口保持分离', async () => {
    const f = await fixture()
    const created = await f.state.createCharacter('收纳测试角色')
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => {}, () => completed(f.remote.listCharacters))

    expect(view.root.findAllByProps({ 'aria-label': t('characters.card.archive') })).toHaveLength(1)
    expect(view.root.findAllByProps({ 'aria-label': t('characters.card.deletePermanently') })).toHaveLength(0)
    await settle(
      () => view.root.findByProps({ 'aria-label': t('characters.card.archive') }).props.onClick({ stopPropagation: () => {} }),
      () => vi.mocked(f.remote.listCharacters).mock.calls.length === 2 && completed(f.remote.listCharacters),
    )
    expect(view.root.findAllByProps({ className: 'dsh-tavern-charCard' })).toHaveLength(0)

    await settle(
      () => view.root.findByType(Tabs).props.onChange('archived'),
      () => completed(f.remote.listArchivedCharacters),
    )
    expect(view.root.findAllByProps({ 'aria-label': t('characters.card.restore') })).toHaveLength(1)
    expect(view.root.findAllByProps({ 'aria-label': t('characters.card.deletePermanently') })).toHaveLength(1)
    await settle(
      () => view.root.findByProps({ 'aria-label': t('characters.card.restore') }).props.onClick({ stopPropagation: () => {} }),
      () => vi.mocked(f.remote.listArchivedCharacters).mock.calls.length === 2 && completed(f.remote.listArchivedCharacters),
    )
    expect(view.root.findAllByProps({ className: 'dsh-tavern-charCard is-archived' })).toHaveLength(0)

    await settle(
      () => view.root.findByType(Tabs).props.onChange('active'),
      () => vi.mocked(f.remote.listCharacters).mock.calls.length === 3 && completed(f.remote.listCharacters),
    )
    expect(view.root.findAllByProps({ className: 'dsh-tavern-charCard' })).toHaveLength(1)

    await settle(
      () => view.root.findByProps({ 'aria-label': t('characters.card.archive') }).props.onClick({ stopPropagation: () => {} }),
      () => vi.mocked(f.remote.listCharacters).mock.calls.length === 4 && completed(f.remote.listCharacters),
    )
    await settle(
      () => view.root.findByType(Tabs).props.onChange('archived'),
      () => vi.mocked(f.remote.listArchivedCharacters).mock.calls.length === 3 && completed(f.remote.listArchivedCharacters),
    )
    await act(async () => view.root.findByProps({ 'aria-label': t('characters.card.deletePermanently') }).props.onClick({ stopPropagation: () => {} }))
    const confirmation = view.root.findAllByType(ConfirmDialog).find(item => item.props.open && item.props.danger)!
    expect(confirmation.props.confirmLabel).toBe(t('characters.deletePermanently.confirm'))
    await settle(
      () => confirmation.props.onConfirm(),
      () => completed(f.remote.deleteCharacter) && vi.mocked(f.remote.listArchivedCharacters).mock.calls.length === 4,
    )
    expect(await f.state.loadCharacter(created.cardId)).toBeNull()
    expect((await f.state.listArchivedCharacters())).toEqual([])
  })

  it.each(['envelope', 'transport'] as const)('永久删除 %s 失败后关闭确认框、显示错误并刷新，保留卡片供重试', async failure => {
    const f = await fixture()
    const created = await f.state.createCharacter(`删除失败-${failure}`)
    await f.state.archiveCharacter(created.cardId)
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => view.root.findByType(Tabs).props.onChange('archived'), () => completed(f.remote.listArchivedCharacters))
    const message = '模拟删除失败，角色仍保留'
    if (failure === 'envelope') vi.mocked(f.remote.deleteCharacter).mockResolvedValueOnce(fail(message))
    else vi.mocked(f.remote.deleteCharacter).mockRejectedValueOnce(new Error(message))
    const requestDelete = async () => {
      await act(async () => view.root.findByProps({ 'aria-label': t('characters.card.deletePermanently') }).props.onClick({ stopPropagation: () => {} }))
      const count = vi.mocked(f.remote.listArchivedCharacters).mock.calls.length
      await settle(
        () => view.root.findAllByType(ConfirmDialog).find(item => item.props.open && item.props.danger)!.props.onConfirm(),
        () => vi.mocked(f.remote.listArchivedCharacters).mock.calls.length > count && completed(f.remote.listArchivedCharacters),
      )
    }
    await requestDelete()
    expect(view.root.findAllByType(ConfirmDialog).filter(item => item.props.open)).toHaveLength(0)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain(message)
    expect(view.root.findAllByProps({ className: 'dsh-tavern-charCard is-archived' })).toHaveLength(1)
    expect(await f.state.loadCharacter(created.cardId)).not.toBeNull()
    await requestDelete()
    expect(await f.state.loadCharacter(created.cardId)).toBeNull()
  })

  it.each(['archive', 'restore'] as const)('%s 已落盘但回执断连时，刷新列表以免继续操作过期卡片', async operation => {
    const f = await fixture()
    const created = await f.state.createCharacter(`回执丢失-${operation}`)
    if (operation === 'restore') await f.state.archiveCharacter(created.cardId)
    const view = await render(<CharactersSection remote={f.remote} />)
    const listing = operation === 'archive' ? f.remote.listCharacters : f.remote.listArchivedCharacters
    await settle(() => {
      if (operation === 'restore') view.root.findByType(Tabs).props.onChange('archived')
    }, () => completed(listing))
    const message = '模拟保存成功后连接中断'
    if (operation === 'archive') vi.mocked(f.remote.archiveCharacter).mockImplementationOnce(async request => {
      await f.service.archiveCharacter(request)
      throw new Error(message)
    })
    else vi.mocked(f.remote.restoreCharacter).mockImplementationOnce(async request => {
      await f.service.restoreCharacter(request)
      throw new Error(message)
    })
    await settle(
      () => view.root.findByProps({ 'aria-label': t(operation === 'archive' ? 'characters.card.archive' : 'characters.card.restore') }).props.onClick({ stopPropagation: () => {} }),
      () => vi.mocked(listing).mock.calls.length === 2 && completed(listing),
    )
    expect(view.root.findAllByType('article')).toHaveLength(0)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain(message)
    const active = await f.state.listCharacters()
    expect(active.some(item => item.cardId === created.cardId)).toBe(operation === 'restore')
  })

  it('收纳请求完成前，鼠标和键盘都不能打开将移出列表的角色编辑器', async () => {
    const f = await fixture()
    await f.state.createCharacter('正在收纳的角色')
    const pending = deferred<void>()
    vi.mocked(f.remote.archiveCharacter).mockImplementationOnce(async request => {
      await pending.promise
      return ok(await f.service.archiveCharacter(request))
    })
    f.remote.getCharacterDetail = vi.fn(async request => ok(await f.service.getCharacterDetail(request)))
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => {}, () => completed(f.remote.listCharacters))
    await act(async () => view.root.findByProps({ 'aria-label': t('characters.card.archive') }).props.onClick({ stopPropagation: () => {} }))
    const card = view.root.findByType('article')
    expect(card.props['aria-disabled']).toBe(true)
    await act(async () => {
      card.props.onClick()
      const target = {}
      card.props.onKeyDown({ key: 'Enter', target, currentTarget: target, preventDefault: () => {} })
    })
    expect(f.remote.getCharacterDetail).not.toHaveBeenCalled()
    expect(view.root.findAllByType(Dialog).filter(item => item.props.open)).toHaveLength(0)
    await settle(() => pending.resolve(), () => vi.mocked(f.remote.listCharacters).mock.calls.length === 2 && completed(f.remote.listCharacters))
    expect(view.root.findAllByType('article')).toHaveLength(0)
  })
})

describe('缩短列表后仍可清除搜索', () => {
  it.each(['presets', 'personas', 'characters'] as const)('%s 刷新从五项降为四项，保留可见的搜索与清除入口', async kind => {
    let names = ['港口甲', '港口乙', '森林', '城市', '荒原']
    const remote = {
      listPresets: async () => ok({ items: names.map(name => ({ id: name, name, regexCount: 0 })) }),
      listPersonas: async () => ok({ items: names.map(name => ({ id: name, name, description: '', avatar: null, lorebookId: null })) }),
      listCharacters: async () => ok({ items: names.map(name => ({ cardId: `search-${name}`, name, hasAvatar: false, hasCharacterBook: false })) }),
      listLorebooks: async () => ok({ items: [] }), getAvatar: async () => ok({ dataUrl: null }),
    } as unknown as TavernRemote
    const Component = { presets: PresetsSection, personas: PersonasSection, characters: CharactersSection }[kind]
    const view = await render(<Component remote={remote} />)
    await act(async () => view.root.findByType(SearchInput).props.onChange('港口'))
    names = names.slice(0, 4)
    await click(view, t('action.refresh'))
    expect(view.root.findAllByType(SearchInput)).toHaveLength(1)
    expect(view.root.findByType(SearchInput).props.value).toBe('港口')
    const tiles = () => view.root.findAllByProps({ className: kind === 'characters' ? 'dsh-tavern-charCard' : 'dsh-tavern-tile' })
    expect(tiles()).toHaveLength(2)
    await act(async () => view.root.findByType(SearchInput).props.onChange(''))
    expect(tiles()).toHaveLength(4)
  })
})
