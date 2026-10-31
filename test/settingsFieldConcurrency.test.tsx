/** 设置分组保存的字段竞争：真实宿主与 React 验证只保存编辑项，并把其它分组的未保存草稿叠到最新配置。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileSettings } from './hostSettingsFactory.js'
import { Config, TAVERN_NS, resolveConfig } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { SettingsSection } from '../src/client/panel/settings.js'
import { Btn, LineListInput, NumInput, Select, Tabs, Toggle } from '../src/client/util.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}/>,
  Modal: () => null, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))
const contexts: Context[] = [], directories: string[] = [], mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T) => ({ ok: true as const, value })
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(initial: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-settings-fields-')), profile = join(root, 'settings.json'), ctx = new Context()
  directories.push(root); contexts.push(ctx)
  await writeFile(profile, JSON.stringify({ [TAVERN_NS]: initial }))
  const scope = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig(scope.get()))
  const service = new TavernService(ctx, state, scope), gate = Promise.withResolvers<void>()
  const update = vi.fn<TavernRemote['updateSettings']>(async request => { await gate.promise; return ok(await service.updateSettings(request)) })
  const remote = { getSettings: async () => ok(service.getSettings({})), updateSettings: update,
    getDataInfo: async () => ok({ dataHome: 'test-data' }), listLorebooks: async () => ok({ items: ['new-book'] }),
    listPresets: async () => ok({ items: [{ id: 'chosen', name: '所选预设', entryCount: 0, regexCount: 0 }] }),
    listPersonas: async () => ok({ items: [] }),
  } as unknown as TavernRemote
  let view!: ReactTestRenderer
  await act(async () => { view = create(<SettingsSection remote={remote}/>) })
  mounted.push(view)
  return { scope, profile, gate, update, view }
}
const tab = async (view: ReactTestRenderer, id: string) => act(async () => view.root.findByType(Tabs).props.onChange(id))
const save = async (view: ReactTestRenderer, id: string) => act(async () => {
  view.root.findAllByType(Btn).find(item => item.props.children === t(`settings.${id}.save`))!.props.onClick()
})

it.each(['sampling', 'defaults', 'prompts'] as const)('保存 %s 中一个字段不覆盖另一窗口刚修改的同组字段', async group => {
  const f = await fixture()
  await tab(f.view, group)
  await act(async () => {
    if (group === 'sampling') f.view.root.findAllByType(NumInput)[0]!.props.onChange(0.7)
    else if (group === 'defaults') f.view.root.findAllByType(Select)[0]!.props.onChange('chosen')
    else f.view.root.findAllByType(Toggle)[0]!.props.onChange(false)
  })
  await save(f.view, group)
  expect(f.update).toHaveBeenCalledOnce()
  const other = group === 'sampling' ? { sampling: { maxTokens: 1234, stop: ['END'] } }
    : group === 'defaults' ? { defaults: { personaId: 'other-persona', lorebookIds: ['new-book'] } }
    : { prompts: { cacheFirstLayout: true } }
  await f.scope.update(other)
  await act(async () => { f.gate.resolve(); await f.update.mock.results[0]!.value })
  const expected = group === 'sampling' ? { sampling: { temperature: 0.7, maxTokens: 1234, stop: ['END'] } }
    : group === 'defaults' ? { defaults: { presetId: 'chosen', personaId: 'other-persona', lorebookIds: ['new-book'] } }
    : { prompts: { preferCharacterPrompt: false, cacheFirstLayout: true } }
  expect(f.scope.get()).toMatchObject(expected)
  expect(JSON.parse(await readFile(f.profile, 'utf8'))).toMatchObject({ [TAVERN_NS]: expected })
})

it('保存其它分组后只保留真实编辑的草稿，未编辑字段接收最新服务器配置，之后保存也不回写旧值', async () => {
  const f = await fixture()
  await tab(f.view, 'prompts')
  await act(async () => f.view.root.findAllByType(Toggle)[0]!.props.onChange(false))
  await tab(f.view, 'sampling')
  await act(async () => f.view.root.findAllByType(NumInput)[0]!.props.onChange(0.7))
  await save(f.view, 'sampling')
  await f.scope.update({ prompts: { cacheFirstLayout: true } })
  await act(async () => { f.gate.resolve(); await f.update.mock.results[0]!.value })
  await tab(f.view, 'prompts')
  const toggles = f.view.root.findAllByType(Toggle)
  expect(toggles[0]!.props.checked).toBe(false)
  expect(toggles[2]!.props.checked).toBe(true)
  await save(f.view, 'prompts')
  await act(async () => { await f.update.mock.results[1]!.value })
  expect(f.scope.get().prompts).toMatchObject({ preferCharacterPrompt: false, cacheFirstLayout: true })
})

it('清空停止词数组会持久化，同时保留另一窗口修改的采样字段', async () => {
  const f = await fixture({ sampling: { stop: ['OLD'] } })
  await tab(f.view, 'sampling')
  await act(async () => f.view.root.findByType(LineListInput).props.onChange([]))
  await save(f.view, 'sampling')
  await f.scope.update({ sampling: { temperature: 0.9 } })
  await act(async () => { f.gate.resolve(); await f.update.mock.results[0]!.value })
  expect(f.scope.get().sampling).toMatchObject({ temperature: 0.9, stop: [] })
})

it('保存过程中迟到的下拉选择不能修改已冻结的采样草稿', async () => {
  const f = await fixture()
  await tab(f.view, 'sampling')
  const oldValue = f.view.root.findByType(Select).props.value
  const delayedChoice = f.view.root.findByType(Select).props.onChange as (value: string) => void
  await act(async () => f.view.root.findAllByType(NumInput)[0]!.props.onChange(0.7))
  await save(f.view, 'sampling')
  await act(async () => delayedChoice('high'))
  expect(f.view.root.findByType(Select).props.value).toBe(oldValue)
  await act(async () => { f.gate.resolve(); await f.update.mock.results[0]!.value })
  expect(f.scope.get().sampling).toMatchObject({ temperature: 0.7, thinking: oldValue })
})
