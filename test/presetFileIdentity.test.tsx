/** 预设编辑定位回归：真实 React 的正文与正则入口透传选中的磁盘 ID，不把定位字段写进预设正文。 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PresetsSection } from '../src/client/panel/presets.js'
import { RegexSection } from '../src/client/panel/regex.js'
import type { TavernRemote } from '../src/client/types.js'
import { Btn, RegexScriptRow } from '../src/client/util.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import type { PromptPreset } from '../src/core/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: () => null, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null, IconEditOutlineMedium: () => null, IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null, IconTrashOutlineMedium: () => null,
}))

const mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T) => ({ ok: true as const, value })
const content: PromptPreset = { identifier: 'my?preset', name: '已有后缀预设', entries: [],
  regexScripts: [{ id: 'display', scriptName: '显示规则', findRegex: 'before', replaceString: 'after', disabled: false }] }
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

it('预设正文保存持续携带选中的后缀文件 ID 与读取版本', async () => {
  const id = 'my_preset-2'
  const savePreset = vi.fn(async () => ok({ id, revision: 'next-revision' }))
  const remote = { listPresets: async () => ok({ items: [{ id, name: content.name, regexCount: 1 }] }),
    getPreset: async () => ok({ preset: content, revision: 'original-revision' }), savePreset } as unknown as TavernRemote
  const view = await render(<PresetsSection remote={remote} />)
  await act(async () => view.root.findByProps({ className: 'dsh-tavern-tile' }).props.onClick())
  await act(async () => view.root.findAllByType('input').find(input => input.props.value === content.name)!.props.onChange({ target: { value: '修改名称' } }))
  await act(async () => view.root.findAllByType(Btn).find(button => button.props.children === t('presets.save'))!.props.onClick())
  expect(savePreset).toHaveBeenLastCalledWith({ id, preset: { ...content, name: '修改名称' }, expectedRevision: 'original-revision' })
  await act(async () => view.root.findAllByType('input').find(input => input.props.value === '修改名称')!.props.onChange({ target: { value: '再次修改' } }))
  await act(async () => view.root.findAllByType(Btn).find(button => button.props.children === t('presets.save'))!.props.onClick())
  expect(savePreset).toHaveBeenLastCalledWith({ id, preset: { ...content, name: '再次修改' }, expectedRevision: 'next-revision' })
})

it('重复 identifier 的预设正则开关各自定位文件，私有编辑元数据不会污染保存正文', async () => {
  const ids = ['my_preset', 'my_preset-2']
  const savePreset = vi.fn(async () => ok({ id: ids[1]!, revision: 'next-revision' }))
  const remote = { listRegexRules: async () => ok({ rules: [], revision: 'global-revision' }),
    listPresets: async () => ok({ items: ids.map(id => ({ id, name: content.name, regexCount: 1 })) }),
    getPreset: async ({ id }: { id: string }) => ok({ preset: content, revision: `revision:${id}` }), savePreset } as unknown as TavernRemote
  const view = await render(<RegexSection remote={remote} />)
  await act(async () => view.root.findAllByType(RegexScriptRow)[1]!.props.onToggle(true))
  expect(savePreset).toHaveBeenLastCalledWith({ id: ids[1], preset: { ...content,
    regexScripts: [{ ...content.regexScripts![0], disabled: true }] }, expectedRevision: `revision:${ids[1]}` })
  expect(view.root.findAllByType(RegexScriptRow)[0]!.props.script.disabled).toBe(false)
  expect(view.root.findAllByType(RegexScriptRow)[1]!.props.script.disabled).toBe(true)
  await act(async () => view.root.findAllByType(RegexScriptRow)[1]!.props.onToggle(false))
  expect(savePreset).toHaveBeenLastCalledWith({ id: ids[1], preset: content, expectedRevision: 'next-revision' })
})
