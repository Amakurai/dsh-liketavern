/** 设置分区恢复回归：模拟草稿快照与远端设置，验证首次读取不覆盖恢复内容、空快照可正常初始化。 */
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSection } from '../src/client/panel/settings.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, NumInput } from '../src/client/util.js'
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

  it('加载中保存的 null 快照不会锁死页面，仍可接收首次远端数据', async () => {
    snapshot.initial = { 'settings:sub': 'sampling', 'settings:draft': null, 'settings:baseline': null }
    const view = await render(remote(async () => ok({ settings: settings(0.8) })))
    expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.8)
    expect(snapshot.observed['settings:draft']).toEqual(settings(0.8))
    expect(snapshot.observed['settings:baseline']).toEqual(settings(0.8))
  })
})
