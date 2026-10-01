/** 真实剧情文件与 React 卡面验证：同一 iframe 重写后的旧运行时请求不能持久化，迟到分支回执不能导航。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SpeechHtmlFrame } from '../src/client/speech.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'
import { resolveConfig } from '../src/node/config.js'
import { getHelperSnapshot } from '../src/node/helperRuntime.js'
import { HELPER_STATE_PATH } from '../src/state/helper.js'
import { installCardPersistence } from '../src/core/cardPersistence.js'
import { installCardEvents } from '../src/core/cardEvents.js'
import { registerHelperDisplay } from '../src/client/helperDisplay.js'
import type { TavernRemote } from '../src/client/types.js'
import type { HelperFrameLease, HelperFrameOpen } from '../src/core/helperFrame.js'

vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null, IconChevronDownOutlineMedium: () => null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  MarkdownText: (p: { text: string }) => <p>{p.text}</p>, Toast: () => null,
}))
let root: string, state: TavernState, ctx: Context, view: ReactTestRenderer | undefined
let eventTarget: EventTarget
const source = { postMessage: vi.fn() }
const dispatch = (action: string, runtimeId: string | undefined, value: Record<string, unknown> = {}, from: unknown = source) => {
  const event = new Event('message')
  Object.defineProperties(event, { source: { value: from }, data: { value: {
    source: 'dsh-tavern-card', action, ...(runtimeId === undefined ? {} : { runtimeId }), ...value,
  } } })
  eventTarget.dispatchEvent(event)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-bridge-runtime-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const cardId = (await state.createCharacter('运行时工厂角色')).cardId
  await state.saveBinding({ sessionId: 'runtime-session', cardId, presetId: null, personaId: null,
    lorebookIds: [], characterLorebookId: null, interactiveCards: true, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const events: SessionEvent[] = [
    { type: 'assistant/message', seq: 0, time: 0, surfaceOp: 'append', data: { stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '工厂正文' }] }) } },
    { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  ctx = { sessions: { get: () => ({ snapshotEvents: () => events }) }, get: () => undefined } as unknown as Context
  source.postMessage.mockClear()
  eventTarget = new EventTarget(); vi.stubGlobal('window', eventTarget)
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const workspace = async () => {
  const binding = (await state.loadBinding('runtime-session'))!
  return state.storyWorkspace(binding.cardId, binding.storyId)
}
async function mount(overrides: Partial<Parameters<typeof SpeechHtmlFrame>[0]> = {}) {
  const snapshot = await getHelperSnapshot(ctx, state, 'runtime-session', 0)
  const commit = vi.fn((request: { storyId: string; historyRevision: string; changes: unknown }) =>
    TavernService.prototype.commitHelperVariables.call({ state, ctx } as TavernService,
      { sessionId: 'runtime-session', messageId: 0, ...request }))
  await act(async () => { view = create(<SpeechHtmlFrame srcDoc="factory" title="工厂卡" widget={false}
    helperBinding={{ sessionId: 'runtime-session', storyId: snapshot.storyId }} onHelperCommit={commit} {...overrides} />,
  { createNodeMock: node => node.type === 'iframe' ? { contentWindow: source } : null }) })
  return { snapshot, commit }
}

it.each(['old-runtime', undefined])('重建后忽略旧或缺失运行时的变量请求：%s', async runtimeId => {
  const { snapshot, commit } = await mount()
  const ws = await workspace(), beforeFloors = await ws.wal.listFloors()
  await act(async () => {
    dispatch('helperEventConnect', 'old-runtime')
    dispatch('helperEventConnect', 'current-runtime')
    dispatch('helperVariablesCommit', runtimeId, { requestId: 'stale-write', storyId: snapshot.storyId,
      historyRevision: snapshot.historyRevision, changes: [{ key: '["chat",""]', before: {}, value: { stale: true } }] })
    await state.waitForSessionTasks('runtime-session')
  })
  expect(commit).not.toHaveBeenCalled()
  expect(await ws.fs.readText(HELPER_STATE_PATH)).toBeNull()
  expect(await ws.wal.listFloors()).toEqual(beforeFloors)
})

it('当前运行时按固定会话与消息提交一次，经 WAL 保存真实变量', async () => {
  const { snapshot, commit } = await mount()
  await act(async () => {
    dispatch('helperEventConnect', 'current-runtime')
    const request = { requestId: 'current-write', storyId: snapshot.storyId, historyRevision: snapshot.historyRevision,
      sessionId: 'forged-session', messageId: 999, changes: [{ key: '["chat",""]', before: {}, value: { saved: 7 } }] }
    dispatch('helperVariablesCommit', 'current-runtime', request, {})
    dispatch('helperVariablesCommit', 'current-runtime', request)
    dispatch('helperVariablesCommit', 'current-runtime', request)
    await state.waitForSessionTasks('runtime-session')
  })
  expect(commit).toHaveBeenCalledOnce()
  expect((await getHelperSnapshot(ctx, state, 'runtime-session', 0)).scopes['["chat",""]']).toEqual({ saved: 7 })
  const ws = await workspace()
  expect((await ws.wal.validateFloor('runtime-session#t1')).committed).toBe(true)
  expect(source.postMessage.mock.calls.find(call => call[0].action === 'helperVariablesResult')?.[0]).toMatchObject({
    runtimeId: 'current-runtime', requestId: 'current-write', ok: true,
  })
})

it('同一窗口重建后迟到的消息分支回执不进入新卡面，也不能导航', async () => {
  const ready = Promise.withResolvers<{ branch: { childSessionId: string; title: string } }>()
  const edit = vi.fn(() => ready.promise), navigate = vi.fn(async () => {})
  const { snapshot } = await mount({ onMessageEdit: edit, onMessageBranch: navigate })
  await act(async () => {
    dispatch('helperEventConnect', 'old-runtime')
    dispatch('helperMessageEdit', 'old-runtime', { requestId: 'branch-request', storyId: snapshot.storyId,
      historyRevision: snapshot.historyRevision, edits: [{ message_id: 0, message: '修改台词' }] })
  })
  expect(edit).toHaveBeenCalledOnce()
  await act(async () => {
    dispatch('helperEventConnect', 'current-runtime')
    ready.resolve({ branch: { childSessionId: 'factory-child', title: '工厂编辑分支' } })
  })
  expect(source.postMessage.mock.calls.some(call => call[0].action === 'helperMessageEditResult')).toBe(false)
  await act(async () => dispatch('helperMessageEditApplied', 'old-runtime', { requestId: 'branch-request' }))
  expect(navigate).not.toHaveBeenCalled()
})

it('退役 Connect 及重复当前 Connect 不能重新启用旧运行时或解除当前在途锁', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof getHelperSnapshot>>>()
  const { snapshot } = await mount({ onHelperRefresh: () => pending.promise })
  await act(async () => {
    dispatch('helperEventConnect', 'old-runtime')
    dispatch('helperEventConnect', 'current-runtime')
    dispatch('helperEventConnect', 'old-runtime')
    dispatch('helperSnapshotGet', 'old-runtime', { requestId: 'stale-read', storyId: snapshot.storyId })
    dispatch('helperSnapshotGet', 'current-runtime', { requestId: 'pending-read', storyId: snapshot.storyId })
    dispatch('helperEventConnect', 'current-runtime')
    dispatch('helperSnapshotGet', 'current-runtime', { requestId: 'pending-read', storyId: snapshot.storyId })
    pending.resolve(snapshot)
  })
  const replies = source.postMessage.mock.calls.filter(call => call[0].action === 'helperSnapshotResult')
  expect(replies).toHaveLength(1)
  expect(replies[0]?.[0]).toMatchObject({ requestId: 'pending-read', runtimeId: 'current-runtime', ok: true })
})

it('旧请求完成不能解除新运行时复用编号的消息编辑锁', async () => {
  const old = Promise.withResolvers<{ branch: null }>(), current = Promise.withResolvers<{ branch: null }>()
  const edit = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
  const { snapshot } = await mount({ onMessageEdit: edit, onMessageBranch: async () => {} })
  const request = { requestId: 'reused-id', storyId: snapshot.storyId, historyRevision: snapshot.historyRevision,
    edits: [{ message_id: 0, message: '新台词' }] }
  await act(async () => {
    dispatch('helperEventConnect', 'old-runtime'); dispatch('helperMessageEdit', 'old-runtime', request)
    dispatch('helperEventConnect', 'current-runtime'); dispatch('helperMessageEdit', 'current-runtime', request)
    old.resolve({ branch: null })
  })
  await act(async () => { dispatch('helperMessageEdit', 'current-runtime', request); dispatch('helperMessageEdit', 'current-runtime', { ...request, requestId: 'other-id' }) })
  expect(edit).toHaveBeenCalledTimes(2)
  await act(async () => current.resolve({ branch: null }))
  expect(source.postMessage.mock.calls.filter(call => call[0].action === 'helperMessageEditResult' && call[0].ok === true)).toHaveLength(1)
})

it('只读候选也拒绝旧读取和迟到快照；同运行时查询可完成而写入明确失败', async () => {
  const late = Promise.withResolvers<Awaited<ReturnType<typeof getHelperSnapshot>>>(), refresh = vi.fn(() => late.promise)
  const violation = vi.fn(), { snapshot, commit } = await mount({ readOnly: true, onHelperRefresh: refresh, onReadOnlyViolation: violation })
  await act(async () => {
    dispatch('helperEventConnect', 'old-runtime')
    dispatch('helperSnapshotGet', 'old-runtime', { requestId: 'old-read', storyId: snapshot.storyId })
    dispatch('helperEventConnect', 'current-runtime')
    dispatch('helperSnapshotGet', 'old-runtime', { requestId: 'stale-read', storyId: snapshot.storyId })
    late.resolve(snapshot)
  })
  expect(refresh).toHaveBeenCalledOnce()
  expect(source.postMessage.mock.calls.some(call => call[0].action === 'helperSnapshotResult')).toBe(false)
  await act(async () => {
    dispatch('helperSnapshotGet', 'current-runtime', { requestId: 'current-read', storyId: snapshot.storyId })
    dispatch('helperVariablesCommit', 'old-runtime', { requestId: 'old-write', storyId: snapshot.storyId })
    dispatch('helperVariablesCommit', 'current-runtime', { requestId: 'current-write', storyId: snapshot.storyId })
  })
  expect(commit).not.toHaveBeenCalled(); expect(violation).toHaveBeenCalledOnce()
  expect(source.postMessage.mock.calls.find(call => call[0].action === 'helperSnapshotResult')?.[0]).toMatchObject({ runtimeId: 'current-runtime', ok: true })
  expect(source.postMessage.mock.calls.find(call => call[0].action === 'helperVariablesResult')?.[0]).toMatchObject({ runtimeId: 'current-runtime', ok: false })
})

it('重绘准备租约在运行时切换时取消，旧 Applied 不得发布显示', async () => {
  const check = vi.fn(), commit = vi.fn(), cancel = vi.fn()
  const stop = registerHelperDisplay('runtime-session', async () => ({ check, commit, cancel }))
  try {
    const { snapshot } = await mount({ onHelperRefresh: () => Promise.resolve(snapshot) })
    await act(async () => {
      dispatch('helperEventConnect', 'old-runtime')
      dispatch('helperDisplayRefresh', 'old-runtime', { requestId: 'display', storyId: snapshot.storyId,
        historyRevision: snapshot.historyRevision, ids: [0] })
    })
    expect(source.postMessage.mock.calls.find(call => call[0].action === 'helperDisplayResult')?.[0]).toMatchObject({ runtimeId: 'old-runtime', ok: true })
    await act(async () => {
      dispatch('helperEventConnect', 'current-runtime')
      dispatch('helperDisplayApplied', 'old-runtime', { requestId: 'display' })
    })
    expect(cancel).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled()
  } finally { stop() }
})

it('旧高度及缺失标签不改变新卡，当前可信及旧版有标签高度仍可用', async () => {
  await mount()
  const resize = (runtimeId: string | undefined, height: number, legacy = false) => {
    if (!legacy) return dispatch('resize', runtimeId, { height })
    const event = new Event('message')
    Object.defineProperties(event, { source: { value: source }, data: { value: {
      type: 'iframe-resize', height, ...(runtimeId === undefined ? {} : { runtimeId }),
    } } }); eventTarget.dispatchEvent(event)
  }
  await act(async () => { dispatch('helperEventConnect', 'old-runtime'); dispatch('helperEventConnect', 'current-runtime'); resize('current-runtime', 240) })
  expect(view!.root.findByType('iframe').props.style.height).toBe(240)
  await act(async () => { resize('old-runtime', 777); resize(undefined, 888); resize('old-runtime', 999, true); resize(undefined, 111, true) })
  expect(view!.root.findByType('iframe').props.style.height).toBe(240)
  await act(async () => resize('current-runtime', 430, true))
  expect(view!.root.findByType('iframe').props.style.height).toBe(430)
})

it('同一 Window 重写清理旧刷新后，其异步错误不能污染新脚本诊断状态', async () => {
  const rootWindow = eventTarget as unknown as Record<string, unknown>
  const parent = { postMessage: vi.fn() }; vi.stubGlobal('parent', parent)
  const snapshot = await getHelperSnapshot(ctx, state, 'runtime-session', 0)
  const stopEvents = installCardEvents(true), stopPersistence = installCardPersistence(snapshot, 'dsh-tavern-card', { saving: '', saved: '', failed: '' })
  const runtimeId = String(rootWindow.__dshTavernEventRuntimeId)
  const invalidated = new Event('message')
  Object.defineProperties(invalidated, { source: { value: parent }, data: { value: { source: 'dsh-tavern-card', runtimeId,
    action: 'helperSnapshotInvalidated', storyId: snapshot.storyId } } })
  eventTarget.dispatchEvent(invalidated)
  await Promise.resolve()
  expect(parent.postMessage.mock.calls.some(call => call[0].action === 'helperSnapshotGet')).toBe(true)
  stopPersistence(); stopEvents()
  const report = vi.fn((error: unknown) => { rootWindow.__dshTavernScriptFailure = String(error) })
  rootWindow.__dshTavernEventRuntimeId = 'new-runtime'; rootWindow.__dshTavernReportError = report
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(report).not.toHaveBeenCalled(); expect(rootWindow.__dshTavernScriptFailure).toBeUndefined()
})


it('可信宿主登记固定消息并等待私有许可，轮换期间旧请求和伪造令牌不能提交', async () => {
  const oldOpen=Promise.withResolvers<{ok:true;value:{token:string}}>(), newOpen=Promise.withResolvers<{ok:true;value:{token:string}}>()
  const openHelperFrame=vi.fn().mockImplementationOnce(()=>oldOpen.promise).mockImplementationOnce(()=>newOpen.promise)
  const closeHelperFrame=vi.fn(async()=>({ok:true as const,value:undefined}))
  const writes=vi.fn(async()=>snapshot)
  const remote={openHelperFrame,closeHelperFrame} as unknown as TavernRemote
  const {snapshot}=await mount({remote,helperMessageId:0,onHelperCommit:writes})
  const message={requestId:'waiting-write',storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,
    sessionId:'forged-session',messageId:999,frameLease:{frameId:'forged-frame',runtimeId:'old-runtime',epoch:77,token:'forged-token'},
    changes:[{key:'["chat",""]',before:{},value:{saved:1}}]}
  await act(async()=>{dispatch('helperEventConnect','old-runtime');dispatch('helperVariablesCommit','old-runtime',message)})
  expect(writes).not.toHaveBeenCalled()
  const first=openHelperFrame.mock.calls[0]![0] as HelperFrameOpen
  expect(first).toMatchObject({sessionId:'runtime-session',messageId:0,storyId:snapshot.storyId,runtimeId:'old-runtime',epoch:1,readOnly:false})
  expect(first.frameId).not.toBe('forged-frame')
  await act(async()=>{dispatch('helperEventConnect','current-runtime');dispatch('helperVariablesCommit','current-runtime',message)})
  expect(closeHelperFrame.mock.calls[0]![0]).toMatchObject({sessionId:'runtime-session',messageId:0,frameId:first.frameId,runtimeId:'old-runtime',epoch:1})
  expect(openHelperFrame.mock.calls[1]![0]).toMatchObject({frameId:first.frameId,runtimeId:'current-runtime',epoch:2})
  await act(async()=>oldOpen.resolve({ok:true,value:{token:'old-private-token'}}))
  expect(writes).not.toHaveBeenCalled()
  await act(async()=>newOpen.resolve({ok:true,value:{token:'current-private-token'}}))
  expect(writes).toHaveBeenCalledOnce()
  expect(writes.mock.calls[0]![0]).toMatchObject({storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,
    frameLease:{frameId:first.frameId,runtimeId:'current-runtime',epoch:2,token:'current-private-token'},changes:message.changes})
  expect(JSON.stringify(source.postMessage.mock.calls)).not.toContain('private-token')
  expect(JSON.stringify(source.postMessage.mock.calls)).not.toContain(first.frameId)
})

it('只读候选发布时保留运行时，可信宿主增 epoch 获取写许可且不复用迟到只读令牌', async () => {
  const readonlyOpen=Promise.withResolvers<{ok:true;value:{token:string}}>(), writableOpen=Promise.withResolvers<{ok:true;value:{token:string}}>()
  const openHelperFrame=vi.fn().mockImplementationOnce(()=>readonlyOpen.promise).mockImplementationOnce(()=>writableOpen.promise)
  const closeHelperFrame=vi.fn(async()=>({ok:true as const,value:undefined}))
  const remote={openHelperFrame,closeHelperFrame} as unknown as TavernRemote
  const writes=vi.fn(async()=>snapshot),ready=vi.fn()
  const {snapshot}=await mount({remote,helperMessageId:0,readOnly:true,onFrameReady:ready,onHelperCommit:writes})
  const request={requestId:'candidate-write',storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,
    changes:[{key:'["chat",""]',before:{},value:{promoted:true}}]}
  await act(async()=>{dispatch('helperEventConnect','candidate-runtime');dispatch('helperFrameReady','candidate-runtime');dispatch('helperVariablesCommit','candidate-runtime',request)})
  expect(ready).toHaveBeenCalledOnce();expect(writes).not.toHaveBeenCalled()
  const first=openHelperFrame.mock.calls[0]![0] as HelperFrameOpen
  expect(first).toMatchObject({runtimeId:'candidate-runtime',readOnly:true,epoch:1})
  await act(async()=>view!.update(<SpeechHtmlFrame srcDoc="factory" title="工厂卡" widget={false}
    remote={remote} helperMessageId={0} readOnly={false} onHelperCommit={writes}
    helperBinding={{sessionId:'runtime-session',storyId:snapshot.storyId}}/>))
  expect(openHelperFrame).toHaveBeenCalledTimes(2)
  expect(openHelperFrame.mock.calls[1]![0]).toMatchObject({frameId:first.frameId,runtimeId:'candidate-runtime',readOnly:false,epoch:2})
  await act(async()=>{dispatch('helperVariablesCommit','candidate-runtime',{...request,requestId:'published-write'});readonlyOpen.resolve({ok:true,value:{token:'readonly-private-token'}})})
  expect(writes).not.toHaveBeenCalled()
  await act(async()=>writableOpen.resolve({ok:true,value:{token:'published-private-token'}}))
  expect(writes).toHaveBeenCalledOnce()
  expect((writes.mock.calls[0]![0] as {frameLease:HelperFrameLease}).frameLease).toEqual({frameId:first.frameId,runtimeId:'candidate-runtime',epoch:2,token:'published-private-token'})
})

it('同一 iframe 替换 srcDoc 后仍记住退役运行时，迟到 Connect 不能恢复旧读取身份',async()=>{
  const refresh=vi.fn(async()=>snapshot),{snapshot}=await mount({onHelperRefresh:refresh})
  await act(async()=>dispatch('helperEventConnect','old-runtime'))
  await act(async()=>view!.update(<SpeechHtmlFrame srcDoc="replacement" title="工厂卡" widget={false}
    helperBinding={{sessionId:'runtime-session',storyId:snapshot.storyId}} onHelperRefresh={refresh}/>))
  await act(async()=>{
    dispatch('helperEventConnect','current-runtime');dispatch('helperEventConnect','old-runtime')
    dispatch('helperSnapshotGet','old-runtime',{requestId:'old-read',storyId:snapshot.storyId})
    dispatch('helperSnapshotGet','current-runtime',{requestId:'current-read',storyId:snapshot.storyId})
  })
  expect(refresh).toHaveBeenCalledOnce()
  expect(source.postMessage.mock.calls.filter(call=>call[0].action==='helperSnapshotResult').map(call=>call[0].requestId)).toEqual(['current-read'])
})


it('新运行时登记失败也立即关闭旧许可，当前写入不得回退到旧令牌',async()=>{
  const openHelperFrame=vi.fn().mockResolvedValueOnce({ok:true,value:{token:'previous-private-token'}})
    .mockResolvedValueOnce({ok:false,error:{message:'运行时身份不合法'}})
  const closeHelperFrame=vi.fn(async()=>({ok:true as const,value:undefined})),writes=vi.fn(async()=>snapshot)
  const {snapshot}=await mount({remote:{openHelperFrame,closeHelperFrame} as unknown as TavernRemote,helperMessageId:0,onHelperCommit:writes})
  await act(async()=>dispatch('helperEventConnect','old-runtime'))
  await act(async()=>{dispatch('helperEventConnect','x');dispatch('helperVariablesCommit','x',{requestId:'failed-open',
    storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,changes:[{key:'["chat",""]',before:{},value:{lost:true}}]})})
  expect(closeHelperFrame).toHaveBeenCalledOnce()
  expect(closeHelperFrame.mock.calls[0]![0]).toMatchObject({runtimeId:'old-runtime',epoch:1,token:'previous-private-token'})
  expect(writes).not.toHaveBeenCalled()
  expect(source.postMessage.mock.calls.filter(call=>call[0].action==='helperVariablesResult').map(call=>call[0])).toEqual([
    {source:'dsh-tavern-card',action:'helperVariablesResult',runtimeId:'x',requestId:'failed-open',ok:false,error:'运行时身份不合法'},
  ])
})

it('运行时退休预算耗尽会关闭最后许可并拒绝旧业务，不保留可写卡面身份',async()=>{
  const openHelperFrame=vi.fn(async()=>({ok:true as const,value:{token:'budget-private-token'}}))
  const closeHelperFrame=vi.fn(async()=>({ok:true as const,value:undefined})),writes=vi.fn(async()=>snapshot)
  const {snapshot}=await mount({remote:{openHelperFrame,closeHelperFrame} as unknown as TavernRemote,helperMessageId:0,onHelperCommit:writes})
  await act(async()=>{
    for(let i=0;i<=1025;i++)dispatch('helperEventConnect','budget-runtime-'+i)
    dispatch('helperVariablesCommit','budget-runtime-1024',{requestId:'budget-write',storyId:snapshot.storyId,
      historyRevision:snapshot.historyRevision,changes:[{key:'["chat",""]',before:{},value:{lost:true}}]})
  })
  expect(openHelperFrame).toHaveBeenCalledTimes(1025)
  expect(closeHelperFrame).toHaveBeenCalledTimes(1025)
  expect(closeHelperFrame.mock.calls.at(-1)![0]).toMatchObject({runtimeId:'budget-runtime-1024',epoch:1025})
  expect(writes).not.toHaveBeenCalled()
  expect(source.postMessage.mock.calls.at(-1)![0]).toMatchObject({runtimeId:'budget-runtime-1025',ok:false,error:expect.stringContaining('超过运行时预算')})
})


it('同一卡面组件换宿主消息时关闭旧 frameId，以新私有身份登记且仍拒绝旧 Connect',async()=>{
  const openHelperFrame=vi.fn(async()=>({ok:true as const,value:{token:'fixed-message-token'}}))
  const closeHelperFrame=vi.fn(async()=>({ok:true as const,value:undefined})),writes=vi.fn(async()=>snapshot)
  const remote={openHelperFrame,closeHelperFrame} as unknown as TavernRemote
  const {snapshot}=await mount({remote,helperMessageId:0,onHelperCommit:writes})
  await act(async()=>dispatch('helperEventConnect','old-runtime'))
  const previous=openHelperFrame.mock.calls[0]![0] as HelperFrameOpen
  await act(async()=>view!.update(<SpeechHtmlFrame srcDoc="new-message" title="工厂卡" widget={false}
    remote={remote} helperMessageId={17} helperBinding={{sessionId:'runtime-session',storyId:snapshot.storyId}}
    onHelperCommit={writes}/>))
  await act(async()=>{
    dispatch('helperEventConnect','current-runtime');dispatch('helperEventConnect','old-runtime')
    dispatch('helperVariablesCommit','current-runtime',{requestId:'message-write',storyId:snapshot.storyId,
      historyRevision:snapshot.historyRevision,changes:[{key:'["chat",""]',before:{},value:{fixed:true}}]})
  })
  expect(closeHelperFrame.mock.calls[0]![0]).toMatchObject({frameId:previous.frameId,messageId:0,runtimeId:'old-runtime'})
  const current=openHelperFrame.mock.calls[1]![0] as HelperFrameOpen
  expect(current.frameId).not.toBe(previous.frameId)
  expect(current).toMatchObject({sessionId:'runtime-session',messageId:17,runtimeId:'current-runtime',epoch:1})
  expect(writes).toHaveBeenCalledOnce()
  expect((writes.mock.calls[0]![0] as {frameLease:HelperFrameLease}).frameLease).toMatchObject({frameId:current.frameId,runtimeId:'current-runtime',epoch:1})
})
