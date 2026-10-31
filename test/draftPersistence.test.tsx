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
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import type { TavernMethodRequests, TavernMethodResults } from '../src/remote.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
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

function environment(sharedScope?: string) {
  const scope = sharedScope ?? `test-editor-${++sequence}`
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
  it('切换宿主立即隔离旧草稿，读取完成后只展示新宿主快照，保存也不串写', async () => {
    const oldHost = environment(), newHost = environment(oldHost.scope), delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getEditorDraft']>>>()
    oldHost.seed('旧宿主私有草稿')
    newHost.get.mockImplementationOnce(() => delayed.promise)
    const view = await render(oldHost)
    expect(view.root.findByType('input').props.value).toBe('旧宿主私有草稿')
    await act(async () => view.update(<Harness api={newHost.api} scope={newHost.scope}/>))
    expect(view.root.findAllByType('input')).toHaveLength(0)
    await act(async () => { delayed.resolve(ok({ draft: { value: snapshot('新宿主独立草稿'), updatedAt: new Date(0).toISOString() } })) })
    expect(view.root.findByType('input').props.value).toBe('新宿主独立草稿')
    await change(view, '只保存到新宿主')
    await advance()
    expect(newHost.stored()).toEqual(snapshot('只保存到新宿主'))
    expect(oldHost.stored()).toEqual(snapshot('旧宿主私有草稿'))
  })

  it('相同 owner 与 scope 在另一宿主有悬挂写入时，仍能独立加载和保存', async () => {
    const oldHost = environment(), newHost = environment(oldHost.scope), gate = Promise.withResolvers<void>()
    // 生产 scope 是固定的 panel 等标识，不随宿主改变。
    const scope = oldHost.scope
    oldHost.save.mockImplementationOnce(async request => { await gate.promise; return oldHost.write(request) })
    const view = await render(oldHost)
    await change(view, '旧宿主正在保存')
    await advance()
    expect(oldHost.save).toHaveBeenCalledOnce()
    try {
      await act(async () => view.update(<Harness api={newHost.api} scope={scope}/>))
      expect(newHost.get).toHaveBeenCalledOnce()
      expect(view.root.findByType('input').props.value).toBe('base')
      await change(view, '新宿主的正文')
      await advance()
      expect(newHost.save).toHaveBeenCalledWith({ owner, key: scope, value: snapshot('新宿主的正文') })
    } finally { await act(async () => gate.resolve()) }
    expect(view.root.findByType('input').props.value).toBe('新宿主的正文')
  })

  it.each([false, true])('嵌套编辑器只复用同一宿主的草稿范围，不同宿主：%s', async separateHost => {
    const parent = environment(), child = separateHost ? environment() : parent
    const childScope = separateHost ? child.scope : `${parent.scope}:nested`
    parent.seed('父宿主草稿')
    if (separateHost) child.seed('子宿主草稿')
    let view!: ReactTestRenderer
    await act(async () => { view = create(<PersistentEditor remote={parent.api} scope={parent.scope}>
      <PersistentEditor remote={child.api} scope={childScope}><Editor leave={() => {}}/></PersistentEditor>
    </PersistentEditor>) })
    mounted.push(view)
    expect(child.get).toHaveBeenCalledOnce()
    expect(view.root.findByType('input').props.value).toBe(separateHost ? '子宿主草稿' : '父宿主草稿')
    await change(view, '保存子编辑器')
    await advance()
    expect(child.stored()).toEqual(snapshot('保存子编辑器'))
    if (separateHost) expect(parent.stored()).toEqual(snapshot('父宿主草稿'))
  })

  it.each([false, true])('旧宿主读取迟到不会覆盖新宿主界面与保存目标，旧读取失败：%s', async failed => {
    const oldHost = environment(), newHost = environment(oldHost.scope)
    const delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getEditorDraft']>>>()
    oldHost.get.mockImplementationOnce(() => delayed.promise)
    const view = await render(oldHost)
    await act(async () => view.update(<Harness api={newHost.api} scope={newHost.scope}/>))
    expect(newHost.get).toHaveBeenCalledOnce()
    await change(view, '新宿主已编辑')
    await act(async () => { delayed.resolve(failed ? fail('旧宿主读取故障')
      : ok({ draft: { value: snapshot('迟到的旧宿主私有内容'), updatedAt: new Date(0).toISOString() } })) })
    await advance()
    expect(view.root.findByType('input').props.value).toBe('新宿主已编辑')
    expect(newHost.stored()).toEqual(snapshot('新宿主已编辑'))
    expect(oldHost.save).not.toHaveBeenCalled()
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })

  it.each([false, true])('子编辑器延迟加载时暂存保留尚未消费的恢复字段，父编辑已保存：%s', async savedParent => {
    const env = environment()
    const fields = { ...snapshot('恢复的父草稿').fields, 'lazy:text': '尚未加载的子草稿', 'lazy:baseline': 'base' }
    await env.write({ owner, key: env.scope, value: { version: 1, fields } })
    const view = await render(env)
    await change(view, '父编辑的新草稿')
    await advance()
    if (savedParent) { await action(view, 'save-business'); await advance() }
    await unmount(view)
    // 立即重启浏览器模拟内存中的 restored 消失，只能使用自动暂存的快照。
    function LazyEditor() {
      const [text] = useDraftState('lazy:text', 'base')
      const [baseline, setBaseline] = useDraftState('lazy:baseline', 'base')
      useDraftGuard(text !== baseline)
      return <><textarea aria-label="子草稿" value={text} readOnly/><button data-action="save-child" onClick={() => setBaseline(text)}>保存子草稿</button></>
    }
    let reopened!: ReactTestRenderer
    await act(async () => { reopened = create(<PersistentEditor remote={env.api} scope={env.scope}><Editor leave={() => {}}/><LazyEditor/></PersistentEditor>) })
    mounted.push(reopened)
    expect(reopened.root.findByType('input').props.value).toBe('父编辑的新草稿')
    expect(reopened.root.findByType('textarea').props.value).toBe('尚未加载的子草稿')
    expect(env.stored()).toEqual({ version: 1, fields: { ...fields, 'test:text': '父编辑的新草稿', 'test:baseline': savedParent ? '父编辑的新草稿' : 'base' } })
    if (savedParent) {
      await action(reopened, 'save-child')
      await advance()
      expect(env.stored()).toBeNull()
    }
  })

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

  it.each([false, true])('慢速暂存期间持续编辑只保留最新待写快照，关闭重开仍等待最新内容，首写失败：%s', async firstFailed => {
    const env = environment(), gate = Promise.withResolvers<void>()
    env.save.mockImplementationOnce(async request => {
      await gate.promise
      return firstFailed ? fail('旧快照写入失败') : env.write(request)
    })
    const view = await render(env)
    await change(view, '首个正在写入的版本')
    await advance()
    try {
      for (let index = 1; index <= 40; index++) {
        await change(view, `最新正文 ${index}`)
        await advance()
      }
      expect(env.save).toHaveBeenCalledOnce()
      await action(view, 'host-close')
      await action(view, 'host-open')
      expect(env.get).toHaveBeenCalledOnce()
      expect(view.root.findAllByType('input')).toHaveLength(0)
    } finally { await act(async () => gate.resolve()) }
    expect(env.save).toHaveBeenCalledTimes(2)
    expect(env.get).toHaveBeenCalledTimes(2)
    expect(view.root.findByType('input').props.value).toBe('最新正文 40')
    expect(env.stored()).toEqual(snapshot('最新正文 40'))
    expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  })

  it('暂存尚未返回时业务保存可以用删除替换待写旧草稿，立即重开不恢复已提交内容', async () => {
    const env = environment(), gate = Promise.withResolvers<void>()
    env.save.mockImplementationOnce(async request => { await gate.promise; return env.write(request) })
    const view = await render(env)
    await change(view, '正在暂存的正文')
    await advance()
    try {
      await change(view, '已经提交的最终正文')
      await advance()
      await action(view, 'save-business')
      await advance()
      await action(view, 'host-close')
      await action(view, 'host-open')
    } finally { await act(async () => gate.resolve()) }
    expect(env.save).toHaveBeenCalledOnce()
    expect(env.remove).toHaveBeenCalledOnce()
    expect(env.stored()).toBeNull()
    expect(view.root.findByType('input').props.value).toBe('base')
  })

  it('合并后的最新暂存失败仍显示重试，重试只提交当前正文', async () => {
    const env = environment(), gate = Promise.withResolvers<void>()
    env.save.mockImplementationOnce(async request => { await gate.promise; return env.write(request) })
      .mockImplementationOnce(async () => fail('最新草稿保存失败'))
    const view = await render(env)
    await change(view, '旧的正在写入版本')
    await advance()
    try {
      for (const text of ['中间修改', '最终保留的正文']) { await change(view, text); await advance() }
    } finally { await act(async () => gate.resolve()) }
    expect(env.save).toHaveBeenCalledTimes(2)
    expect(view.root.findByType('input').props.value).toBe('最终保留的正文')
    expect(JSON.stringify(view.toJSON())).toContain('最新草稿保存失败')
    const retry = view.root.findAllByType(Btn).find(button => button.props.children === '重试')!
    await act(async () => retry.props.onClick())
    expect(env.save).toHaveBeenCalledTimes(3)
    expect(env.stored()).toEqual(snapshot('最终保留的正文'))
    expect(JSON.stringify(view.toJSON())).not.toContain('最新草稿保存失败')
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

  it('父组件 useDraftState 控制条件子编辑器时，放弃并离开后立即关闭面板不会复活草稿', async () => {
    const env = environment()
    function ChildEditor(props: { onClose: () => void }) {
      const [body, setBody] = useDraftState('child:body', 'base')
      const guard = useDraftGuard(body !== 'base')
      return <>
        <input aria-label="子正文" value={body} onChange={(e) => setBody(e.target.value)} />
        <button data-action="child-cancel" onClick={() => guard.request(() => { setBody('base'); props.onClose() })}>取消编辑</button>
        {guard.confirmation}
      </>
    }
    function ParentWithChild() {
      const [editingId, setEditingId] = useDraftState<string | null>('parent:editingId', 'm1')
      return <>{editingId && <ChildEditor onClose={() => setEditingId(null)} />}</>
    }
    let view!: ReactTestRenderer
    await act(async () => { view = create(<PersistentEditor remote={env.api} scope={env.scope}><ParentWithChild /></PersistentEditor>) })
    mounted.push(view)
    await change(view, '待放弃的子修改')
    await advance()
    expect(env.stored()).toEqual({ version: 1, fields: { 'parent:editingId': 'm1', 'child:body': '待放弃的子修改' } })
    await action(view, 'child-cancel')
    await act(async () => view.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onConfirm())
    // 未等 500ms 防抖结束立即关闭面板，不能把已放弃的草稿重新写回服务端。
    await unmount(view)
    await advance(600)
    expect(env.stored()).toBeNull()
    expect(env.remove).toHaveBeenCalledTimes(1)
  })

  it('同一 PersistentEditor 下多个同级编辑器并存时，单个编辑器 clearDraft 不会清空另一脏编辑器的草稿，也不会提前刷入重置前的旧快照', async () => {
    const env = environment()
    function Sibling(props: { id: string }) {
      const [text, setText] = useDraftState(`${props.id}:text`, 'base')
      const [baseline, setBaseline] = useDraftState(`${props.id}:baseline`, 'base')
      const guard = useDraftGuard(text !== baseline)
      return <>
        <input data-input={props.id} value={text} onChange={(e) => setText(e.target.value)} />
        <button data-action={`save-${props.id}`} onClick={() => { setBaseline(text); guard.clearDraft() }}>保存</button>
      </>
    }
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<PersistentEditor remote={env.api} scope={env.scope}><Sibling id="a" /><Sibling id="b" /></PersistentEditor>)
    })
    mounted.push(view)
    await act(async () => view.root.findByProps({ 'data-input': 'a' }).props.onChange({ target: { value: '修改A' } }))
    await act(async () => view.root.findByProps({ 'data-input': 'b' }).props.onChange({ target: { value: '修改B' } }))
    await action(view, 'save-a')
    // save-a 时 setBaseline 尚未提交，部分放弃分支只重排防抖，不能先把 a:baseline='base' 的旧快照刷到服务端。
    expect(env.save).not.toHaveBeenCalled()
    await advance()
    expect(env.save).toHaveBeenCalledTimes(1)
    expect(env.remove).not.toHaveBeenCalled()
    expect(env.stored()).toEqual({ version: 1, fields: { 'a:text': '修改A', 'a:baseline': '修改A', 'b:text': '修改B', 'b:baseline': 'base' } })
    await action(view, 'save-b')
    await advance()
    expect(env.stored()).toBeNull()
    expect(env.remove).toHaveBeenCalledTimes(1)
  })

  it('外层 DraftScope 与内层编辑器共用 PersistentEditor 时，单个编辑器放弃不会先把重置前的旧内容写到服务端', async () => {
    const env = environment()
    function ScopedEditor() {
      const [text, setText] = useDraftState('scoped:text', 'base')
      const guard = useDraftGuard(text !== 'base')
      return <>
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button data-action="reset" onClick={() => guard.request(() => setText('base'))}>放弃修改</button>
        {guard.confirmation}
      </>
    }
    let view!: ReactTestRenderer
    await act(async () => {
      view = create(<PersistentEditor remote={env.api} scope={env.scope}><DraftScope>{() => <ScopedEditor />}</DraftScope></PersistentEditor>)
    })
    mounted.push(view)
    await change(view, '未防抖落盘的临时输入')
    await action(view, 'reset')
    await act(async () => view.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onConfirm())
    expect(env.save).not.toHaveBeenCalled()
    await advance()
    expect(env.save).not.toHaveBeenCalled()
    expect(env.stored()).toBeNull()
  })

  it('条件子编辑器变脏后先卸载，500ms 内关闭 PersistentEditor 会删除草稿而非重存过期脏快照', async () => {
    const env = environment()
    function Child() {
      const [text, setText] = useDraftState('child:text', 'base')
      useDraftGuard(text !== 'base')
      return <input value={text} onChange={(e) => setText(e.target.value)} />
    }
    function Parent() {
      const [open, setOpen] = useState(true)
      return <>
        <button data-action="close-child" onClick={() => setOpen(false)}>关闭子编辑器</button>
        {open && <Child />}
      </>
    }
    let view!: ReactTestRenderer
    await act(async () => { view = create(<PersistentEditor remote={env.api} scope={env.scope}><Parent /></PersistentEditor>) })
    mounted.push(view)
    await change(view, '子编辑器脏内容')
    await advance()
    expect(env.stored()).toEqual({ version: 1, fields: { 'child:text': '子编辑器脏内容' } })
    await action(view, 'close-child')
    await advance(100)
    await unmount(view)
    await advance(600)
    expect(env.stored()).toBeNull()
    expect(env.remove).toHaveBeenCalledTimes(1)
  })
})
