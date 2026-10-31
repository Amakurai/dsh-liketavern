/** 默认资产快捷操作：真实宿主设置、文件持久化与 React 界面验证多窗口保存不会覆盖无关默认项。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { Btn } from '../src/client/util.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}/>,
  Modal: () => null, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconEditOutlineMedium: () => null, IconTrashOutlineMedium: () => null, IconDownloadOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null, IconListPenOutlineMedium: () => null,
}))

const contexts: Context[] = [], directories: string[] = [], mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T) => ({ ok: true as const, value })
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['preset', 'persona'] as const)('设为默认 %s 时保留另一窗口刚保存的其它默认项，重启后仍一致', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-default-asset-'))
  directories.push(root)
  const profile = join(root, 'settings.json')
  await writeFile(profile, JSON.stringify({ [TAVERN_NS]: { defaults: {
    cardId: 'old-card', presetId: 'old-preset', personaId: 'old-persona', lorebookIds: ['old-book'], characterLorebookId: 'old-main',
  } } }))
  const ctx = new Context()
  contexts.push(ctx)
  const scope = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig(scope.get()))
  const service = new TavernService(ctx, state, scope)
  const gate = Promise.withResolvers<void>()
  const updateSettings = vi.fn<TavernRemote['updateSettings']>(async request => { await gate.promise; return ok(await service.updateSettings(request)) })
  const remote = {
    getSettings: async () => ok(service.getSettings({})), updateSettings,
    listPresets: async () => ok({ items: [{ id: 'chosen-preset', name: '所选预设', entryCount: 0, regexCount: 0 }] }),
    listPersonas: async () => ok({ items: [{ id: 'chosen-persona', name: '所选人设', description: '', avatar: null }] }),
    listLorebooks: async () => ok({ items: [] }),
  } as unknown as TavernRemote
  let view!: ReactTestRenderer
  await act(async () => { view = create(kind === 'preset' ? <PresetsSection remote={remote}/> : <PersonasSection remote={remote}/>) })
  mounted.push(view)
  await act(async () => { view.root.findAllByType(Btn).find(item => item.props.children === t(kind === 'preset' ? 'presets.setAsDefault' : 'personas.setDefault'))!.props.onClick() })
  expect(updateSettings).toHaveBeenCalledOnce()
  // 请求已离开旧界面而尚未写入时，另一窗口先保存其它默认配置。
  const otherDefaults = { cardId: 'new-card', lorebookIds: ['new-book'], characterLorebookId: 'new-main',
    ...(kind === 'preset' ? { personaId: 'other-persona' } : { presetId: 'other-preset' }) }
  await service.updateSettings({ patch: { defaults: otherDefaults } })
  await act(async () => { gate.resolve(); await updateSettings.mock.results[0]!.value })
  const expected = { ...otherDefaults, ...(kind === 'preset' ? { presetId: 'chosen-preset' } : { personaId: 'chosen-persona' }) }
  expect(service.getSettings({}).settings.defaults).toEqual(expected)
  const persisted: unknown = JSON.parse(await readFile(profile, 'utf8'))
  expect(persisted).toMatchObject({ [TAVERN_NS]: { defaults: expected } })
  const restarted = new Context()
  contexts.push(restarted)
  expect((await new FileSettings(restarted, profile).register(TAVERN_NS, Config)).get().defaults).toEqual(expected)
})
