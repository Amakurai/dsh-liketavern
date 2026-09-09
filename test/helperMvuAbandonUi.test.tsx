/** 显式放弃 MVU 界面：真实 React 验证确认、请求去重、失败重试及关闭交互后仍可恢复。 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelperMvuAbandonAction, TavernHeaderChip } from '../src/client/chip.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { Btn, ConfirmDialog, Err } from '../src/client/util.js'
import { invalidateSessionBinding, invalidateCharacter } from '../src/client/cache.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { SessionBinding, TavernRemote } from '../src/client/types.js'
vi.mock('../src/client/styles.js', () => ({}))
vi.mock('../src/client/panel/memory.js', () => ({ MemorySection: () => null }))
vi.mock('../src/client/panel/lorebookEditor.js', () => ({ LorebookEditor: () => null }))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutline16: () => null, IconUserOutline16: () => null, IconChevronDownOutline14: () => null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>, Toast: () => null, Menu: () => null,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <>{props.children}{props.footer}</> : null,
}))
let view: ReactTestRenderer | undefined
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); setTavernLocale('zh'); invalidateSessionBinding('session'); invalidateCharacter('card') })
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
async function mount(component: ReactNode) { await act(async () => { view = create(component) }) }
const dialog = () => view!.root.findByType(ConfirmDialog)
const button = () => view!.root.findAllByType(Btn).find(item => String(item.props.children).includes('放弃待处理'))!
it('取消确认不发请求，确认期间去重，成功后刷新绑定', async () => {
  const release = Promise.withResolvers<unknown>(), abandonHelperMvu = vi.fn(() => release.promise), onChanged = vi.fn()
  await mount(<HelperMvuAbandonAction remote={{ abandonHelperMvu } as unknown as TavernRemote} sessionId="session" storyId="story" onChanged={onChanged}/>)
  await act(async () => button().props.onClick())
  expect(dialog().props.description).toContain('已保存变量'); expect(dialog().props.description).toContain('不会补跑')
  await act(async () => dialog().props.onCancel()); expect(abandonHelperMvu).not.toHaveBeenCalled()
  await act(async () => button().props.onClick())
  await act(async () => { dialog().props.onConfirm(); dialog().props.onConfirm(); dialog().props.onCancel() })
  expect(abandonHelperMvu).toHaveBeenCalledTimes(1); expect(abandonHelperMvu).toHaveBeenCalledWith({ sessionId: 'session', storyId: 'story' })
  expect(dialog().props.busy).toBe(true); expect(dialog().props.open).toBe(true)
  await act(async () => release.resolve({ ok: true, value: { disabled: true, abandoned: 2 } }))
  expect(dialog().props.open).toBe(false); expect(onChanged).toHaveBeenCalledTimes(1)
})
it('失败保留确认和明确错误，可显式重试，并刷新可能已关闭的真实绑定', async () => {
  const abandonHelperMvu = vi.fn().mockResolvedValueOnce({ ok: false, error: { message: '自动 MVU 已关闭，但落盘失败，请重试' } }).mockResolvedValue({ ok: true, value: { disabled: true, abandoned: 1 } }), onChanged = vi.fn()
  await mount(<HelperMvuAbandonAction remote={{ abandonHelperMvu } as unknown as TavernRemote} sessionId="session" storyId="story" onChanged={onChanged}/>)
  await act(async () => button().props.onClick()); await act(async () => dialog().props.onConfirm())
  expect(dialog().props.open).toBe(true); expect(dialog().props.description).toContain('落盘失败')
  expect(view!.root.findByType(Err).props.message).toContain('请重试'); expect(onChanged).toHaveBeenCalledTimes(1)
  await act(async () => dialog().props.onConfirm())
  expect(abandonHelperMvu).toHaveBeenCalledTimes(2); expect(dialog().props.open).toBe(false)
})
it('交互关闭且列表仍加载时，真实会话面板仍显示恢复入口', async () => {
  const binding: SessionBinding = { sessionId: 'session', cardId: 'card', storyId: 'story', presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: false, helperMvu: true, greetingIndex: 0, createdAt: 'factory' }
  const remote = {
    getSessionBinding: vi.fn(async () => ({ ok: true, value: { binding } })), getCharacterDetail: vi.fn(async () => ({ ok: true, value: { name: '工厂角色' } })),
    getAvatar: vi.fn(async () => ({ ok: true, value: { dataUrl: null } })), getContextUsage: vi.fn(async () => ({ ok: true, value: { usage: null } })),
    listCharacters: vi.fn(() => new Promise(() => {})), listPresets: vi.fn(async () => ({ ok: true, value: { items: [] } })),
    listPersonas: vi.fn(async () => ({ ok: true, value: { items: [] } })), listLorebooks: vi.fn(async () => ({ ok: true, value: { items: [] } })), abandonHelperMvu: vi.fn(),
  }
  await mount(<TavernHeaderChip remote={remote as unknown as TavernRemote} sessionId="session" sessions={{ open: () => {} }} useSessions={selector => selector({ byId: { session: { projectionValues: { agentPreset: 'tavern' } } } })}/>)
  await act(async () => view!.root.findByType(TavernSeatChip).props.onClick())
  expect(view!.root.findByType(HelperMvuAbandonAction).props.storyId).toBe('story')
  expect(button()).toBeDefined(); expect(remote.abandonHelperMvu).not.toHaveBeenCalled()
})
