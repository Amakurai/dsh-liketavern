/** 会话迁移界面：选择工作区和文件，失败保留可重试输入，成功先刷新再打开会话。 */
import type { ButtonHTMLAttributes } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { SessionTransfer } from '../src/client/panel/cardData.js'
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
