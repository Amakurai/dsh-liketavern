/** 设置保存并发回归：真实 React 与延迟 remote 验证重复写入、语言迟到回包和失败重试。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsSection } from '../src/client/panel/settings.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { Btn, NumInput, Select, Tabs } from '../src/client/util.js'
import type { TavernRemote, TavernSettings } from '../src/client/types.js'
import { resolveConfig, TavernConfigSchema, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
beforeEach(() => { setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })
function fixture() {
  let settings: TavernSettings = TavernConfigSchema({})
  const updateSettings = vi.fn<TavernRemote['updateSettings']>(async request => {
    settings = TavernConfigSchema({ ...settings, ...(request.patch as object) })
    return ok({ settings: structuredClone(settings) })
  })
  const remote = { getSettings: async () => ok({ settings: structuredClone(settings) }), updateSettings,
    getDataInfo: async () => ok({ dataHome: 'test-data' }), listPresets: async () => ok({ items: [] }),
    listPersonas: async () => ok({ items: [] }), listLorebooks: async () => ok({ items: [] }),
  } as unknown as TavernRemote
  return { remote, updateSettings, settings: () => settings, apply: (patch: object) => { settings = TavernConfigSchema({ ...settings, ...patch }); return structuredClone(settings) } }
}
async function render(f: ReturnType<typeof fixture>, sub = 'interface') {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<SettingsSection remote={f.remote} />) })
  mounted.push(view)
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange(sub))
  return view
}
const button = (view: ReactTestRenderer, key: string) => view.root.findAllByType(Btn).find(item => item.props.children === t(key))!

it('同批语言切换只接受首个请求，锁住后续选择并保持界面与持久语言一致', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  f.updateSettings.mockImplementation(async request => {
    if ((request.patch as { locale: string }).locale === 'en') await gate.promise
    return ok({ settings: f.apply(request.patch as object) })
  })
  const view = await render(f)
  const change = view.root.findByType(Select).props.onChange
  await act(async () => { change('en'); change('zh') })
  expect(f.updateSettings).toHaveBeenCalledExactlyOnceWith({ patch: { locale: 'en' } })
  expect(view.root.findByType(Select).props.value).toBe('en')
  expect(view.root.findByType('fieldset').props.disabled).toBe(true)
  await act(async () => view.root.findByType(Select).props.onChange('zh'))
  expect(f.updateSettings).toHaveBeenCalledOnce()
  expect(view.root.findByType(Select).props.value).toBe('en')
  await act(async () => gate.resolve())
  expect(view.root.findByType(Select).props.value).toBe('en')
  expect(f.settings().locale).toBe('en')
  expect(view.root.findByType('fieldset').props.disabled).toBe(false)
  await act(async () => view.root.findByType(Select).props.onChange('zh'))
  expect(view.root.findByType(Select).props.value).toBe('zh')
  expect(f.settings().locale).toBe('zh')
})

it('同批重复保存只发一次请求，保存期间不能触发语言写入', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  f.updateSettings.mockImplementation(async request => { await gate.promise; return ok({ settings: f.apply(request.patch as object) }) })
  const view = await render(f)
  const locale = view.root.findByType(Select).props.onChange
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange('sampling'))
  await act(async () => view.root.findAllByType(NumInput)[0]!.props.onChange(0.7))
  const save = button(view, 'settings.sampling.save').props.onClick
  await act(async () => { save(); save(); locale('en') })
  expect(f.updateSettings).toHaveBeenCalledOnce()
  expect(f.updateSettings.mock.calls[0]![0]).toMatchObject({ patch: { sampling: { temperature: 0.7 } } })
  expect(view.root.findByType('fieldset').props.disabled).toBe(true)
  await act(async () => gate.resolve())
  expect(f.settings().sampling.temperature).toBe(0.7)
  expect(f.settings().locale).toBe('auto')
  expect(view.root.findByType('fieldset').props.disabled).toBe(false)
})

it('语言写入与普通组保存共用锁，迟到组回调不能覆盖已选择语言', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>()
  f.updateSettings.mockImplementation(async request => { await gate.promise; return ok({ settings: f.apply(request.patch as object) }) })
  const view = await render(f, 'sampling')
  const save = button(view, 'settings.sampling.save').props.onClick
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange('interface'))
  await act(async () => { view.root.findByType(Select).props.onChange('en'); save(); save() })
  expect(f.updateSettings).toHaveBeenCalledExactlyOnceWith({ patch: { locale: 'en' } })
  await act(async () => gate.resolve())
  expect(view.root.findByType(Select).props.value).toBe('en')
  expect(f.settings().locale).toBe('en')
})

it.each(['envelope', 'transport'] as const)('组保存失败保留所有草稿并解锁，重试只保存当前组：%s', async failure => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['updateSettings']>>>()
  f.updateSettings.mockImplementationOnce(() => pending.promise)
  const view = await render(f, 'sampling')
  await act(async () => view.root.findAllByType(NumInput)[0]!.props.onChange(0.7))
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange('memory'))
  await act(async () => view.root.findAllByType(NumInput)[0]!.props.onChange(321))
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange('sampling'))
  await act(async () => button(view, 'settings.sampling.save').props.onClick())
  if (failure === 'envelope') await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '配置写入暂时失败' } }))
  else await act(async () => pending.reject(new Error('配置写入暂时失败')))
  expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('配置写入暂时失败')
  expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.7)
  expect(view.root.findByType('fieldset').props.disabled).toBe(false)
  await act(async () => button(view, 'settings.sampling.save').props.onClick())
  expect(f.settings().sampling.temperature).toBe(0.7)
  await act(async () => view.root.findAllByType(Tabs)[0]!.props.onChange('memory'))
  expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(321)
  expect(f.settings().memory.maxEntries).toBe(200)
  await act(async () => button(view, 'settings.memory.save').props.onClick())
  expect(f.settings().memory.maxEntries).toBe(321)
})

it.each(['envelope', 'transport'] as const)('语言保存失败回退原语言并释放共享锁，随后重试成功：%s', async failure => {
  const f = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['updateSettings']>>>()
  f.updateSettings.mockImplementationOnce(() => pending.promise)
  const view = await render(f)
  await act(async () => view.root.findByType(Select).props.onChange('en'))
  if (failure === 'envelope') await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '语言写入暂时失败' } }))
  else await act(async () => pending.reject(new Error('语言写入暂时失败')))
  expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('语言写入暂时失败')
  expect(view.root.findByType(Select).props.value).toBe('auto')
  expect(f.settings().locale).toBe('auto')
  expect(view.root.findByType('fieldset').props.disabled).toBe(false)
  await act(async () => view.root.findByType(Select).props.onChange('zh'))
  expect(f.updateSettings).toHaveBeenCalledTimes(2)
  expect(view.root.findByType(Select).props.value).toBe('zh')
  expect(f.settings().locale).toBe('zh')
})

/** 服务接到配置宿主的真实 JSON 文件，UI 重复事件必须在 host update 发生前就被截断。 */
it('真实 FS 与 TavernService 中重复保存只写一次宿主配置并保留提交值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tavern-settings-save-race-'))
  try {
    const f = fixture(), profile = join(directory, 'profile.json'), gate = Promise.withResolvers<void>()
    await writeFile(profile, JSON.stringify(f.settings()), 'utf8')
    const update = vi.fn<TavernSettingsScope['update']>(async patch => { await writeFile(profile, JSON.stringify(f.apply(patch)), 'utf8') })
    const scope: TavernSettingsScope = { get: () => f.settings(), update }
    const state = new TavernState({ root: directory, characters: join(directory, 'characters'), lorebooks: join(directory, 'lorebooks'),
      presets: join(directory, 'presets'), personas: join(directory, 'personas'), regexDir: join(directory, 'regex'), sessions: join(directory, 'sessions') }, () => resolveConfig(scope.get()))
    await state.init()
    const ctx = { reflect: { provide: () => {} }, get: () => undefined } as unknown as Context
    const service = new TavernService(ctx, state, scope)
    f.remote.getSettings = async () => ok(service.getSettings({}))
    f.updateSettings.mockImplementation(async request => { await gate.promise; return ok(await service.updateSettings(request)) })
    const view = await render(f, 'sampling')
    await act(async () => view.root.findAllByType(NumInput)[0]!.props.onChange(0.7))
    const save = button(view, 'settings.sampling.save').props.onClick
    await act(async () => { save(); save() })
    expect(f.updateSettings).toHaveBeenCalledOnce()
    await act(async () => { gate.resolve(); await f.updateSettings.mock.results[0]!.value })
    expect(update).toHaveBeenCalledOnce()
    const persisted: unknown = JSON.parse(await readFile(profile, 'utf8'))
    expect(persisted).toMatchObject({ sampling: { temperature: 0.7 }, locale: 'auto' })
    expect(view.root.findAllByType(NumInput)[0]!.props.value).toBe(0.7)
    expect(view.root.findByType('fieldset').props.disabled).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
