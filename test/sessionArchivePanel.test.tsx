/** 会话迁移界面：选择工作区和文件，失败保留可重试输入，成功先刷新再打开会话。 */
import type { ButtonHTMLAttributes } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { SessionTransfer } from '../src/client/panel/cardData.js'
import { DraftScope } from '../src/client/drafts.js'
import { Btn, ConfirmDialog, FileBtn, Select } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'
import { setTavernLocale } from '../src/client/i18n.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Toast: (props: { text: string }) => <div>{props.text}</div>,
  Modal: () => null, Menu: () => null, Tooltip: () => null,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

it('导入失败后同一文件仍可重试，成功后刷新并打开', async () => {
  setTavernLocale('zh')
  const importSessionArchive = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'test', message: '模拟故障' } })
    .mockResolvedValueOnce({ ok: true, value: { sessionId: 'session-restored' } })
  const remote = { listSessionImportWorkspaces: vi.fn().mockResolvedValue({ ok: true, value: { items: [{ id: 'w1', title: '工作区' }] } }),
    exportSessionArchive: vi.fn(), importSessionArchive } as unknown as TavernRemote
  const order: string[] = []
  const sessions = { refresh: async () => { order.push('refresh') }, open: (id: string) => { order.push(`open:${id}`) } }
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(<SessionTransfer remote={remote} sessions={sessions} sessionId="source" />) })
  await act(async () => { view.root.findByType(Select).props.onChange('w1') })
  await act(async () => { view.root.findByType(FileBtn).props.onFile(new File(['{"version":1}'], 'session.json', { type: 'application/json' })) })
  const submit = () => view.root.findAllByType(Btn).find(item => item.props.primary)!
  expect(submit().props.disabled).toBe(false)
  await act(async () => { submit().props.onClick() })
  await act(async () => { await view.root.findByType(ConfirmDialog).props.onConfirm() })
  expect(importSessionArchive).toHaveBeenCalledTimes(1)
  expect(submit().props.disabled).toBe(false)
  await act(async () => { submit().props.onClick() })
  await act(async () => { await view.root.findByType(ConfirmDialog).props.onConfirm() })
  expect(importSessionArchive).toHaveBeenLastCalledWith({ workspaceId: 'w1', archiveJson: '{"version":1}' })
  expect(order).toEqual(['refresh', 'open:session-restored'])
  await act(async () => view.unmount())
})

/** 延迟远端和文件读取验证真实导航结果，不用禁用按钮代替进行中的操作保护。 */
it('迁移期间阻止离开，失败后保留文件并允许明确放弃', async () => {
  setTavernLocale('zh')
  const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['importSessionArchive']>>>()
  const leave = vi.fn()
  const remote = { listSessionImportWorkspaces: async () => ({ ok: true, value: { items: [{ id: 'w1', title: '工作区' }] } }),
    importSessionArchive: vi.fn(() => pending.promise) } as unknown as TavernRemote
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(<DraftScope>{request => <>
    <SessionTransfer remote={remote}/><Btn onClick={() => request(leave)}>离开</Btn>
  </>}</DraftScope>) })
  const leaveButton = () => view.root.findAllByType(Btn).find(item => item.props.children === '离开')!
  const submit = () => view.root.findAllByType(Btn).find(item => item.props.primary)!
  const dialog = () => view.root.findAllByType(ConfirmDialog).find(item => item.props.open)!
  await act(async () => { view.root.findByType(Select).props.onChange('w1') })
  await act(async () => { view.root.findByType(FileBtn).props.onFile(new File(['original'], 'session.json')) })
  await act(async () => { leaveButton().props.onClick() })
  expect(leave).not.toHaveBeenCalled()
  expect(dialog().props.title).toBe('放弃未保存的修改？')
  await act(async () => { dialog().props.onCancel() })
  await act(async () => { submit().props.onClick() })
  await act(async () => { dialog().props.onConfirm() })
  await act(async () => { leaveButton().props.onClick() })
  expect(leave).not.toHaveBeenCalled()
  expect(view.root.findAllByType(ConfirmDialog).some(item => item.props.open)).toBe(false)
  await act(async () => { pending.resolve({ ok: false, error: { code: 'test', message: '保留文件重试' } }) })
  expect(submit().props.disabled).toBe(false)
  await act(async () => { leaveButton().props.onClick() })
  await act(async () => { dialog().props.onConfirm() })
  expect(leave).toHaveBeenCalledOnce()
  expect(submit().props.disabled).toBe(true)
  await act(async () => view.unmount())
})

it('读取新文件失败时保留原文件，读取期间也不能切走', async () => {
  setTavernLocale('zh')
  const reading = Promise.withResolvers<string>(), leave = vi.fn()
  const remote = { listSessionImportWorkspaces: async () => ({ ok: true, value: { items: [{ id: 'w1', title: '工作区' }] } }),
    importSessionArchive: vi.fn().mockResolvedValue({ ok: false, error: { code: 'test', message: '模拟失败' } }) } as unknown as TavernRemote
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(<DraftScope>{request => <>
    <SessionTransfer remote={remote}/><Btn onClick={() => request(leave)}>离开</Btn>
  </>}</DraftScope>) })
  await act(async () => { view.root.findByType(Select).props.onChange('w1') })
  await act(async () => { view.root.findByType(FileBtn).props.onFile(new File(['original'], 'session.json')) })
  const next = new File(['replacement'], 'unreadable.json')
  vi.spyOn(next, 'text').mockReturnValue(reading.promise)
  await act(async () => { view.root.findByType(FileBtn).props.onFile(next) })
  await act(async () => { view.root.findAllByType(Btn).find(item => item.props.children === '离开')!.props.onClick() })
  expect(leave).not.toHaveBeenCalled()
  expect(view.root.findAllByType(ConfirmDialog).some(item => item.props.open)).toBe(false)
  await act(async () => { reading.reject(new Error('文件不可读')) })
  const submit = view.root.findAllByType(Btn).find(item => item.props.primary)!
  expect(submit.props.disabled).toBe(false)
  await act(async () => { submit.props.onClick() })
  await act(async () => { view.root.findAllByType(ConfirmDialog).find(item => item.props.open)!.props.onConfirm() })
  expect(remote.importSessionArchive).toHaveBeenCalledWith({ workspaceId: 'w1', archiveJson: 'original' })
  await act(async () => view.unmount())
})

it('导入成功但导航失败时可重新打开，不能再次导入同一文件', async () => {
  setTavernLocale('zh')
  const remote = { listSessionImportWorkspaces: async () => ({ ok: true, value: { items: [{ id: 'w1', title: '工作区' }] } }),
    importSessionArchive: vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'restored' } }) } as unknown as TavernRemote
  const sessions = { refresh: vi.fn(async () => {}), open: vi.fn().mockImplementationOnce(() => { throw new Error('未知会话') })
    .mockImplementationOnce(() => { throw new Error('未知会话') }).mockImplementation(() => {}) }
  let view!: ReturnType<typeof create>
  await act(async () => { view = create(<SessionTransfer remote={remote} sessions={sessions}/>) })
  await act(async () => { view.root.findByType(Select).props.onChange('w1') })
  await act(async () => { view.root.findByType(FileBtn).props.onFile(new File(['archive'], 'session.json')) })
  await act(async () => { view.root.findAllByType(Btn).find(item => item.props.primary)!.props.onClick() })
  await act(async () => { view.root.findByType(ConfirmDialog).props.onConfirm() })
  expect(view.root.findAllByType(Btn).find(item => item.props.primary)!.props.disabled).toBe(true)
  const reopen = view.root.findAllByType(Btn).find(item => item.props.children === '打开已导入会话')!
  expect(reopen).toBeDefined()
  await act(async () => { reopen.props.onClick() })
  expect(sessions.open).toHaveBeenLastCalledWith('restored')
  expect(sessions.open).toHaveBeenCalledTimes(3)
  expect(remote.importSessionArchive).toHaveBeenCalledOnce()
  // 新一轮迁移不能通过上一轮的导航入口绕过所选文件的离开保护。
  await act(async () => { view.root.findByType(FileBtn).props.onFile(new File(['next-archive'], 'next.json')) })
  expect(view.root.findAllByType(Btn).some(item => item.props.children === '打开已导入会话')).toBe(false)
  expect(view.root.findAllByType(Btn).find(item => item.props.primary)!.props.disabled).toBe(false)
  await act(async () => view.unmount())
})
