/** 预设面板导出回归：实际点击下载入口，重新导入后保留覆盖纪律、扩展标记和触发场景。 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PresetsSection } from '../src/client/panel/presets.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { IconBtn, downloadJson } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'
import { parseStPreset } from '../src/state/presetStore.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: () => null, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
  IconDownloadOutline16: () => null, IconEditOutline16: () => null, IconFolderOpenOutline16: () => null,
  IconListPenOutline16: () => null, IconTrashOutline16: () => null,
}))
vi.mock('../src/client/util.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/client/util.js')>(), downloadJson: vi.fn() }))

let view: ReactTestRenderer | undefined
afterEach(async () => { await act(async () => view?.unmount()); vi.clearAllMocks() })

it('面板导出并重新导入，保留完整条目语义以及正则和脚本导出策略', async () => {
  setTavernLocale('zh')
  const preset = parseStPreset({ name: '完整预设', identifier: 'complete', prompts: [
    { identifier: 'main', name: '主提示词', content: '规则', forbid_overrides: true, extension: true, injection_trigger: ['continue', 'impersonate'] },
    { identifier: 'tail', content: '深度提示', injection_position: 1, injection_depth: 2, injection_order: 99 },
  ], prompt_order: [{ character_id: 100001, order: [{ identifier: 'tail', enabled: false }, { identifier: 'main', enabled: true }] }],
  extensions: { regex_scripts: [{ id: 'regex', findRegex: 'x', replaceString: 'y' }], tavern_helper: { scripts: [
    { id: 'script', content: '', data: { secret: 7 }, export_with: { data: false } },
  ] } } }).preset
  const remote = {
    listPresets: async () => ({ ok: true, value: { items: [{ id: preset.identifier, name: preset.name, regexCount: 1 }] } }),
    getPreset: async () => ({ ok: true, value: { preset } }),
  } as unknown as TavernRemote
  await act(async () => { view = create(<PresetsSection remote={remote} />) })
  const button = view!.root.findAllByType(IconBtn).find(item => item.props.label === t('presets.export'))!
  await act(async () => { button.props.onClick() })
  expect(downloadJson).toHaveBeenCalledOnce()
  const exported = vi.mocked(downloadJson).mock.calls[0]![1]
  const imported = parseStPreset(exported).preset
  expect(imported.entries).toEqual(preset.entries)
  expect(imported.regexScripts).toEqual(preset.regexScripts)
  expect(imported.helperSettings).toMatchObject({ scripts: [{ data: {} }] })
})
