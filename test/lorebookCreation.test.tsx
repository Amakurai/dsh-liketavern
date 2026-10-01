/** 世界书创建回归：真实 React、文件系统与服务验证新建不能覆盖同名资产，失败可改名重试且重复提交只写一次。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { Btn, ConfirmDialog, Dialog } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null, IconFolderOpenOutlineMedium: () => null, IconTrashOutlineMedium: () => null, IconPlusOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'test', message } })
const mounted: ReactTestRenderer[] = []
const directories: string[] = []
beforeEach(() => { setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** remote 采用真实 service；错误封装遵守 gateway 契约，不在测试内额外模拟资产冲突规则。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-lorebook-creation-'))
  directories.push(root)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
  const saveLorebook = vi.fn<TavernRemote['saveLorebook']>(async request => {
    try { return ok(await service.saveLorebook(request)) }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  const importLorebook = vi.fn<TavernRemote['importLorebook']>(async request => {
    try { return ok(await service.importLorebook(request)) }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  const listLorebooks = vi.fn<TavernRemote['listLorebooks']>(async () => ok(await service.listLorebooks({})))
  const remote = { saveLorebook, importLorebook, listLorebooks,
    listCharacters: async () => ok({ items: [] }),
    getLorebook: vi.fn<TavernRemote['getLorebook']>(async request => ok(await service.getLorebook(request))),
  } as unknown as TavernRemote
  return { state, service, remote, saveLorebook, importLorebook, listLorebooks }
}

async function render(remote: TavernRemote) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<LorebooksSection remote={remote} />) })
  mounted.push(view)
  await settle(() => {}, () => vi.mocked(remote.listLorebooks).mock.settledResults.length > 0)
  return view
}
async function settle(operation: () => void, completed: () => boolean) {
  await act(async () => { operation(); await vi.waitFor(() => expect(completed()).toBe(true)) })
}
const button = (view: ReactTestRenderer, key: string) => view.root.findAllByType(Btn).find(item => item.props.children === t(key))!
const creation = (view: ReactTestRenderer) => view.root.findAllByType(Dialog).find(item => item.props.title === t('lorebooks.createTitle'))!
const completedWrites = (f: Awaited<ReturnType<typeof fixture>>) => [...f.saveLorebook.mock.settledResults, ...f.importLorebook.mock.settledResults].filter(result => result.type !== 'incomplete').length
async function open(view: ReactTestRenderer, name: string) {
  await act(async () => button(view, 'lorebooks.newEmpty').props.onClick())
  await act(async () => creation(view).findByType('input').props.onChange({ target: { value: name } }))
}
async function createBook(view: ReactTestRenderer, f: Awaited<ReturnType<typeof fixture>>) {
  const count = completedWrites(f)
  await settle(() => button(view, 'lorebooks.create').props.onClick(), () => completedWrites(f) > count)
}
const book = (name: string, content: string) => ({ name, entries: { one: { uid: 'one', key: ['港口'], content } } })

it.each(['港口', '港口 设定'])('新建同名空书拒绝覆盖非空资产及修订，错误在弹窗内可见且改名可重试：%s', async name => {
  const f = await fixture()
  const stored = await f.service.importLorebook({ name, json: book(name, '已有的码头与灯塔设定') })
  const original = await f.service.getLorebook({ name: stored.name })
  const view = await render(f.remote)
  await open(view, `  ${name}  `)
  await createBook(view, f)
  expect(await f.service.getLorebook({ name: stored.name })).toEqual(original)
  expect(creation(view).props.open).toBe(true)
  expect(creation(view).findByProps({ role: 'alert' }).children.join('')).toContain('另一窗口')
  expect(creation(view).findByType('input').props.value).toBe(`  ${name}  `)
  expect(button(view, 'lorebooks.create').props.disabled).toBe(false)

  await act(async () => creation(view).findByType('input').props.onChange({ target: { value: '新建 灯塔' } }))
  await createBook(view, f)
  await settle(() => {}, () => view.root.findAllByType(LorebookEditor).length === 1)
  expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'library', name: '新建_灯塔' })
  expect(view.root.findByType(LorebookEditor).props.revision).toMatch(/^[a-f0-9]{64}$/)
  expect(await f.service.getLorebook({ name: stored.name })).toEqual(original)
  expect(await f.state.listLorebooks()).toEqual(expect.arrayContaining([stored.name, '新建_灯塔']))
  expect(f.importLorebook).not.toHaveBeenCalled()
  expect(f.saveLorebook).toHaveBeenLastCalledWith({ name: '新建 灯塔', json: { entries: {} }, expectedRevision: null })
})

it('列表过期后另一个窗口抢先创建同名书，延迟创建仍拒绝覆盖抢先写入的内容', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  const safeSave = f.saveLorebook.getMockImplementation()!, importSave = f.importLorebook.getMockImplementation()!
  f.saveLorebook.mockImplementation(async request => { await gate.promise; return safeSave(request) })
  f.importLorebook.mockImplementation(async request => { await gate.promise; return importSave(request) })
  const view = await render(f.remote)
  await open(view, '抢先港口')
  await act(async () => button(view, 'lorebooks.create').props.onClick())
  const winner = await f.service.importLorebook({ name: '抢先港口', json: book('抢先港口', '另一个窗口的已保存设定') })
  const original = await f.service.getLorebook({ name: winner.name })
  await settle(() => gate.resolve(), () => completedWrites(f) === 1)
  expect(await f.service.getLorebook({ name: winner.name })).toEqual(original)
  expect(creation(view).props.open).toBe(true)
  expect(creation(view).findByProps({ role: 'alert' }).children.join('')).toContain('另一窗口')
  expect(view.root.findAllByType(LorebookEditor)).toHaveLength(0)
  expect(f.saveLorebook).toHaveBeenCalledExactlyOnceWith({ name: '抢先港口', json: { entries: {} }, expectedRevision: null })
})

it('同批重复创建、取消和关闭只提交一次，等待写入时保留弹窗且读取回执前不能重入', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>(), readGate = Promise.withResolvers<void>()
  const safeSave = f.saveLorebook.getMockImplementation()!, importSave = f.importLorebook.getMockImplementation()!
  f.saveLorebook.mockImplementation(async request => { await gate.promise; return safeSave(request) })
  f.importLorebook.mockImplementation(async request => { await gate.promise; return importSave(request) })
  const getLorebook = vi.mocked(f.remote.getLorebook), originalRead = getLorebook.getMockImplementation()!
  getLorebook.mockImplementation(async request => { await readGate.promise; return originalRead(request) })
  const view = await render(f.remote)
  await open(view, '  独立港口  ')
  const submit = button(view, 'lorebooks.create').props.onClick, cancel = button(view, 'action.cancel').props.onClick, close = creation(view).props.onClose
  await act(async () => { submit(); submit(); cancel(); close() })
  expect(f.saveLorebook.mock.calls.length + f.importLorebook.mock.calls.length).toBe(1)
  expect(creation(view).props.open).toBe(true)
  expect(creation(view).findByType('input').props.value).toBe('  独立港口  ')
  expect(creation(view).findByType('input').props.disabled).toBe(true)
  expect(view.root.findAllByType(ConfirmDialog).every(dialog => !dialog.props.open)).toBe(true)
  await settle(() => gate.resolve(), () => getLorebook.mock.calls.length === 1)
  await act(async () => submit())
  expect(f.saveLorebook).toHaveBeenCalledExactlyOnceWith({ name: '独立港口', json: { entries: {} }, expectedRevision: null })
  await settle(() => readGate.resolve(), () => view.root.findAllByType(LorebookEditor).length === 1)
  expect(await f.state.listLorebooks()).toEqual(['独立港口'])
  expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'library', name: '独立港口' })
})

it.each(['envelope', 'transport'] as const)('新建%s失败保留名称和可见错误，重新提交成功后打开实际文件', async failure => {
  const f = await fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['saveLorebook']>>>()
  f.saveLorebook.mockImplementationOnce(() => pending.promise)
  const view = await render(f.remote)
  await open(view, '  重试 港口  ')
  await act(async () => button(view, 'lorebooks.create').props.onClick())
  if (failure === 'envelope') await act(async () => pending.resolve(fail('模拟创建失败')))
  else await act(async () => pending.reject(new Error('模拟创建失败')))
  expect(creation(view).props.open).toBe(true)
  expect(creation(view).findByProps({ role: 'alert' }).children.join('')).toContain('模拟创建失败')
  expect(creation(view).findByType('input').props.value).toBe('  重试 港口  ')
  expect(button(view, 'lorebooks.create').props.disabled).toBe(false)
  expect(await f.state.listLorebooks()).toEqual([])
  await createBook(view, f)
  await settle(() => {}, () => view.root.findAllByType(LorebookEditor).length === 1)
  expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'library', name: '重试_港口' })
  expect(await f.state.listLorebooks()).toEqual(['重试_港口'])
  expect(f.saveLorebook).toHaveBeenCalledTimes(2)
})
