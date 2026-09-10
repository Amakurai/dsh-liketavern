/**
 * 持久草稿前端回归：真实 PersistentEditor/useDraftState/useDraftGuard，
 * 仅用模拟宿主原语和内存 remote，验证恢复、保存、放弃、关闭重开及延迟写入竞态。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { HelperScriptEditorBody } from '../src/client/helperScriptEditor.js'
import { useDraftGuard } from '../src/client/drafts.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import type { TavernMethodRequests, TavernMethodResults } from '../src/remote.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
}))

type Stored = NonNullable<TavernMethodResults['getEditorDraft']['draft']>
const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'test-failure', message } })
const owner = 'test-browser-owner'
let sequence = 0
let browserStorage: Map<string, string>
const mounted: ReactTestRenderer[] = []

function snapshot(text: string, baseline = 'base') {
  return { version: 1, fields: { 'test:text': text, 'test:baseline': baseline } }
}

function environment() {
  const scope = `test-editor-${++sequence}`
  const storage = new Map<string, Stored>()
  const storageKey = (request: { owner: string; key: string }) => `${request.owner}:${request.key}`
  const write = async (request: TavernMethodRequests['saveEditorDraft']): Promise<Envelope<TavernMethodResults['saveEditorDraft']>> => {
    storage.set(storageKey(request), { value: structuredClone(request.value), updatedAt: new Date().toISOString() })
    return ok({ saved: true })
  }
  const save = vi.fn(write)
  const get = vi.fn(async (request: TavernMethodRequests['getEditorDraft']): Promise<Envelope<TavernMethodResults['getEditorDraft']>> =>
    ok({ draft: structuredClone(storage.get(storageKey(request)) ?? null) }))
  const remove = vi.fn(async (request: TavernMethodRequests['deleteEditorDraft']): Promise<Envelope<TavernMethodResults['deleteEditorDraft']>> => {
    storage.delete(storageKey(request))
    return ok({ deleted: true })
  })
  const api = { getEditorDraft: get, saveEditorDraft: save, deleteEditorDraft: remove } as unknown as TavernRemote
  return { scope, api, save, get, remove, write,
    seed(text: string) { storage.set(`${owner}:${scope}`, { value: snapshot(text), updatedAt: new Date(0).toISOString() }) },
    stored: () => storage.get(`${owner}:${scope}`)?.value ?? null,
  }
}

/** 测试编辑器保存成功后更新业务基线；实际草稿注册和离开确认来自产品 hooks。 */
function Editor(props: { leave: () => void }) {
  const [text, setText] = useDraftState('test:text', 'base')
  const [baseline, setBaseline] = useDraftState('test:baseline', 'base')
  const guard = useDraftGuard(text !== baseline)
  return <>
    <input aria-label="测试正文" value={text} onChange={(event) => setText(event.target.value)} />
    <button data-action="save-business" onClick={() => setBaseline(text)}>保存业务</button>
    <button data-action="leave" onClick={() => guard.request(props.leave)}>插件内离开</button>
    {guard.confirmation}
  </>
}

function Harness(props: { api: TavernRemote; scope: string }) {
  const [visible, setVisible] = useState(true)
  return <>
    <button data-action="host-close" onClick={() => setVisible(false)}>宿主关闭</button>
    <button data-action="host-open" onClick={() => setVisible(true)}>宿主打开</button>
    {visible && <PersistentEditor remote={props.api} scope={props.scope}><Editor leave={() => setVisible(false)} /></PersistentEditor>}
  </>
}

async function render(env: ReturnType<typeof environment>) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<Harness api={env.api} scope={env.scope} />) })
  mounted.push(view)
  return view
}
async function change(view: ReactTestRenderer, text: string) {
  await act(async () => view.root.findByType('input').props.onChange({ target: { value: text } }))
}
async function action(view: ReactTestRenderer, name: string) {
  await act(async () => view.root.findByProps({ 'data-action': name }).props.onClick())
}
async function advance(milliseconds = 600) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}
async function unmount(view: ReactTestRenderer) {
  mounted.splice(mounted.indexOf(view), 1)
  await act(async () => view.unmount())
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  browserStorage = new Map([['dsh-tavern-editor-owner', owner]])
  vi.stubGlobal('window', Object.assign(new EventTarget(), { sessionStorage: {
    getItem: (key: string) => browserStorage.get(key) ?? null,
    setItem: (key: string, value: string) => browserStorage.set(key, value),
  } }))
  setTavernLocale('zh')
})
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  await advance(1200)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('编辑草稿持久化', () => {
  it('恢复正文与基线，初次打开不会重复保存；浏览器只存随机标识', async () => {
    const env = environment()
    env.seed('恢复的正文')
    const view = await render(env)
    expect(view.root.findByType('input').props.value).toBe('恢复的正文')
    await advance()
    expect(env.save).not.toHaveBeenCalled()
    expect([...browserStorage.values()]).toEqual([owner])
  })

  it('编辑停顿后自动暂存最近内容，未产生脏状态不创建草稿', async () => {
    const env = environment()
    const view = await render(env)
    await advance()
    expect(env.save).not.toHaveBeenCalled()
    await change(view, '第一次修改')
    await advance(300)
    await change(view, '最近的修改')
    await advance(499)
    expect(env.save).not.toHaveBeenCalled()
    await advance(1)
    expect(env.stored()).toEqual(snapshot('最近的修改'))
    expect([...browserStorage.values()]).toEqual([owner])
  })

  it('业务保存成功后移除草稿，重开不会恢复已经提交的编辑', async () => {
    const env = environment()
    const view = await render(env)
    await change(view, '待提交')
    await advance()
    expect(env.stored()).toEqual(snapshot('待提交'))
    await action(view, 'save-business')
    await advance()
    expect(env.stored()).toBeNull()
    expect(env.remove).toHaveBeenCalled()
    await action(view, 'host-close')
    await action(view, 'host-open')
    expect(view.root.findByType('input').props.value).toBe('base')
  })

  it('取消离开保留正文，明确放弃后删除且重开不恢复', async () => {
    const env = environment()
    env.seed('不提交的修改')
    const view = await render(env)
    await action(view, 'leave')
    await act(async () => view.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onCancel())
    expect(view.root.findByType('input').props.value).toBe('不提交的修改')
    await action(view, 'leave')
    await act(async () => view.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onConfirm())
    await advance()
    expect(env.stored()).toBeNull()
    await action(view, 'host-open')
    expect(view.root.findByType('input').props.value).toBe('base')
  })

  it('宿主直接关闭时立即暂存，立即重开等待上一实例写完并恢复', async () => {
    const env = environment()
    const view = await render(env)
    await change(view, '关闭前刚输入')
    await action(view, 'host-close')
    await action(view, 'host-open')
    expect(view.root.findByType('input').props.value).toBe('关闭前刚输入')
    await advance(1200)
    expect(env.stored()).toEqual(snapshot('关闭前刚输入'))
  })

  it('卸载后字段清理不会启动新的删除任务，跨实例仍能恢复', async () => {
    const env = environment()
    const first = await render(env)
    await change(first, '跨刷新正文')
    await unmount(first)
    await advance(1200)
    expect(env.stored()).toEqual(snapshot('跨刷新正文'))
    expect(env.remove).not.toHaveBeenCalled()
    const second = await render(env)
    expect(second.root.findByType('input').props.value).toBe('跨刷新正文')
  })

  it('暂存失败显示重试并保留当前内容，重试成功写入相同正文', async () => {
    const env = environment()
    env.save.mockImplementationOnce(async () => fail('暂存连接失败'))
    const view = await render(env)
    await change(view, '失败后仍保留')
    await advance()
    expect(env.stored()).toBeNull()
    expect(view.root.findByType('input').props.value).toBe('失败后仍保留')
    const retry = view.root.findAllByType(Btn).find((button) => button.props.children === '重试')!
    expect(retry).toBeDefined()
    await act(async () => retry.props.onClick())
    expect(env.stored()).toEqual(snapshot('失败后仍保留'))
    expect(env.save).toHaveBeenCalledTimes(2)
  })

  it('前一次写入未完成时改回已恢复版本，最后仍保存最新想保留的版本', async () => {
    const env = environment()
    env.seed('恢复版本 A')
    const gate = Promise.withResolvers<void>()
    env.save.mockImplementationOnce(async (request) => { await gate.promise; return env.write(request) })
    const view = await render(env)
    await change(view, '中间版本 B')
    await advance()
    expect(env.save).toHaveBeenCalledTimes(1)
    await change(view, '恢复版本 A')
    await advance()
    await act(async () => gate.resolve())
    expect(env.stored()).toEqual(snapshot('恢复版本 A'))
    expect(env.save).toHaveBeenCalledTimes(2)
  })

  it('嵌在面板快照里的脚本库编辑器按目标身份区分草稿，全局库的未保存脚本不会被当成另一张卡的草稿', async () => {
    const env = environment()
    const global = { target: { type: 'global' as const }, trees: [], revision: 'r-global' }
    const character = { target: { type: 'character' as const, cardId: 'card-b' }, trees: [], revision: 'r-card' }
    function Panel(props: { library: typeof global | typeof character }) {
      return <PersistentEditor remote={env.api} scope={env.scope}>
        <HelperScriptEditorBody remote={env.api} library={props.library} onClose={() => {}} onSaved={() => {}} />
      </PersistentEditor>
    }
    let view!: ReactTestRenderer
    await act(async () => { view = create(<Panel library={global} />) })
    mounted.push(view)
    const status = () => view.root.findByProps({ className: 'dsh-tavern-scriptSaveStatus' }).props.children as string
    const addButton = view.root.findAllByType(Btn).find((button) => button.props.children === '添加脚本')
    expect(addButton).toBeDefined()
    await act(async () => addButton!.props.onClick())
    expect(status()).toBe('有未保存的修改')
    await advance()
    const stored = env.stored() as { fields: Record<string, unknown> } | null
    expect(stored).not.toBeNull()
    const treeKeys = Object.keys(stored!.fields).filter((key) => key.endsWith(':trees'))
    expect(treeKeys).toEqual(['helper-scripts:{"type":"global"}:trees'])
    expect(stored!.fields[treeKeys[0]!]).toHaveLength(1)
    await unmount(view)
    await advance(1200)
    await act(async () => { view = create(<Panel library={character} />) })
    mounted.push(view)
    expect(status()).toBe('所有修改已保存')
    expect(JSON.stringify(view.toJSON())).not.toContain('新脚本')
    await unmount(view)
    await advance(1200)
    await act(async () => { view = create(<Panel library={global} />) })
    mounted.push(view)
    expect(status()).toBe('有未保存的修改')
  })

  it('读取失败可以重试，成功后恢复内容且不新建空草稿覆盖原记录', async () => {
    const env = environment()
    env.seed('读取恢复内容')
    env.get.mockImplementationOnce(async () => fail('读取连接失败'))
    const view = await render(env)
    expect(view.root.findAllByType('input')).toHaveLength(0)
    const retry = view.root.findAllByType(Btn).find((button) => button.props.children === '重试')!
    await act(async () => retry.props.onClick())
    expect(view.root.findByType('input').props.value).toBe('读取恢复内容')
    await advance()
    expect(env.save).not.toHaveBeenCalled()
    expect(env.stored()).toEqual(snapshot('读取恢复内容'))
  })
})
