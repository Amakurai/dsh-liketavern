/** 资产编辑交互回归：真实文件系统与服务适配器覆盖预设身份与采样草稿、收纳与删除失败恢复、导入重试及搜索恢复。 */
import type { ReactNode } from 'react'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TavernSettingsScope } from '../src/node/config.js'
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
import { isolated } from '../src/node/isolated.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE } from '../src/core/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null, IconDownloadOutlineMedium: () => null, IconEditOutlineMedium: () => null, IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null, IconTrashOutlineMedium: () => null, IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
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
  const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
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

/** 世界书编辑经真实文件存储回读，并在隔离 worker 内验证含逗号的正则主/次级键仍能触发。 */
it('已有正则关键词追加普通词后保存，不拆坏量词与字符类中的逗号', async () => {
  const f = await fixture(), name = '正则关键词', primary = '/\\d{1,3}/', secondary = '/coin[,，]gold/i'
  await f.service.importLorebook({ name, json: { entries: { 1: { uid: 1, key: [primary], keysecondary: [secondary],
    selective: true, selectiveLogic: 0, content: '正则命中后的设定', disable: false, constant: false } } } })
  f.remote.listLorebooks = vi.fn(async () => ok(await f.service.listLorebooks({})))
  f.remote.getLorebook = vi.fn(async request => ok(await f.service.getLorebook(request)))
  f.remote.saveLorebook = vi.fn(async request => ok(await f.service.saveLorebook(request)))
  const view = await render(<LorebooksSection remote={f.remote}/>)
  await settle(() => {}, () => completed(f.remote.listLorebooks))
  await settle(() => view.root.findByProps({ className: 'dsh-tavern-tile' }).props.onClick(), () => completed(f.remote.getLorebook))
  const input = (placeholder: string) => view.root.findAllByType('input').find(item => item.props.placeholder === placeholder)!
  await act(async () => input(t('lorebookEditor.form.keysPlaceholder')).props.onChange({ target: { value: `${primary}, 港口` } }))
  await act(async () => input(t('lorebookEditor.form.secondaryKeysPlaceholder')).props.onChange({ target: { value: `${secondary}, 船` } }))
  await settle(() => view.root.findAllByType(Btn).find(item => item.props.children === '保存')!.props.onClick(), () => completed(f.remote.saveLorebook))
  const entries = await f.state.loadLorebookEntries(name, 'global')
  expect(entries[0]!.keys).toEqual([primary, '港口'])
  expect(entries[0]!.secondaryKeys).toEqual([secondary, '船'])
  const result = await isolated('wi', { entries, messages: [{ role: 'user', content: '24 COIN,GOLD' }],
    settings: DEFAULT_WI_SETTINGS, timerState: EMPTY_TIMER_STATE, contextWindowTokens: 8192, reservedTokens: 0, seed: 1 })
  expect(result.activated.map(item => item.entry.uid)).toEqual(['1'])
})

/** 多行角色字段复用 Field 的关联标签；多个编辑实例的名称引用互不串联。 */
it('角色详情多行输入框具有真实关联的可访问名称，重复挂载保持标签身份独立', async () => {
  const f = await fixture()
  await f.state.createCharacter('可访问角色')
  f.remote.getCharacterDetail = vi.fn(async request => ok(await f.service.getCharacterDetail(request)))
  const views = [await render(<CharactersSection remote={f.remote} />), await render(<CharactersSection remote={f.remote} />)]
  const labelIds: string[] = []
  const expected = ['description', 'personality', 'scenario', 'greeting', 'mesExample', 'systemPrompt', 'postHistory', 'depthPrompt', 'creatorNotes']
  for (const view of views) {
    await settle(() => {}, () => view.root.findAllByProps({ className: 'dsh-tavern-charCard' }).length === 1)
    await act(async () => view.root.findByProps({ className: 'dsh-tavern-charCard' }).props.onClick())
    await settle(() => {}, () => view.root.findAllByType('textarea').length >= expected.length)
    const controls = view.root.findAllByType('textarea').filter(node => node.props['aria-labelledby'])
    const names = controls.map(node => {
      const id = node.props['aria-labelledby'] as string
      labelIds.push(id)
      return view.root.findByProps({ id }).children.join('')
    })
    expect(names).toEqual(expect.arrayContaining(expected.map(name => t(`characters.detail.${name}`))))
    const ids = controls.map(node => node.props['aria-labelledby'])
    await act(async () => controls[0]!.props.onChange({ target: { value: '更新但不换标签' } }))
    expect(view.root.findAllByType('textarea').filter(node => node.props['aria-labelledby']).map(node => node.props['aria-labelledby'])).toEqual(ids)
  }
  expect(new Set(labelIds).size).toBe(labelIds.length)
})

/** 采样恢复全局仅修改编辑草稿；放弃不落盘，保存才删除预设覆盖字段。 */
it('预设改用插件采样设置可取消，保存后实际移除采样覆盖', async () => {
  const f = await fixture()
  const sampling = { temperature: 0.4, maxTokens: 2048, stop: ['END'], topP: 0.7 }
  const id = await f.state.savePreset({ identifier: 'sampling-reset', name: '采样草稿', entries: [], sampling })
  const view = await render(<PresetsSection remote={f.remote} />)
  await settle(() => {}, () => completed(f.remote.listPresets))
  const open = async () => {
    const count = vi.mocked(f.remote.getPreset).mock.calls.length
    await settle(() => view.root.findByProps({ className: 'dsh-tavern-tile' }).props.onClick(),
      () => vi.mocked(f.remote.getPreset).mock.calls.length > count && completed(f.remote.getPreset))
  }
  const resetButtons = () => view.root.findAllByType(Btn).filter(item => item.props.children === t('presets.sampling.useGlobal'))
  await open()
  expect(resetButtons()).toHaveLength(1)
  await click(view, t('presets.sampling.useGlobal'))
  expect(resetButtons()).toHaveLength(0)
  expect(f.remote.savePreset).not.toHaveBeenCalled()
  expect((await f.state.loadPreset(id))?.sampling).toEqual(sampling)

  await click(view, t('action.close'))
  const discard = view.root.findAllByType(ConfirmDialog).find(item => item.props.open && item.props.title === t('draft.leaveTitle'))!
  await act(async () => discard.props.onConfirm())
  expect(view.root.findAllByType('fieldset')).toHaveLength(0)
  expect(f.remote.savePreset).not.toHaveBeenCalled()
  expect((await f.state.loadPreset(id))?.sampling).toEqual(sampling)

  await open()
  expect(resetButtons()).toHaveLength(1)
  await click(view, t('presets.sampling.useGlobal'))
  await settle(() => view.root.findAllByType(Btn).find(item => item.props.children === t('presets.save'))!.props.onClick(),
    () => completed(f.remote.savePreset))
  expect(f.remote.savePreset).toHaveBeenCalledOnce()
  expect(vi.mocked(f.remote.savePreset).mock.calls[0]![0].preset).not.toHaveProperty('sampling')
  expect(await f.state.loadPreset(id)).not.toHaveProperty('sampling')
  await click(view, t('action.close'))
  expect(view.root.findAllByType('fieldset')).toHaveLength(0)
  await open()
  expect(resetButtons()).toHaveLength(0)
})

describe('角色卡导入失败恢复', () => {
  const file = () => new File([JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: '测试旅人', description: '手写测试卡', first_mes: '你好', character_book: { name: '测试港口', entries: [
      { id: 1, keys: ['港口'], content: '测试设定', enabled: true, insertion_order: 10 },
    ] },
  } })], 'traveler.json', { type: 'application/json' })
  const dialog = (view: ReactTestRenderer) => view.root.findAllByType(Dialog).find(item => item.props.title === t('characters.importPreview.title'))
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

  it('无内嵌书也先预检，取消不创建资产，导入失败可保留报告原地重试', async () => {
    const f = await fixture()
    const plain = new File([JSON.stringify({ name: '无书角色', first_mes: '<div>预检</div>' })], 'plain.json')
    const view = await render(<CharactersSection remote={f.remote} />)
    const importButton = () => dialog(view)!.findAllByType(Button).find(item => item.props.children === t('characters.importPreview.import'))!
    await settle(() => view.root.findByType(FileBtn).props.onFile(plain), () => completed(f.remote.inspectCharacter))
    expect(dialog(view)!.findByProps({ 'aria-label': t('characters.compatibility.title') }).findAllByType('li').length).toBeGreaterThan(0)
    expect(f.remote.importCharacter).not.toHaveBeenCalled()
    expect(await f.state.listCharacters()).toEqual([])
    await act(async () => dialog(view)!.findAllByType(Button).find(item => item.props.children === t('action.cancel'))!.props.onClick())
    expect(dialog(view)).toBeUndefined()
    expect(await f.state.listCharacters()).toEqual([])
    await settle(() => view.root.findByType(FileBtn).props.onFile(plain), () => vi.mocked(f.remote.inspectCharacter).mock.settledResults.length === 2)
    vi.mocked(f.remote.importCharacter).mockRejectedValueOnce(new Error('无书导入失败'))
    await act(async () => importButton().props.onClick())
    expect(dialog(view)!.findAllByType(Err).some(item => item.props.message === '无书导入失败')).toBe(true)
    await settle(() => importButton().props.onClick(), () => completed(f.remote.importCharacter))
    expect(dialog(view)).toBeUndefined()
    expect((await f.state.listCharacters()).map(item => item.name)).toEqual(['无书角色'])
    expect(vi.mocked(f.remote.importCharacter).mock.calls.every(([request]) => request.importWorldBook === false)).toBe(true)
  })

  it('检查传输失败不导入，重新选择同一文件可重试，随后取消没有副作用', async () => {
    const f = await fixture()
    vi.mocked(f.remote.inspectCharacter).mockResolvedValueOnce(fail('预检连接中断'))
    const view = await render(<CharactersSection remote={f.remote} />)
    await settle(() => view.root.findByType(FileBtn).props.onFile(file()), () => completed(f.remote.inspectCharacter))
    expect(dialog(view)).toBeUndefined()
    expect(view.root.findAllByType(Err).some(item => item.props.message === '预检连接中断')).toBe(true)
    expect(f.remote.importCharacter).not.toHaveBeenCalled()
    await settle(() => view.root.findByType(FileBtn).props.onFile(file()), () => vi.mocked(f.remote.inspectCharacter).mock.settledResults.length === 2)
    expect(dialog(view)).toBeDefined()
    await act(async () => dialog(view)!.props.onClose())
    expect(await f.state.listCharacters()).toEqual([])
  })

  it('服务预检的成功与失败均不落盘；导入保留脚本与正则，跳过内嵌书同时清除卡片和资产书', async () => {
    const f = await fixture()
    await f.state.createCharacter('已有资产')
    const snapshot = async () => {
      const files = (await readdir(f.state.paths.root, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
      return Promise.all(files.map(async path => [path, (await readFile(path)).toString('base64')]))
    }
    const source = { name: '兼容检查', description: '<% throw Error("不得运行") %>',
      extensions: { regex_scripts: [{ findRegex: '/(a+)+$/', replaceString: '<div>显示</div>' }],
        tavern_helper: { scripts: [{ type: 'script', id: 'test', content: 'generateRaw();', enabled: false }] } },
      character_book: { name: '待选书', entries: [{ keys: ['港口'], content: '测试设定', vectorized: true }] } }
    const request = { name: 'review.json', dataBase64: Buffer.from(JSON.stringify(source)).toString('base64') }
    const before = await snapshot()
    const preview = await f.service.inspectCharacter(request)
    expect(preview.compatibility.findings.map(item => item.code)).toEqual(expect.arrayContaining(['unsupportedApi', 'vectorLore', 'templates']))
    await expect(f.service.inspectCharacter({ name: 'broken.json', dataBase64: Buffer.from('{').toString('base64') })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
    for (const importWorldBook of [true, false]) {
      const result = await f.service.importCharacter({ ...request, importWorldBook })
      const saved = (await f.state.loadCharacter(result.cardId))!.card
      expect(saved.extensions.tavern_helper).toEqual(source.extensions.tavern_helper)
      expect(saved.regexScripts).toEqual(source.extensions.regex_scripts)
      expect(saved.description).toBe(source.description)
      expect(saved.characterBook !== null).toBe(importWorldBook)
      expect(await f.state.loadCharacterLorebookRaw(result.cardId)).toEqual(importWorldBook ? expect.objectContaining({ entryCount: 1 }) : null)
    }
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


/** 审查修复回归：两个真实 React 编辑器使用同一服务，陈旧编辑器失败且草稿完整保留。 */
it('审查修复回归：双编辑器保存不静默覆盖，保存回执版本支持连续保存', async () => {
  const f = await fixture(), created = await f.state.createCharacter('双窗口角色')
  f.remote.getCharacterDetail = vi.fn(async request => ok(await f.service.getCharacterDetail(request)))
  f.remote.saveCharacter = vi.fn(async request => {
    try { return ok(await f.service.saveCharacter(request)) }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  const a = await render(<CharactersSection remote={f.remote} />), b = await render(<CharactersSection remote={f.remote} />)
  for (const view of [a, b]) {
    await settle(() => {}, () => view.root.findAllByProps({ className: 'dsh-tavern-charCard' }).length === 1)
    await settle(() => view.root.findByProps({ className: 'dsh-tavern-charCard' }).props.onClick(),
      () => view.root.findAllByType('textarea').length > 0)
  }
  const save = (view: ReactTestRenderer) => settle(() => view.root.findAllByType(Btn).find(item => item.props.children === '保存')!.props.onClick(), () => completed(f.remote.saveCharacter))
  const description = (view: ReactTestRenderer) => view.root.findAllByType('textarea')[0]!
  await act(async () => description(a).props.onChange({ target: { value: 'A 保存的描述' } }))
  await save(a)
  const first = await f.service.getCharacterDetail({ cardId: created.cardId })
  expect(first.description).toBe('A 保存的描述')
  await act(async () => description(b).props.onChange({ target: { value: 'B 未保存的草稿' } }))
  await save(b)
  expect(description(b).props.value).toBe('B 未保存的草稿')
  expect(JSON.stringify(b.toJSON())).toContain('其他编辑器')
  expect((await f.service.getCharacterDetail({ cardId: created.cardId })).description).toBe('A 保存的描述')
  await act(async () => description(a).props.onChange({ target: { value: 'A 第二次描述' } }))
  await save(a)
  expect((await f.service.getCharacterDetail({ cardId: created.cardId })).description).toBe('A 第二次描述')
  expect(vi.mocked(f.remote.saveCharacter).mock.calls[2]?.[0].expectedRevision).toBe(first.revision)
})
