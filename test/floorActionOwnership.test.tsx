/** 楼层操作的上下文归属：真实 React 验证切换宿主、会话和消息后旧草稿、回包、导航与剪贴板不越界。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TavernFloorActions, TavernInterruptedFloorActions } from '../src/client/actions.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { markSessionView } from '../src/client/sessionViews.js'
import type { TavernRemote } from '../src/client/types.js'
import { Btn, Dialog } from '../src/client/util.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}/>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div>{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null, Menu: () => null,
  IconBranchOutlineMedium: () => null, IconChevronLeftOutlineMedium: () => null, IconChevronRightOutlineMedium: () => null,
  IconEditOutlineMedium: () => null, IconListPenOutlineMedium: () => null, IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null, IconRefreshOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))
const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
let unmark: () => void
beforeEach(() => {
  setTavernLocale('zh')
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
  unmark = markSessionView('source', true)
})
afterEach(async () => { unmark(); for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })

function fixture() {
  const remote = {
    getSessionBinding: async () => ok({ binding: { cardId: 'card' } }),
    getGreetingSwipe: async () => ok({ isGreeting: false, started: true, swipe: null }),
    getFloorSiblings: async () => ok({ swipe: null }),
    getFloorUserMessage: vi.fn(async () => ok({ turn: 2, text: '原文' })),
    editUserMessage: vi.fn(async () => ok({ childSessionId: 'edited-child' })),
    regenerate: vi.fn(async () => ok({ childSessionId: 'child' })),
    impersonate: vi.fn(async () => ok({ text: '代答正文' })),
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  return { remote, sessions }
}
function component(f: ReturnType<typeof fixture>, sessionId = 'source', messageId = 'message', interrupted = false) {
  return interrupted ? <TavernInterruptedFloorActions remote={f.remote} sessions={f.sessions} sessionId={sessionId} turn={2}/>
    : <TavernFloorActions remote={f.remote} sessions={f.sessions} sessionId={sessionId} messageId={messageId}
      useSessions={select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })}/>
}
async function render(f: ReturnType<typeof fixture>, interrupted = false) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(component(f, 'source', 'message', interrupted)) })
  mounted.push(view)
  return view
}
const action = (view: ReactTestRenderer, key: string) => view.root.findByProps({ 'aria-label': t(key) })

it.each(['remote', 'session', 'message'] as const)('切换 %s 后关闭旧编辑草稿，新目标重新读取原文', async target => {
  const old = fixture(), next = target === 'remote' ? fixture() : old, view = await render(old)
  await act(async () => action(view, 'actions.editUser').props.onClick())
  await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '旧上下文草稿' } }))
  const sessionId = target === 'session' ? 'new-source' : 'source', messageId = target === 'message' ? 'new-message' : 'message'
  vi.mocked(next.remote.getFloorUserMessage).mockResolvedValue(ok({ turn: 3, text: '新上下文原文' }))
  await act(async () => view.update(component(next, sessionId, messageId)))
  expect(view.root.findAllByType(Dialog)).toHaveLength(0)
  await act(async () => action(view, 'actions.editUser').props.onClick())
  expect(view.root.findByType('textarea').props.value).toBe('新上下文原文')
  await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '新目标正文' } }))
  await act(async () => view.root.findAllByType(Btn).find(item => item.props.primary)!.props.onClick())
  expect(next.remote.editUserMessage).toHaveBeenCalledWith({ sessionId, messageId, text: '新目标正文' })
})

it.each(['remote', 'session', 'message'] as const)('旧编辑读取迟到时不会覆盖 %s 的新读取或释放新操作锁', async target => {
  const old = fixture(), next = target === 'remote' ? fixture() : old, view = await render(old)
  const previous = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getFloorUserMessage']>>>()
  const current = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getFloorUserMessage']>>>()
  vi.mocked(old.remote.getFloorUserMessage).mockImplementationOnce(() => previous.promise)
  await act(async () => action(view, 'actions.editUser').props.onClick())
  vi.mocked(next.remote.getFloorUserMessage).mockImplementationOnce(() => current.promise)
  await act(async () => view.update(component(next, target === 'session' ? 'new-source' : 'source', target === 'message' ? 'new-message' : 'message')))
  expect(action(view, 'actions.editUser').props.disabled).toBe(false)
  await act(async () => action(view, 'actions.editUser').props.onClick())
  await act(async () => previous.resolve(ok({ turn: 2, text: '迟到的旧正文' })))
  expect(action(view, 'actions.editUser').props.disabled).toBe(true)
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () => current.resolve(ok({ turn: 3, text: '当前正文' })))
  expect(view.root.findByType('textarea').props.value).toBe('当前正文')
})

it.each([false, true])('宿主切换后旧分支回包不能导航，即使会话 ID 相同，中断楼层：%s', async interrupted => {
  const old = fixture(), next = fixture(), view = await render(old, interrupted)
  const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['regenerate']>>>()
  vi.mocked(old.remote.regenerate).mockImplementationOnce(() => pending.promise)
  await act(async () => action(view, 'actions.regenerate').props.onClick())
  await act(async () => view.update(component(next, 'source', 'message', interrupted)))
  await act(async () => pending.resolve(ok({ childSessionId: 'old-host-child' })))
  expect(old.sessions.open).not.toHaveBeenCalled()
  expect(next.sessions.open).not.toHaveBeenCalled()
})

it.each([false, true])('列表刷新期间切换宿主不执行旧导航，中断楼层：%s', async interrupted => {
  const old = fixture(), next = fixture(), view = await render(old, interrupted), pending = Promise.withResolvers<void>()
  old.sessions.refresh.mockImplementationOnce(() => pending.promise)
  await act(async () => action(view, 'actions.regenerate').props.onClick())
  expect(old.sessions.refresh).toHaveBeenCalledOnce()
  await act(async () => view.update(component(next, 'source', 'message', interrupted)))
  await act(async () => pending.resolve())
  expect(old.sessions.open).not.toHaveBeenCalled()
  expect(next.sessions.open).not.toHaveBeenCalled()
})

it('宿主切换后旧代答回包不写剪贴板，也不展示旧正文', async () => {
  const old = fixture(), next = fixture(), view = await render(old)
  const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['impersonate']>>>()
  vi.mocked(old.remote.impersonate).mockImplementationOnce(() => pending.promise)
  await act(async () => action(view, 'actions.impersonate').props.onClick())
  await act(async () => view.update(component(next)))
  await act(async () => pending.resolve(ok({ text: '旧宿主的私有代答' })))
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  expect(view.root.findAllByType(Dialog)).toHaveLength(0)
})

it('受控导航保留宿主方法的 this 和分支标题写入，不丢失 scope/sessionOf 能力', async () => {
  const f = fixture(), rename = vi.fn(async () => {})
  Object.assign(f.sessions, {
    scope(this: typeof f.sessions, id: string) { expect(this).toBe(f.sessions); return { id } },
    sessionOf(this: typeof f.sessions, scope: { id: string }) { expect(this).toBe(f.sessions); expect(scope.id).toBe('child'); return { rename } },
  })
  f.sessions.refresh.mockImplementation(function (this: typeof f.sessions) { expect(this).toBe(f.sessions); return Promise.resolve() })
  vi.mocked(f.remote.regenerate).mockResolvedValueOnce(ok({ childSessionId: 'child', title: '分支标题' }))
  const view = await render(f)
  await act(async () => action(view, 'actions.regenerate').props.onClick())
  expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('child')
  expect(rename).toHaveBeenCalledExactlyOnceWith('分支标题')
})
