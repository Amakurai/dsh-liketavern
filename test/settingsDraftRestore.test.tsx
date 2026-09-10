/** 设置分区恢复回归：模拟草稿快照与远端设置，验证首次读取不覆盖恢复内容、空快照可正常初始化。 */
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSection } from '../src/client/panel/settings.js'
import { getTavernLocale, setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, NumInput, Select, Tabs } from '../src/client/util.js'
import { TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import type { TavernRemote } from '../src/client/types.js'

const snapshot = vi.hoisted(() => ({ initial: {} as Record<string, unknown>, observed: {} as Record<string, unknown> }))

/** 此处只提供已恢复的快照；被测设置页仍运行真实 React 状态、加载与保存逻辑。 */
vi.mock('../src/client/draftPersistence.js', async (importOriginal) => {
  const React = await import('react')
  const actual = await importOriginal<typeof import('../src/client/draftPersistence.js')>()
  return {
    ...actual,
    useDraftState: <T,>(key: string, initial: T | (() => T)) => {
      const pair = React.useState<T>(() => Object.hasOwn(snapshot.initial, key)
        ? snapshot.initial[key] as T : typeof initial === 'function' ? (initial as () => T)() : initial)
      snapshot.observed[key] = pair[0]
      return pair
    },
    useDraftRestored: (key: string) => React.useRef(Object.hasOwn(snapshot.initial, key)).current,
  }
})

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode }) => props.open ? <div>{props.children}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
}))

const mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T) => ({ ok: true as const, value })
function settings(temperature: number): TavernConfigRaw {
  const value = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
  return { ...value, sampling: { ...value.sampling, temperature } }
}
function remote(getSettings: () => Promise<ReturnType<typeof ok<{ settings: TavernConfigRaw }>>>) {
  return {
    getSettings,
    getDataInfo: async () => ok({ dataHome: 'test-data' }),
    listPresets: async () => ok({ items: [] }), listLorebooks: async () => ok({ items: [] }), listPersonas: async () => ok({ items: [] }),
    updateSettings: vi.fn(async () => ok({ settings: settings(0.9) })),
  } as unknown as TavernRemote
}
async function render(api: TavernRemote) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<SettingsSection remote={api} />) })
  mounted.push(view)
  return view
}
beforeEach(() => { snapshot.initial = {}; snapshot.observed = {}; setTavernLocale('zh') })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

describe('设置草稿恢复', () => {
  it.each([false, true])('分区保存同步其它未编辑字段，并保留实际编辑的草稿：%s', async (hasOtherDraft) => {
    const old = settings(0.4), edited = settings(0.9), saved = settings(0.9)
    saved.triggerLogRetention = old.triggerLogRetention + 10
    saved.memory.maxEntries = old.memory.maxEntries + 20
    if (hasOtherDraft) edited.memory.maxEntries = old.memory.maxEntries + 5
    snapshot.initial = { 'settings:sub': 'sampling', 'settings:baseline': old, 'settings:draft': edited }
    const api = remote(async () => ok({ settings: old }))
    vi.mocked(api.updateSettings).mockResolvedValue(ok({ settings: saved }))
    const view = await render(api)
    await act(async () => view.root.findAllByType(Btn).find(button => button.props.primary)!.props.onClick())
    const draft = snapshot.observed['settings:draft'] as TavernConfigRaw
    expect(draft.triggerLogRetention).toBe(saved.triggerLogRetention)
    expect(draft.memory.maxEntries).toBe(hasOtherDraft ? edited.memory.maxEntries : saved.memory.maxEntries)
    expect(snapshot.observed['settings:baseline']).toEqual(saved)
    if (!hasOtherDraft) expect(draft).toEqual(saved)
  })

  it.each(['transport', 'envelope'])('语言保存失败恢复原来的语言、选择和基线：%s', async (failure) => {
    const initial = { ...settings(0.4), locale: 'zh' as const }
    snapshot.initial = { 'settings:sub': 'interface' }
    const api = remote(async () => ok({ settings: initial }))
    if (failure === 'transport') vi.mocked(api.updateSettings).mockRejectedValue(new Error('连接中断'))
    else vi.mocked(api.updateSettings).mockResolvedValue({ ok: false, error: { code: 'TEST', message: '连接中断' } })
    const view = await render(api)
    await act(async () => view.root.findByType(Select).props.onChange('en'))
    expect(getTavernLocale()).toBe('zh')
    expect((snapshot.observed['settings:draft'] as TavernConfigRaw).locale).toBe('zh')
    expect(snapshot.observed['settings:baseline']).toEqual(initial)
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('连接中断')
    expect(view.root.findByType('fieldset').props.disabled).toBe(false)
  })

  it('首次远端读取保留恢复的字段与基线，保存提交恢复内容而非服务器旧值', async () => {
    const old = settings(0.4)
    const edited = settings(0.9)
    snapshot.initial = { 'settings:sub': 'sampling', 'settings:draft': edited, 'settings:baseline': old }
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ settings: TavernConfigRaw }>>>()
    const api = remote(() => pending.promise)
    const view = await render(api)
    await act(async () => pending.resolve(ok({ settings: settings(0.6) })))
    expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.9)
    expect(snapshot.observed['settings:baseline']).toEqual(old)
    expect(snapshot.observed['settings:draft']).toEqual(edited)
    const save = view.root.findAllByType(Btn).find((button) => button.props.primary)!
    await act(async () => save.props.onClick())
    expect(api.updateSettings).toHaveBeenCalledWith({ patch: { sampling: edited.sampling } })
    expect(snapshot.observed['settings:baseline']).toEqual(settings(0.9))
  })

  it('没有恢复正文时从远端初始化，恢复的子页位置继续有效', async () => {
    snapshot.initial = { 'settings:sub': 'sampling' }
    const view = await render(remote(async () => ok({ settings: settings(0.7) })))
    expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.7)
    expect(snapshot.observed['settings:draft']).toEqual(settings(0.7))
    expect(snapshot.observed['settings:baseline']).toEqual(settings(0.7))
  })

  it('设置草稿未保存时切换子组直接生效且不弹放弃确认，草稿保留；点当前子组不触发任何操作', async () => {
    const old = settings(0.4), edited = settings(0.9)
    snapshot.initial = { 'settings:sub': 'sampling', 'settings:baseline': old, 'settings:draft': edited }
    const view = await render(remote(async () => ok({ settings: old })))
    const openDialogs = () => view.root.findAllByType(ConfirmDialog).filter((dialog) => dialog.props.open)
    await act(async () => view.root.findByType(Tabs).props.onChange('sampling'))
    expect(openDialogs()).toHaveLength(0)
    expect(snapshot.observed['settings:sub']).toBe('sampling')
    await act(async () => view.root.findByType(Tabs).props.onChange('memory'))
    expect(openDialogs()).toHaveLength(0)
    expect(snapshot.observed['settings:sub']).toBe('memory')
    expect(snapshot.observed['settings:draft']).toEqual(edited)
    expect(view.root.findByProps({ role: 'tabpanel' }).props['aria-labelledby']).toMatch(/-memory$/)
  })

  it('加载中保存的 null 快照不会锁死页面，仍可接收首次远端数据', async () => {
    snapshot.initial = { 'settings:sub': 'sampling', 'settings:draft': null, 'settings:baseline': null }
    const view = await render(remote(async () => ok({ settings: settings(0.8) })))
    expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.8)
    expect(snapshot.observed['settings:draft']).toEqual(settings(0.8))
    expect(snapshot.observed['settings:baseline']).toEqual(settings(0.8))
  })
})
