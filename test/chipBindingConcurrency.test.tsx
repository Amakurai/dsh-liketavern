/** 会话角色绑定并发回归：真实 React、延迟 remote 与真实服务落盘验证保存/解除不会互相覆盖。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { cachedSessionBinding, invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { BINDING_CHANGED_EVENT } from '../src/client/actions.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { Btn, ConfirmDialog, Dialog } from '../src/client/util.js'
import type { CharacterDetail, SessionBinding, TavernRemote } from '../src/client/types.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
}))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const SESSION = 'session-chip-race', CARD = 'chip-lighthouse'
const mounted: ReactTestRenderer[] = []
beforeEach(() => {
  setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget())
  invalidateSessionBinding(SESSION); invalidateSessionBinding(SESSION + '-other'); invalidateCharacter(CARD)
})
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })

function detail(cardId: string): CharacterDetail {
  return { cardId, name: '灯塔', hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0,
    revision: 'revision', description: '', personality: '', scenario: '', firstMes: '欢迎', alternateGreetings: ['再会'], mesExample: '',
    systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [],
    spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
}
function fixture() {
  let saved: SessionBinding | null = defaultBinding(SESSION, CARD)
  const getSessionBinding = vi.fn<TavernRemote['getSessionBinding']>(async () => ok({ binding: saved, canSwipeGreeting: true }))
  const setSessionBinding = vi.fn<TavernRemote['setSessionBinding']>(async request => { saved = request.binding as SessionBinding; return ok({ saved: true }) })
  const clearSessionBinding = vi.fn<TavernRemote['clearSessionBinding']>(async () => { saved = null; return ok({ cleared: true }) })
  const remote = { getSessionBinding, setSessionBinding, clearSessionBinding,
    getCharacterDetail: async (request: { cardId: string }) => ok(detail(request.cardId)), getAvatar: async () => ok({ dataUrl: null }),
    listCharacters: async () => ok({ items: [detail(CARD)] }), listPresets: async () => ok({ items: [] }),
    listPersonas: async () => ok({ items: [] }), listLorebooks: async () => ok({ items: [] }), getContextUsage: async () => ok({ usage: null }),
  } as unknown as TavernRemote
  return { remote, getSessionBinding, setSessionBinding, clearSessionBinding, binding: () => saved,
    save: (binding: SessionBinding) => { saved = binding }, sessions: { open: vi.fn(), refresh: vi.fn(async () => {}) } }
}
function header(f: ReturnType<typeof fixture>, sessionId = SESSION) {
  return <TavernHeaderChip remote={f.remote} sessionId={sessionId} sessions={f.sessions}
    useSessions={select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })} />
}
async function render(f: ReturnType<typeof fixture>, sessionId = SESSION) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(header(f, sessionId)) })
  mounted.push(view)
  await act(async () => { await f.getSessionBinding.mock.results.at(-1)!.value })
  await act(async () => view.root.findByType(TavernSeatChip).props.onClick())
  return view
}
const button = (view: ReactTestRenderer, key: string) => view.root.findAllByType(Btn).find(item => item.props.children === t(key))!
const confirmation = (view: ReactTestRenderer) => view.root.findAllByType(ConfirmDialog).find(dialog => dialog.props.title === t('chip.unbind.title'))!
const bindingDialog = (view: ReactTestRenderer) => view.root.findAllByType(Dialog).find(dialog => dialog.props.title === t('chip.dialog.title'))!
async function clear(view: ReactTestRenderer) {
  await act(async () => button(view, 'chip.unbind.action').props.onClick())
  await act(async () => confirmation(view).props.onConfirm())
}
async function note(view: ReactTestRenderer, value: string) {
  await act(async () => bindingDialog(view).findByType('textarea').props.onChange({ target: { value } }))
}

it('同批保存与解除共用同步锁，双击只提交一次且不能打开解除确认', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  f.setSessionBinding.mockImplementation(async request => { await gate.promise; f.save(request.binding as SessionBinding); return ok({ saved: true }) })
  const view = await render(f)
  const save = button(view, 'binding.save').props.onClick, unbind = button(view, 'chip.unbind.action').props.onClick
  const confirm = confirmation(view).props.onConfirm
  await act(async () => { save(); save(); unbind(); confirm() })
  expect(f.setSessionBinding).toHaveBeenCalledOnce()
  expect(f.clearSessionBinding).not.toHaveBeenCalled()
  expect(confirmation(view).props.open).toBe(false)
  expect(button(view, 'chip.unbind.action').props.disabled).toBe(true)
  await act(async () => gate.resolve())
  await clear(view)
  expect(f.binding()).toBeNull()
})

it('保存已经在途时不能解除，完成后正常解除且旧保存不能复活绑定', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  f.setSessionBinding.mockImplementation(async request => { await gate.promise; f.save(request.binding as SessionBinding); return ok({ saved: true }) })
  const view = await render(f)
  await act(async () => button(view, 'binding.save').props.onClick())
  await act(async () => button(view, 'chip.unbind.action').props.onClick())
  await act(async () => confirmation(view).props.onConfirm())
  expect(f.clearSessionBinding).not.toHaveBeenCalled()
  expect(confirmation(view).props.open).toBe(false)
  await act(async () => gate.resolve())
  await clear(view)
  expect(f.setSessionBinding).toHaveBeenCalledOnce()
  expect(f.clearSessionBinding).toHaveBeenCalledOnce()
  expect(f.getSessionBinding).toHaveBeenCalledTimes(3)
  expect(f.binding()).toBeNull()
})

it('解除中的重复确认、保存与取消均被同步拦截，完成后保持解除', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  const clearBinding = f.clearSessionBinding.getMockImplementation()!
  f.clearSessionBinding.mockImplementation(async request => { await gate.promise; return clearBinding(request) })
  const view = await render(f)
  const save = button(view, 'binding.save').props.onClick
  await act(async () => button(view, 'chip.unbind.action').props.onClick())
  const confirm = confirmation(view).props.onConfirm, cancel = confirmation(view).props.onCancel
  await act(async () => { confirm(); confirm(); save(); cancel() })
  expect(f.clearSessionBinding).toHaveBeenCalledOnce()
  expect(f.setSessionBinding).not.toHaveBeenCalled()
  expect(confirmation(view).props.open).toBe(true)
  expect(confirmation(view).props.busy).toBe(true)
  expect(button(view, 'binding.save').props.disabled).toBe(true)
  await act(async () => { save(); cancel() })
  expect(confirmation(view).props.open).toBe(true)
  expect(f.setSessionBinding).not.toHaveBeenCalled()
  await act(async () => gate.resolve())
  expect(f.binding()).toBeNull()
  expect(bindingDialog(view).props.open).toBe(false)
})

it.each(['envelope', 'transport'] as const)('保存失败保留草稿并解锁，重试成功后可以解除：%s', async failure => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['setSessionBinding']>>>()
  f.setSessionBinding.mockImplementationOnce(() => pending.promise)
  const view = await render(f)
  await note(view, '保留这份绑定草稿')
  await act(async () => button(view, 'binding.save').props.onClick())
  if (failure === 'envelope') await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '绑定写入暂时失败' } }))
  else await act(async () => pending.reject(new Error('绑定写入暂时失败')))
  expect(bindingDialog(view).findByProps({ role: 'alert' }).children.join('')).toContain('绑定写入暂时失败')
  expect(bindingDialog(view).findByType('textarea').props.value).toBe('保留这份绑定草稿')
  expect(button(view, 'binding.save').props.disabled).toBe(false)
  expect(button(view, 'chip.unbind.action').props.disabled).toBe(false)
  await act(async () => button(view, 'binding.save').props.onClick())
  expect(f.binding()?.authorNote).toBe('保留这份绑定草稿')
  await clear(view)
  expect(f.setSessionBinding).toHaveBeenCalledTimes(2)
  expect(f.binding()).toBeNull()
})

it.each(['envelope', 'transport'] as const)('解除失败显示错误并解锁，保存与重新解除可正常完成：%s', async failure => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['clearSessionBinding']>>>()
  f.clearSessionBinding.mockImplementationOnce(() => pending.promise)
  const view = await render(f)
  await note(view, '解除失败后继续编辑')
  await clear(view)
  if (failure === 'envelope') await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '解除暂时失败' } }))
  else await act(async () => pending.reject(new Error('解除暂时失败')))
  expect(bindingDialog(view).props.open).toBe(true)
  expect(bindingDialog(view).findByProps({ role: 'alert' }).children.join('')).toContain('解除暂时失败')
  expect(bindingDialog(view).findByType('textarea').props.value).toBe('解除失败后继续编辑')
  expect(confirmation(view).props.open).toBe(false)
  expect(button(view, 'binding.save').props.disabled).toBe(false)
  await act(async () => button(view, 'binding.save').props.onClick())
  expect(f.binding()?.authorNote).toBe('解除失败后继续编辑')
  await clear(view)
  expect(f.clearSessionBinding).toHaveBeenCalledTimes(2)
  expect(f.binding()).toBeNull()
})

it('切换会话后的旧保存完成仍刷新来源绑定，不能覆盖新会话草稿或占用新锁', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(), other = SESSION + '-other'
  const stored = new Map<string, SessionBinding>([[SESSION, defaultBinding(SESSION, CARD)], [other, { ...defaultBinding(other, CARD), authorNote: '新会话原稿' }]])
  f.getSessionBinding.mockImplementation(async request => ok({ binding: stored.get(request.sessionId) ?? null, canSwipeGreeting: true }))
  f.setSessionBinding.mockImplementation(async request => {
    const binding = request.binding as SessionBinding
    if (binding.sessionId === SESSION) await gate.promise
    stored.set(binding.sessionId, binding)
    return ok({ saved: true })
  })
  const changed: string[] = []
  window.addEventListener(BINDING_CHANGED_EVENT, event => changed.push((event as CustomEvent<string>).detail))
  const view = await render(f)
  await note(view, '来源会话改稿')
  await act(async () => button(view, 'binding.save').props.onClick())
  await act(async () => view.update(header(f, other)))
  expect(bindingDialog(view).props.open).toBe(false)
  await act(async () => view.root.findByType(TavernSeatChip).props.onClick())
  await note(view, '保留新会话改稿')
  await act(async () => gate.resolve())
  expect(changed).toEqual([SESSION])
  expect((await cachedSessionBinding(f.remote, SESSION))).toEqual(ok({ binding: stored.get(SESSION), canSwipeGreeting: true }))
  expect(bindingDialog(view).props.open).toBe(true)
  expect(bindingDialog(view).findByType('textarea').props.value).toBe('保留新会话改稿')
  expect(button(view, 'binding.save').props.disabled).toBe(false)
  await act(async () => button(view, 'binding.save').props.onClick())
  expect(stored.get(SESSION)?.authorNote).toBe('来源会话改稿')
  expect(stored.get(other)?.authorNote).toBe('保留新会话改稿')
  expect(changed).toEqual([SESSION, other])
})

/** 实际服务先读取角色与已有剧情再落盘；延迟保存穿过 UI 锁后不得晚于用户解除写回。 */
it('真实 FS 与 TavernService 中保存途中解除被拦截，顺序完成后绑定文件仍不存在', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tavern-chip-binding-race-'))
  try {
    const state = new TavernState({ root: directory, characters: join(directory, 'characters'), lorebooks: join(directory, 'lorebooks'),
      presets: join(directory, 'presets'), personas: join(directory, 'personas'), regexDir: join(directory, 'regex'), sessions: join(directory, 'sessions') }, () => resolveConfig({}))
    await state.init()
    const card = await state.createCharacter('真实绑定灯塔')
    await state.saveBinding({ ...defaultBinding(SESSION, card.cardId), helperMvu: false })
    const original = await state.loadBinding(SESSION)
    const session = Session.create(SESSION as Session['id'])
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    const ctx = { reflect: { provide: () => {} }, get: () => undefined,
      sessions: { get: (id: string) => id === SESSION ? session : undefined }, agents: { get: () => undefined } } as unknown as Context
    const service = new TavernService(ctx, state, {} as TavernSettingsScope)
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.getSessionBinding.mockImplementation(async request => ok(await service.getSessionBinding(request)))
    f.setSessionBinding.mockImplementation(async request => { await gate.promise; return ok(await service.setSessionBinding(request)) })
    f.clearSessionBinding.mockImplementation(async request => ok(await service.clearSessionBinding(request)))
    const view = await render(f)
    await note(view, '实际服务保存的草稿')
    await act(async () => button(view, 'binding.save').props.onClick())
    await clear(view)
    expect(f.clearSessionBinding).not.toHaveBeenCalled()
    expect((await state.loadBinding(SESSION))?.storyId).toBe(original?.storyId)
    await act(async () => { gate.resolve(); await f.setSessionBinding.mock.results[0]!.value })
    expect((await state.loadBinding(SESSION))?.authorNote).toBe('实际服务保存的草稿')
    expect((await state.loadBinding(SESSION))?.storyId).toBe(original?.storyId)
    await act(async () => button(view, 'chip.unbind.action').props.onClick())
    await act(async () => { confirmation(view).props.onConfirm(); await f.clearSessionBinding.mock.results[0]!.value })
    expect(f.setSessionBinding).toHaveBeenCalledOnce()
    expect(f.clearSessionBinding).toHaveBeenCalledOnce()
    expect(await state.loadBinding(SESSION)).toBeNull()
    expect((await cachedSessionBinding(f.remote, SESSION))).toMatchObject({ ok: true, value: { binding: null } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
