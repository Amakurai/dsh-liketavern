/** 草稿恢复的真实文件故障集成：React 编辑器经 TavernService 与磁盘交互，原子替换失败后重开保留本页正文，重试确认后才更新宿主。 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { useDraftGuard } from '../src/client/drafts.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import type { TavernMethodRequests } from '../src/remote.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'

const fault = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.enabled && String(args[1]).replace(/\\/g, '/').includes('/editor-drafts/')) throw Object.assign(new Error('工厂暂存磁盘故障'), { code: 'EIO' })
    return actual.rename(...args)
  } }
})
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div>{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

let root: string, service: TavernService, view: ReactTestRenderer | undefined, requests: Promise<unknown>[]
const owner = 'filesystem-browser-owner', scope = 'filesystem-editor'
const snapshot = (text: string) => ({ version: 1, fields: { 'test:text': text, 'test:baseline': 'base' } })
function invoke<T>(operation: () => Promise<T>): Promise<Envelope<T>> {
  const result = operation().then(value => ({ ok: true as const, value }), (cause: unknown) => ({ ok: false as const, error: { code: 'test-fault', message: cause instanceof Error ? cause.message : String(cause) } }))
  requests.push(result)
  return result
}
/** 观察真实文件请求结束，不使用重试来掩盖操作失败，也不提前推进产品防抖时间。 */
async function drain() {
  for (;;) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const batch = [...requests]
    await Promise.all(batch)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (requests.length === batch.length) return
  }
}
function Editor() {
  const [text, setText] = useDraftState('test:text', 'base'), [baseline] = useDraftState('test:baseline', 'base')
  useDraftGuard(text !== baseline)
  return <input aria-label="真实磁盘编辑器" value={text} onChange={event => setText(event.target.value)} />
}
beforeEach(async () => {
  fault.enabled = false; requests = []
  root = await mkdtemp(join(tmpdir(), 'tavern-draft-recovery-fs-'))
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'), presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
  const storage = new Map([['dsh-tavern-editor-owner', owner]])
  vi.stubGlobal('window', Object.assign(new EventTarget(), { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } }))
  setTavernLocale('zh')
})
afterEach(async () => {
  fault.enabled = false
  if (view) await act(async () => { view!.unmount(); await drain() })
  view = undefined
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it.each([false, true])('磁盘连续写入失败后恢复最新正文，明确成功后才替换宿主记录（旧记录=%s）', async seeded => {
  if (seeded) await service.saveEditorDraft({ owner, key: scope, value: snapshot('磁盘中的旧草稿') })
  let storedPath: string | undefined, original: string | undefined
  if (seeded) {
    const files = await readdir(join(root, 'editor-drafts'), { recursive: true })
    storedPath = join(root, 'editor-drafts', files.find(path => path.endsWith('.json'))!)
    original = await readFile(storedPath, 'utf8')
  }
  const firstWrite = Promise.withResolvers<void>()
  const get = vi.fn((request: TavernMethodRequests['getEditorDraft']) => invoke(() => service.getEditorDraft(request)))
  const api = { getEditorDraft: get, saveEditorDraft: (request: TavernMethodRequests['saveEditorDraft']) => {
    firstWrite.resolve()
    return invoke(() => service.saveEditorDraft(request))
  }, deleteEditorDraft: (request: TavernMethodRequests['deleteEditorDraft']) => invoke(() => service.deleteEditorDraft(request)) } as unknown as TavernRemote
  const render = (open: boolean) => open ? <PersistentEditor remote={api} scope={scope}><Editor /></PersistentEditor> : null
  fault.enabled = true
  await act(async () => { view = create(render(true)); await drain() })
  await act(async () => view!.root.findByType('input').props.onChange({ target: { value: '真实磁盘失败后的最新正文' } }))
  await act(async () => { await firstWrite.promise; await drain() })
  expect(JSON.stringify(view!.toJSON())).toContain('工厂暂存磁盘故障')
  await act(async () => { view!.update(render(false)); await drain() })
  await act(async () => { view!.update(render(true)); await drain() })
  expect(view!.root.findByType('input').props.value).toBe('真实磁盘失败后的最新正文')
  expect(JSON.stringify(view!.toJSON())).toContain('工厂暂存磁盘故障')
  expect(get).toHaveBeenCalledTimes(1)
  expect((await service.getEditorDraft({ owner, key: scope })).draft?.value ?? null).toEqual(seeded ? snapshot('磁盘中的旧草稿') : null)
  if (storedPath) expect(await readFile(storedPath, 'utf8')).toBe(original)
  fault.enabled = false
  const retry = view!.root.findAllByType(Btn).find(button => button.props.children === '重试')!
  await act(async () => { retry.props.onClick(); await drain() })
  expect((await service.getEditorDraft({ owner, key: scope })).draft?.value).toEqual(snapshot('真实磁盘失败后的最新正文'))
  expect(JSON.stringify(view!.toJSON())).not.toContain('工厂暂存磁盘故障')
})
