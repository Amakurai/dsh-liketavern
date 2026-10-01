/** 角色创建交互回归：真实 React 弹窗配延迟 remote，验证重复提交、等待中关闭、错误可见及真实文件落盘。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CharactersSection } from '../src/client/panel/characters.js'
import { invalidateCharacter } from '../src/client/cache.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, Dialog } from '../src/client/util.js'
import type { CharacterDetail, TavernRemote } from '../src/client/types.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null, IconDownloadOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null, IconTrashOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
beforeEach(() => {
  setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget())
  invalidateCharacter('created-lighthouse'); invalidateCharacter('retried-lighthouse')
})
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })

function detail(cardId: string, name = '灯塔'): CharacterDetail {
  return { cardId, name, hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0,
    revision: 'revision', description: '', personality: '', scenario: '', firstMes: '', alternateGreetings: [], mesExample: '',
    systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [],
    spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
}
function fixture() {
  const createCharacter = vi.fn<TavernRemote['createCharacter']>(async request => ok({ cardId: 'created-lighthouse', name: request.name }))
  const listCharacters = vi.fn<TavernRemote['listCharacters']>(async () => ok({ items: [] }))
  const getCharacterDetail = vi.fn<TavernRemote['getCharacterDetail']>(async request => ok(detail(request.cardId)))
  const remote = { createCharacter, listCharacters, getCharacterDetail, getAvatar: async () => ok({ dataUrl: null }) } as unknown as TavernRemote
  return { remote, createCharacter, listCharacters, getCharacterDetail }
}
async function render(remote: TavernRemote) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<CharactersSection remote={remote} />) })
  mounted.push(view)
  return view
}
const creation = (view: ReactTestRenderer) => view.root.findAllByType(Dialog).find(dialog => dialog.props.title === t('characters.create.title'))!
const button = (view: ReactTestRenderer, key: string) => view.root.findAllByType(Btn).find(item => item.props.children === t(key))!
async function open(view: ReactTestRenderer, name: string) {
  await act(async () => button(view, 'characters.newCard').props.onClick())
  await act(async () => creation(view).findByType('input').props.onChange({ target: { value: name } }))
}

it('同批重复提交和关闭只发一次创建请求，等待时保留输入与可见弹窗', async () => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['createCharacter']>>>()
  f.createCharacter.mockImplementationOnce(() => pending.promise)
  const view = await render(f.remote)
  await open(view, '  灯塔  ')
  const submit = button(view, 'characters.create.confirm').props.onClick
  const cancel = button(view, 'action.cancel').props.onClick
  const close = creation(view).props.onClose
  await act(async () => { submit(); submit(); cancel(); close() })
  expect(f.createCharacter).toHaveBeenCalledExactlyOnceWith({ name: '灯塔' })
  expect(creation(view).props.open).toBe(true)
  expect(creation(view).findByType('input').props.value).toBe('  灯塔  ')
  expect(creation(view).findByType('input').props.disabled).toBe(true)
  expect(button(view, 'action.cancel').props.disabled).toBe(true)
  expect(view.root.findAllByType(ConfirmDialog).every(dialog => !dialog.props.open)).toBe(true)
  await act(async () => pending.resolve(ok({ cardId: 'created-lighthouse', name: '灯塔' })))
  expect(creation(view).props.open).toBe(false)
  expect(f.listCharacters).toHaveBeenCalledTimes(2)
  expect(f.getCharacterDetail).toHaveBeenCalledWith({ cardId: 'created-lighthouse' })
})

it.each(['envelope', 'transport'] as const)('创建失败在弹窗中显示错误并保留名称，重试只打开成功创建的卡：%s', async failure => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['createCharacter']>>>()
  f.createCharacter.mockImplementationOnce(() => pending.promise)
  const view = await render(f.remote)
  await open(view, '  继续编辑的灯塔  ')
  await act(async () => button(view, 'characters.create.confirm').props.onClick())
  if (failure === 'envelope') await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '角色写入暂时失败' } }))
  else await act(async () => pending.reject(new Error('角色写入暂时失败')))
  const dialog = creation(view)
  expect(dialog.props.open).toBe(true)
  expect(dialog.findByProps({ role: 'alert' }).children.join('')).toContain('角色写入暂时失败')
  expect(dialog.findByType('input').props.value).toBe('  继续编辑的灯塔  ')
  expect(dialog.findByType('input').props.disabled).toBe(false)
  expect(button(view, 'characters.create.confirm').props.disabled).toBe(false)
  expect(f.getCharacterDetail).not.toHaveBeenCalled()
  f.createCharacter.mockResolvedValueOnce(ok({ cardId: 'retried-lighthouse', name: '继续编辑的灯塔' }))
  await act(async () => button(view, 'characters.create.confirm').props.onClick())
  expect(f.createCharacter).toHaveBeenCalledTimes(2)
  expect(f.createCharacter).toHaveBeenLastCalledWith({ name: '继续编辑的灯塔' })
  expect(creation(view).props.open).toBe(false)
  expect(f.getCharacterDetail).toHaveBeenCalledExactlyOnceWith({ cardId: 'retried-lighthouse' })
})

it('失败后明确放弃再打开新建弹窗，不遗留旧名称或错误', async () => {
  const f = fixture()
  f.createCharacter.mockResolvedValueOnce({ ok: false, error: { code: 'test', message: '上次创建失败' } })
  const view = await render(f.remote)
  await open(view, '放弃的草稿')
  await act(async () => button(view, 'characters.create.confirm').props.onClick())
  await act(async () => creation(view).props.onClose())
  await act(async () => view.root.findAllByType(ConfirmDialog).find(dialog => dialog.props.open)!.props.onConfirm())
  await act(async () => button(view, 'characters.newCard').props.onClick())
  expect(creation(view).findByType('input').props.value).toBe('')
  expect(creation(view).findAllByProps({ role: 'alert' })).toHaveLength(0)
})

/** 接入真实角色存储：同名创建会生成独立随机 ID，UI 必须在落盘前拦截重复请求。 */
it('真实文件系统中双击创建只落盘一张卡并选中该卡', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tavern-character-create-race-'))
  try {
    const state = new TavernState({ root: directory, characters: join(directory, 'characters'), lorebooks: join(directory, 'lorebooks'),
      presets: join(directory, 'presets'), personas: join(directory, 'personas'), regexDir: join(directory, 'regex'), sessions: join(directory, 'sessions') }, () => resolveConfig({}))
    await state.init()
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.createCharacter.mockImplementation(async request => {
      await gate.promise
      const workspace = await state.createCharacter(request.name)
      return ok({ cardId: workspace.cardId, name: workspace.card.name })
    })
    f.listCharacters.mockImplementation(async () => ok({ items: await state.listCharacters() }))
    const view = await render(f.remote)
    await open(view, '独立灯塔')
    const submit = button(view, 'characters.create.confirm').props.onClick
    await act(async () => { submit(); submit() })
    await act(async () => { gate.resolve(); await f.createCharacter.mock.results[0]!.value })
    const cards = await state.listCharacters()
    expect(f.createCharacter).toHaveBeenCalledOnce()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.name).toBe('独立灯塔')
    expect(f.getCharacterDetail).toHaveBeenCalledExactlyOnceWith({ cardId: cards[0]!.cardId })
    expect(creation(view).props.open).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
