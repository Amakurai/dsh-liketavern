/** 预设选择并发回归：真实 React 与延迟读取保证迟到资产不能替换最后选择的未保存正文。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PresetsSection } from '../src/client/panel/presets.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import type { PromptPreset } from '../src/core/types.js'
import type { TavernRemote } from '../src/client/types.js'
import { Btn, ConfirmDialog } from '../src/client/util.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null, IconEditOutlineMedium: () => null, IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null, IconTrashOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const content = (id: string): PromptPreset => ({ identifier: id, name: id === 'port' ? '港口' : '灯塔', entries: [{ identifier: 'main', name: '正文', enabled: true,
  role: 'system', position: 'relative', depth: 4, order: 100, content: `${id}原始正文`, marker: false }] })
const mounted: ReactTestRenderer[] = []
beforeEach(() => { setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })
function fixture() {
  const port = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getPreset']>>>()
  const lighthouse = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getPreset']>>>()
  const getPreset = vi.fn<TavernRemote['getPreset']>(request => request.id === 'port' ? port.promise : lighthouse.promise)
  const remote = { listPresets: async () => ok({ items: ['port', 'lighthouse'].map(id => ({ id, name: content(id).name, regexCount: 0 })) }), getPreset } as unknown as TavernRemote
  return { remote, getPreset, port, lighthouse }
}
async function render(f: ReturnType<typeof fixture>) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<PresetsSection remote={f.remote} />) })
  mounted.push(view)
  return view
}
async function selectBoth(view: ReactTestRenderer) {
  const tiles = view.root.findAllByProps({ className: 'dsh-tavern-tile' })
  await act(async () => { tiles[0]!.props.onClick(); tiles[1]!.props.onClick() })
}

it('同批选中两份预设后，迟到的旧读取不能替换已编辑的新目标正文', async () => {
  const f = fixture(), view = await render(f)
  await selectBoth(view)
  await act(async () => f.lighthouse.resolve(ok({ preset: content('lighthouse'), revision: 'lighthouse-revision' })))
  await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '灯塔未保存正文' } }))
  await act(async () => f.port.resolve(ok({ preset: content('port'), revision: 'port-revision' })))
  expect(view.root.findByType('textarea').props.value).toBe('灯塔未保存正文')
  expect(view.root.findAllByType('input').find(input => input.props.value === '灯塔')).toBeDefined()
})

it('旧读取先完成不能提前打开错误资产或解除最后读取的等待状态', async () => {
  const f = fixture(), view = await render(f)
  await selectBoth(view)
  await act(async () => f.port.resolve(ok({ preset: content('port'), revision: 'port-revision' })))
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  expect(view.root.findAllByType(Btn).find(button => button.props.children === t('presets.new'))!.props.disabled).toBe(true)
  await act(async () => f.lighthouse.resolve(ok({ preset: content('lighthouse'), revision: 'lighthouse-revision' })))
  expect(view.root.findByType('textarea').props.value).toBe('lighthouse原始正文')
  expect(view.root.findByType('fieldset').props.disabled).toBe(false)
})

it.each(['envelope', 'transport'] as const)('最后读取失败后保留该错误，旧失败不覆盖错误且重新点选可重试：%s', async failure => {
  const f = fixture(), view = await render(f)
  await selectBoth(view)
  if (failure === 'envelope') await act(async () => f.lighthouse.resolve({ ok: false, error: { code: 'test', message: '灯塔读取失败' } }))
  else await act(async () => f.lighthouse.reject(new Error('灯塔读取失败')))
  await act(async () => f.port.reject(new Error('过时的港口错误')))
  expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('灯塔读取失败')
  expect(JSON.stringify(view.toJSON())).not.toContain('过时的港口错误')
  f.getPreset.mockResolvedValueOnce(ok({ preset: content('lighthouse'), revision: 'retry-revision' }))
  await act(async () => view.root.findAllByProps({ className: 'dsh-tavern-tile' })[1]!.props.onClick())
  expect(view.root.findByType('textarea').props.value).toBe('lighthouse原始正文')
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('快速关闭并重开编辑器后，先前点选的迟到错误不能污染当前正文', async () => {
  const f = fixture(), view = await render(f)
  await selectBoth(view)
  await act(async () => f.lighthouse.resolve(ok({ preset: content('lighthouse'), revision: 'lighthouse-revision' })))
  await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '明确放弃的灯塔草稿' } }))
  await act(async () => view.root.findAllByType(Btn).find(button => button.props.children === t('action.close'))!.props.onClick())
  await act(async () => view.root.findAllByType(ConfirmDialog).find(dialog => dialog.props.open)!.props.onConfirm())
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  f.getPreset.mockResolvedValueOnce(ok({ preset: { ...content('lighthouse'), entries: [{ ...content('lighthouse').entries[0]!, content: '重新打开的新灯塔正文' }] }, revision: 'reopened-revision' }))
  await act(async () => view.root.findAllByProps({ className: 'dsh-tavern-tile' })[1]!.props.onClick())
  await act(async () => f.port.reject(new Error('关闭前的过时港口错误')))
  expect(view.root.findByType('textarea').props.value).toBe('重新打开的新灯塔正文')
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('同批关闭取消已开始的读取，迟到成功不能重新打开用户已关闭的编辑器', async () => {
  const f = fixture(), view = await render(f)
  await act(async () => f.lighthouse.resolve(ok({ preset: content('lighthouse'), revision: 'lighthouse-revision' })))
  await act(async () => view.root.findAllByProps({ className: 'dsh-tavern-tile' })[1]!.props.onClick())
  const close = view.root.findAllByType(Btn).find(button => button.props.children === t('action.close'))!.props.onClick
  await act(async () => { view.root.findAllByProps({ className: 'dsh-tavern-tile' })[0]!.props.onClick(); close() })
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () => f.port.resolve(ok({ preset: content('port'), revision: 'port-revision' })))
  expect(view.root.findAllByType('textarea')).toHaveLength(0)
  expect(view.root.findAllByType(Btn).find(button => button.props.children === t('presets.new'))!.props.disabled).toBe(false)
})

/** 真实服务读写两个预设文件；迟到读取后提交只修改最后选择的灯塔，港口快照保持原样。 */
it('真实 FS 与 TavernService 中乱序读取后保存只修改最后选择的预设', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tavern-preset-selection-race-'))
  try {
    const state = new TavernState({ root: directory, characters: join(directory, 'characters'), lorebooks: join(directory, 'lorebooks'),
      presets: join(directory, 'presets'), personas: join(directory, 'personas'), regexDir: join(directory, 'regex'), sessions: join(directory, 'sessions') }, () => resolveConfig({}))
    await state.init()
    await state.savePreset(content('port')); await state.savePreset(content('lighthouse'))
    const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
    const port = await service.getPreset({ id: 'port' }), lighthouse = await service.getPreset({ id: 'lighthouse' })
    const f = fixture()
    f.getPreset.mockImplementation(async request => {
      const snapshot = await service.getPreset(request)
      await (request.id === 'port' ? f.port.promise : f.lighthouse.promise)
      return ok(snapshot)
    })
    const savePreset = vi.fn<TavernRemote['savePreset']>(async request => ok(await service.savePreset(request)))
    f.remote.savePreset = savePreset
    const view = await render(f)
    await selectBoth(view)
    await act(async () => { f.lighthouse.resolve(ok(lighthouse)); await f.getPreset.mock.results[1]!.value })
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '只保存最后选中的灯塔正文' } }))
    await act(async () => { f.port.resolve(ok(port)); await f.getPreset.mock.results[0]!.value })
    await act(async () => {
      view.root.findAllByType(Btn).find(button => button.props.children === t('presets.save'))!.props.onClick()
      await savePreset.mock.results[0]!.value
    })
    expect(savePreset).toHaveBeenCalledExactlyOnceWith({ id: 'lighthouse', preset: { ...lighthouse.preset,
      entries: [{ ...lighthouse.preset.entries[0], content: '只保存最后选中的灯塔正文' }] }, expectedRevision: lighthouse.revision })
    expect(await service.getPreset({ id: 'port' })).toEqual(port)
    expect((await service.getPreset({ id: 'lighthouse' })).preset.entries[0]!.content).toBe('只保存最后选中的灯塔正文')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
