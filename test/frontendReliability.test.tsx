/**
 * 前端共享控件可靠性回归：同步读取故障进入可重试错误态，临时禁用不会让菜单复活，
 * 破坏性确认执行期间也不能经 Esc、遮罩或迟到点击绕过 busy 闸门。
 */
import { useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { MemorySection } from '../src/client/panel/memory.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, Select, Tabs, useLoader } from '../src/client/util.js'
import { TavernConfigSchema } from '../src/node/config.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) =>
    <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Modal: (props: { children?: ReactNode; footer?: ReactNode }) => <div>{props.children}{props.footer}</div>,
  Toast: () => null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))

const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
})

it('下拉展开后临时禁用，恢复时保持关闭', async () => {
  const options = [{ value: 'one', label: '选项' }]
  const component = (disabled: boolean) => <Select value="one" options={options} disabled={disabled} onChange={() => {}} />
  const view = await render(component(false))
  await act(async () => view.root.findByType('button').props.onClick())
  expect(view.root.findByType(Menu).props.open).toBe(true)

  await act(async () => view.update(component(true)))
  expect(view.root.findByType(Menu).props.open).toBe(false)
  expect(view.root.findByType('button').props['aria-expanded']).toBe(false)
  await act(async () => view.update(component(false)))
  expect(view.root.findByType(Menu).props.open).toBe(false)
})

it('确认框繁忙时忽略关闭与确认入口，解锁后恢复', async () => {
  const cancel = vi.fn(), confirm = vi.fn()
  const component = (busy: boolean) => <ConfirmDialog open title="确认" description="说明" busy={busy} onCancel={cancel} onConfirm={confirm} />
  const view = await render(component(true))
  const modal = () => view.root.findByType(Modal)
  await act(async () => modal().props.onClose())
  await act(async () => modal().props.footer.props.children[0].props.onClick())
  await act(async () => modal().props.footer.props.children[1].props.onClick())
  expect(cancel).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()

  await act(async () => view.update(component(false)))
  await act(async () => modal().props.onClose())
  await act(async () => modal().props.footer.props.children[1].props.onClick())
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveBeenCalledTimes(1)
})

it('读取函数同步抛错时显示错误且仍可重试', async () => {
  const ok = (value: string): Envelope<string> => ({ ok: true, value })
  function Probe() {
    const [healthy, setHealthy] = useState(false)
    const loader = useLoader(() => {
      if (!healthy) throw new Error('同步连接故障')
      return Promise.resolve(ok('已恢复'))
    }, [healthy])
    return <div data-status={loader.state.status}>
      {loader.state.status === 'error' ? loader.state.message : loader.state.status === 'ready' ? loader.state.value : ''}
      <button onClick={() => setHealthy(true)}>retry</button>
    </div>
  }
  const view = await render(<Probe />)
  expect(view.root.findByType('div').props['data-status']).toBe('error')
  expect(JSON.stringify(view.toJSON())).toContain('同步连接故障')
  await act(async () => view.root.findByType('button').props.onClick())
  expect(view.root.findByType('div').props['data-status']).toBe('ready')
  expect(JSON.stringify(view.toJSON())).toContain('已恢复')
})

it('默认资产列表失败时禁用对应选择器，并提供可恢复的重试入口', async () => {
  setTavernLocale('zh')
  const settings = TavernConfigSchema({})
  const listPresets = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'test', message: '预设目录暂时不可用' } })
    .mockResolvedValue({ ok: true, value: { items: [] } })
  const remote = {
    getSettings: async () => ({ ok: true, value: { settings } }),
    getDataInfo: async () => ({ ok: true, value: { dataHome: 'test-data' } }),
    listPresets,
    listLorebooks: async () => ({ ok: true, value: { items: [] } }),
    listPersonas: async () => ({ ok: true, value: { items: [] } }),
  } as unknown as TavernRemote
  const view = await render(<SettingsSection remote={remote} />)
  await act(async () => view.root.findByType(Tabs).props.onChange('defaults'))
  expect(JSON.stringify(view.toJSON())).toContain('预设目录暂时不可用')
  const preset = () => view.root.findAllByType(Select).find((item) => item.props.value === settings.defaults.presetId)!
  expect(preset().props.disabled).toBe(true)
  await act(async () => view.root.findAllByType(Btn).find((item) => item.props.children === '重试')!.props.onClick())
  expect(listPresets).toHaveBeenCalledTimes(2)
  expect(preset().props.disabled).toBe(false)
})

it('记忆角色目录读取失败时不开放空选择器，重试成功后再解锁', async () => {
  setTavernLocale('zh')
  const listCharacters = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'test', message: '角色目录读取失败' } })
    .mockResolvedValue({ ok: true, value: { items: [{ cardId: 'card', name: '角色' }] } })
  const remote = {
    getEditorDraft: async () => ({ ok: true, value: { draft: null } }),
    saveEditorDraft: async () => ({ ok: true, value: { saved: true } }),
    deleteEditorDraft: async () => ({ ok: true, value: { deleted: true } }),
    listCharacters,
  } as unknown as TavernRemote
  const view = await render(<MemorySection remote={remote} />)
  expect(JSON.stringify(view.toJSON())).toContain('角色目录读取失败')
  expect(view.root.findByType(Select).props.disabled).toBe(true)
  await act(async () => view.root.findAllByType(Btn).find((item) => item.props.children === '重试')!.props.onClick())
  expect(listCharacters).toHaveBeenCalledTimes(2)
  expect(view.root.findByType(Select).props.disabled).toBe(false)
})
