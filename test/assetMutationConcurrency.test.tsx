/** 资产操作的同步边界：真实 React、宿主配置及文件存储验证重复提交、弹层迟到回调和操作交叉不会改写保存快照。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileSettings } from './hostSettingsFactory.js'
import { Config, TAVERN_NS, resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'
import { PersonasSection } from '../src/client/panel/personas.js'
import { PresetsSection } from '../src/client/panel/presets.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { Btn, ConfirmDialog, Field, IconBtn, Select } from '../src/client/util.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props}/>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>, Toast: () => null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null, IconEditOutlineMedium: () => null, IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null, IconTrashOutlineMedium: () => null,
}))

const contexts: Context[] = [], directories: string[] = [], mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T) => ({ ok: true as const, value })
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-asset-mutation-')), ctx = new Context()
  directories.push(root); contexts.push(ctx)
  const profile = join(root, 'settings.json')
  await writeFile(profile, '{}')
  const scope = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig(scope.get()))
  await state.init()
  const service = new TavernService(ctx, state, scope)
  const remote = {
    listPersonas: vi.fn<TavernRemote['listPersonas']>(async request => ok(await service.listPersonas(request))),
    listLorebooks: async () => ok({ items: ['迟到的世界书'] }),
    savePersona: vi.fn<TavernRemote['savePersona']>(async request => ok(await service.savePersona(request))),
    deletePersona: vi.fn<TavernRemote['deletePersona']>(async request => ok(await service.deletePersona(request))),
    listPresets: vi.fn<TavernRemote['listPresets']>(async request => ok(await service.listPresets(request))),
    getPreset: vi.fn<TavernRemote['getPreset']>(async request => ok(await service.getPreset(request))),
    savePreset: vi.fn<TavernRemote['savePreset']>(async request => ok(await service.savePreset(request))),
    deletePreset: vi.fn<TavernRemote['deletePreset']>(async request => ok(await service.deletePreset(request))),
    updateSettings: vi.fn<TavernRemote['updateSettings']>(async request => ok(await service.updateSettings(request))),
  } as unknown as TavernRemote
  return { state, service, remote }
}
async function render(node: ReactNode, waitItems = true) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  if (waitItems) await act(async () => { await vi.waitFor(() => expect(view.root.findAllByProps({ className: 'dsh-tavern-tile' }).length).toBeGreaterThan(0)) })
  return view
}
const button = (view: ReactTestRenderer, label: string) => view.root.findAllByType(Btn).find(item => item.props.children === label)!
const tile = (view: ReactTestRenderer, name: string) => view.root.findAllByProps({ className: 'dsh-tavern-tile' })
  .find(item => item.findAllByProps({ className: 'dsh-tavern-tileName' }).some(label => label.children.join('') === name))!

it('人设保存前同步拦截重复保存、交叉默认项及迟到世界书回调，成功后按原快照落盘', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  const persona = { id: 'port', name: '港口', description: '原始描述', avatar: null, lorebookId: null }
  await f.state.savePersona(persona)
  vi.mocked(f.remote.savePersona).mockImplementationOnce(async request => { await gate.promise; return ok(await f.service.savePersona(request)) })
  const view = await render(<PersonasSection remote={f.remote}/>)
  await act(async () => tile(view, '港口').props.onClick())
  await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '提交的描述' } }))
  const save = button(view, t('action.save')).props.onClick
  const select = view.root.findByType(Select).props.onChange
  try {
    await act(async () => { save(); save(); button(view, t('personas.setDefault')).props.onClick(); select('迟到的世界书') })
    expect(f.remote.savePersona).toHaveBeenCalledOnce()
    expect(f.remote.updateSettings).not.toHaveBeenCalled()
    expect(view.root.findByType(Select).props.disabled).toBe(true)
    await act(async () => select('迟到的世界书'))
    expect(view.root.findByType(Select).props.value).toBe('')
  } finally { await act(async () => { gate.resolve(); await vi.mocked(f.remote.savePersona).mock.results[0]!.value }) }
  expect(await f.state.loadPersona(persona.id)).toEqual({ ...persona, description: '提交的描述' })
  expect(view.root.findByType('textarea').props.value).toBe('提交的描述')
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  await act(async () => { await vi.waitFor(() => expect(button(view, t('personas.setDefault'))).toBeDefined()) })
  await act(async () => button(view, t('personas.setDefault')).props.onClick())
  expect(f.remote.updateSettings).toHaveBeenCalledOnce()
})

it('预设设置默认项期间拒绝重复写入、保存、导出读取与迟到字段回调，完成后仍能保存原资产', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  const id = await f.state.savePreset({ identifier: 'port', name: '港口预设', entries: [{ identifier: 'main', name: '主提示词', content: '原正文',
    enabled: true, role: 'system', position: 'relative', depth: 4, order: 100, marker: false }] })
  vi.mocked(f.remote.updateSettings).mockImplementationOnce(async request => { await gate.promise; return ok(await f.service.updateSettings(request)) })
  const view = await render(<PresetsSection remote={f.remote}/>)
  await act(async () => tile(view, '港口预设').props.onClick())
  await act(async () => { await vi.waitFor(() => expect(view.root.findAllByType('fieldset')).toHaveLength(1)) })
  await act(async () => view.root.findAllByType('input').find(input => input.props.value === '港口预设')!.props.onChange({ target: { value: '修改的预设名' } }))
  const setDefault = button(view, t('presets.setAsDefault')).props.onClick
  const save = button(view, t('presets.save')).props.onClick
  const exportPreset = view.root.findAllByType(IconBtn).find(item => item.props.label === t('presets.export'))!.props.onClick
  const role = view.root.findAllByType(Select)[0]!.props.onChange
  try {
    await act(async () => { setDefault(); setDefault(); save(); exportPreset(); role('user') })
    expect(f.remote.updateSettings).toHaveBeenCalledOnce()
    expect(f.remote.savePreset).not.toHaveBeenCalled()
    expect(f.remote.getPreset).toHaveBeenCalledOnce()
    expect(view.root.findByType('fieldset').props.disabled).toBe(true)
    expect(view.root.findAllByType(Select).every(select => select.props.disabled)).toBe(true)
    expect(view.root.findAllByType(Select)[0]!.props.value).toBe('system')
  } finally { await act(async () => { gate.resolve(); await vi.mocked(f.remote.updateSettings).mock.results[0]!.value }) }
  await act(async () => { save(); await vi.mocked(f.remote.savePreset).mock.results[0]!.value })
  expect((await f.service.getPreset({ id })).preset.name).toBe('修改的预设名')
  expect((await f.service.getPreset({ id })).preset.entries[0]!.role).toBe('system')
  expect(f.service.getSettings({}).settings.defaults.presetId).toBe(id)
})

it.each(['persona', 'preset'] as const)('%s 删除确认同批触发两次仍只删除一次，且不能开始另一项默认写入', async kind => {
  const f = await fixture(), gate = Promise.withResolvers<void>()
  if (kind === 'persona') await f.state.savePersona({ id: 'port', name: '港口', description: '', avatar: null })
  else await f.state.savePreset({ identifier: 'port', name: '港口', entries: [] })
  const remove = kind === 'persona' ? f.remote.deletePersona : f.remote.deletePreset
  vi.mocked(remove).mockImplementationOnce(async request => {
    await gate.promise
    return ok(kind === 'persona' ? await f.service.deletePersona(request) : await f.service.deletePreset(request))
  })
  const view = await render(kind === 'persona' ? <PersonasSection remote={f.remote}/> : <PresetsSection remote={f.remote}/>)
  await act(async () => view.root.findAllByType(IconBtn).find(item => item.props.label === t(kind === 'persona' ? 'personas.delete' : 'presets.delete'))!.props.onClick())
  const dialog = view.root.findAllByType(ConfirmDialog).find(item => item.props.open)!
  try {
    await act(async () => { dialog.props.onConfirm(); dialog.props.onConfirm(); button(view, t(kind === 'persona' ? 'personas.setDefault' : 'presets.setAsDefault')).props.onClick() })
    expect(remove).toHaveBeenCalledOnce()
    expect(f.remote.updateSettings).not.toHaveBeenCalled()
  } finally { await act(async () => { gate.resolve(); await vi.mocked(remove).mock.results[0]!.value }) }
  expect(kind === 'persona' ? await f.state.loadPersona('port') : await f.state.loadPreset('port')).toBeNull()
})

it.each(['persona', 'preset'] as const)('两个窗口同毫秒新建 %s，保存为独立资产且不产生自身版本冲突', async kind => {
  const f = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(1_793_444_000_000)
  const Component = kind === 'persona' ? PersonasSection : PresetsSection
  const views = [await render(<Component remote={f.remote}/>, false), await render(<Component remote={f.remote}/>, false)]
  for (const [index, view] of views.entries()) {
    await act(async () => button(view, t(kind === 'persona' ? 'personas.new' : 'presets.new')).props.onClick())
    await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: `新建资产 ${index}` } }))
  }
  const save = kind === 'persona' ? f.remote.savePersona : f.remote.savePreset
  await act(async () => {
    for (const view of views) button(view, t(kind === 'persona' ? 'action.save' : 'presets.save')).props.onClick()
    await Promise.allSettled(vi.mocked(save).mock.results.map(result => result.value))
  })
  const items = kind === 'persona' ? await f.state.listPersonas() : (await f.service.listPresets({})).items
  expect(items.map(item => item.name).sort()).toEqual(['新建资产 0', '新建资产 1'])
  for (const view of views) expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('同毫秒删除早先条目后新增预设条目，仍保留独立身份且可以保存两份正文', async () => {
  const f = await fixture()
  vi.spyOn(Date, 'now').mockReturnValue(1_793_444_000_000)
  const view = await render(<PresetsSection remote={f.remote}/>, false)
  await act(async () => button(view, t('presets.new')).props.onClick())
  await act(async () => button(view, t('presets.addEntry')).props.onClick())
  await act(async () => view.root.findAllByType(IconBtn).find(item => item.props.label === t('presets.entry.delete'))!.props.onClick())
  await act(async () => button(view, t('presets.addEntry')).props.onClick())
  for (let index = 0; index < 2; index++) await act(async () => view.root.findAllByType('textarea')[index]!.props.onChange({ target: { value: `正文 ${index}` } }))
  await act(async () => {
    button(view, t('presets.save')).props.onClick()
    await Promise.allSettled(vi.mocked(f.remote.savePreset).mock.results.map(result => result.value))
  })
  const saved = await f.service.listPresets({})
  expect(saved.items).toHaveLength(1)
  const preset = (await f.service.getPreset({ id: saved.items[0]!.id })).preset
  expect(preset.entries.map(entry => entry.content)).toEqual(['正文 0', '正文 1'])
  expect(new Set(preset.entries.map(entry => entry.identifier)).size).toBe(2)
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('同毫秒新增的两条正则规则使用独立身份，保存后删除一条不会串到另一条', async () => {
  const f = await fixture()
  f.remote.listRegexRules = vi.fn(async request => ok(await f.service.listRegexRules(request)))
  f.remote.saveRegexRules = vi.fn(async request => ok(await f.service.saveRegexRules(request)))
  vi.spyOn(Date, 'now').mockReturnValue(1_793_444_000_000)
  const view = await render(<RegexSection remote={f.remote}/>, false)
  await act(async () => { await vi.waitFor(() => expect(button(view, t('regex.new'))).toBeDefined()) })
  for (let index = 0; index < 2; index++) {
    await act(async () => button(view, t('regex.new')).props.onClick())
    await act(async () => view.root.findAllByType(Field).filter(field => field.props.label === t('regex.find'))[index]!.findByType('input').props.onChange({ target: { value: `source-${index}` } }))
  }
  await act(async () => { button(view, t('regex.saveAll')).props.onClick(); await vi.mocked(f.remote.saveRegexRules).mock.results[0]!.value })
  const rules = (await f.service.listRegexRules({})).rules
  expect(new Set(rules.map(rule => rule.id)).size).toBe(2)
  await act(async () => view.root.findAllByType(IconBtn).find(item => item.props.label === t('regex.deleteRule'))!.props.onClick())
  await act(async () => { button(view, t('regex.saveAll')).props.onClick(); await vi.mocked(f.remote.saveRegexRules).mock.results[1]!.value })
  expect((await f.service.listRegexRules({})).rules.map(rule => [rule.id, rule.find])).toEqual([[rules[1]!.id, 'source-1']])
})
