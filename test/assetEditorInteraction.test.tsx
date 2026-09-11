/** 资产编辑交互回归：真实文件系统与服务适配器覆盖预设身份、导入失败重试，以及列表缩短后的搜索恢复。 */
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
import { PersistentEditor } from '../src/client/draftPersistence.js'
import { Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, SearchInput, fileToBase64 } from '../src/client/util.js'
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
  IconDownloadOutline16: () => null, IconEditOutline16: () => null, IconFolderOpenOutline16: () => null,
  IconListPenOutline16: () => null, IconTrashOutline16: () => null,
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
