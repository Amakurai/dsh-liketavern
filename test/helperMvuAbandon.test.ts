/** 显式放弃 MVU 的真实文件事务：新楼层恢复、旧租约、WAL/模板故障、绑定竞态和失败重试都保留已保存剧情。 */
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { abandonHelperMvu, HELPER_MVU_ABANDON_PATH } from '../src/node/helperMvuAbandon.js'
import { commitHelperMvuJob, prepareHelperMvuJob, queueHelperMvuStop } from '../src/node/helperMvu.js'
import { HELPER_STATE_PATH, loadHelperState, saveHelperState } from '../src/state/helper.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { loadTemplateState } from '../src/state/template.js'

let root: string, state: TavernState, session: Session, ctx: Context, service: TavernService, cardId: string, storyId: string
let interactiveCards = true
const ws = () => state.storyWorkspace(cardId, storyId)
const read = async () => loadHelperState((await ws()).fs)
const request = () => ({ sessionId: session.id, storyId })
const leaseRequest = () => ({ ...request(), runtimeId: 'abandon-factory' })
const floor = (turn: number) => session.id + '#t' + turn
const records = async (turn: number) => readFile(join((await ws()).fs.root, 'state/wal', floor(turn).replace(/[^A-Za-z0-9_.-]/g, '_'), 'records.jsonl'), 'utf8')
beforeEach(async () => {
  interactiveCards = true
  root = await mkdtemp(join(tmpdir(), 'tavern-mvu-abandon-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({ interactiveCards }))
  await state.init(); cardId = (await state.createCharacter('放弃任务工厂')).cardId
  session = Session.create(SessionId('abandon-factory'))
  await state.saveBinding({ sessionId: session.id, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: true, helperMvu: true, greetingIndex: 0, createdAt: 'factory' })
  storyId = (await state.loadBinding(session.id))!.storyId!
  ctx = { reflect: { provide: () => {} }, get: () => undefined, sessions: { get: (id: string) => id === session.id ? session : undefined }, agents: { get: () => undefined } } as unknown as Context
  service = new TavernService(ctx, state, {} as SettingsScope<TavernConfigRaw>)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function initialize() {
  session.append('assistant/message', { turn: 0, step: 0, message: createAssistantMessage({ content: [{ type: 'text', text: '开场白' }], source: TAVERN_GREETING_SOURCE }) }, { surfaceOp: 'append' })
  const work = await prepareHelperMvuJob(ctx, state, leaseRequest())
  await commitHelperMvuJob(ctx, state, { ...leaseRequest(), jobId: work.job!.id, token: work.token!, data: { stat_data: { hp: 10 }, custom: 'kept' } })
}
async function start(turn: number, pending = false) {
  state.currentTurns.set(session.id, turn)
  session.append('turn/start', { turn })
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } })
  session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '角色回复' + turn }], source: { provider: 'factory', model: 'factory' } }) }, { surfaceOp: 'append' })
  await (await ws()).wal.beginFloor(floor(turn)); state.openFloors.set(session.id, { cardId, storyId, floor: floor(turn) })
  if (pending) await queueHelperMvuStop(state, session.id, session)
}
async function end(turn: number) {
  session.append('turn/end', { turn, reason: { kind: 'completed' } }); state.openFloors.delete(session.id)
  await (await ws()).wal.commitFloor(floor(turn))
}
async function oldPending() { await initialize(); await start(1, true); await end(1); await start(2); await end(2) }

it('全局关闭后也能在最新合法楼层放弃旧任务，保留变量、extra、页集合及完成回执，回滚只撤销新操作', async () => {
  await oldPending(); const workspace = await ws(), saved = await read()
  saved.extras.custom = { note: '保留' }; saved.swipes = { page: { active: 0, pages: [{ message: '保留台词', data: { extraVar: 3 }, extra: { kept: true } }] } }
  await saveHelperState(workspace.fs.withFloor(floor(2)), saved)
  const before = await read(), oldRecords = await records(1)
  interactiveCards = false
  expect(await service.abandonHelperMvu(request())).toEqual({ disabled: true, abandoned: 1 })
  expect((await state.loadBinding(session.id))?.helperMvu).toBe(false)
  expect(await read()).toEqual({ ...before, mvu: { ...before.mvu, pending: [] } })
  expect(await records(1)).toBe(oldRecords)
  expect((await workspace.wal.validateFloor(floor(2))).committed).toBe(true)
  expect(await workspace.fs.readText(HELPER_MVU_ABANDON_PATH)).not.toBeNull()
  await workspace.wal.rollbackFloor(floor(2), workspace.fs.root)
  expect((await read()).mvu?.pending).toHaveLength(1)
  expect(await workspace.fs.readText(HELPER_MVU_ABANDON_PATH)).toBeNull()
})

it('活动 stop 楼层放弃后仍由宿主收口，重新开启也不能使用旧执行租约', async () => {
  await initialize(); await start(1, true)
  const work = await prepareHelperMvuJob(ctx, state, leaseRequest())
  await abandonHelperMvu(state, request())
  expect((await (await ws()).wal.validateFloor(floor(1))).committed).toBe(false)
  await state.saveBinding({ ...(await state.loadBinding(session.id))!, helperMvu: true })
  await expect(commitHelperMvuJob(ctx, state, { ...leaseRequest(), jobId: work.job!.id, token: work.token!, data: { stat_data: { hp: 999 } } })).rejects.toThrow(/租约已失效/)
  expect((await read()).mvu?.completed).toHaveLength(1)
})

it('变量正文失败时已关闭绑定、保留待处理任务，显式重试可完成且不新增成功回执', async () => {
  await oldPending(); const before = await read(), original = WorkspaceFs.prototype.writeText
  const failing = vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (this: WorkspaceFs, path, text) {
    if (path === HELPER_STATE_PATH) throw new Error('工厂正文失败')
    return original.call(this, path, text)
  })
  await expect(abandonHelperMvu(state, request())).rejects.toThrow(/已关闭.*请重试.*工厂正文失败/)
  expect((await state.loadBinding(session.id))?.helperMvu).toBe(false); expect(await read()).toEqual(before)
  failing.mockRestore()
  expect(await abandonHelperMvu(state, request())).toEqual({ disabled: true, abandoned: 1 })
  expect((await read()).mvu?.completed).toEqual(before.mvu?.completed)
})

it('自身清队列正文已写但提交失败，重试用专属记录补提交，不重写变量或伪造任务回执', async () => {
  await oldPending(); const workspace = await ws(), before = await read()
  const failing = vi.spyOn(workspace.wal, 'commitFloor').mockRejectedValueOnce(new Error('工厂提交失败'))
  await expect(abandonHelperMvu(state, request())).rejects.toThrow(/已关闭.*工厂提交失败/)
  expect((await read()).mvu?.pending).toEqual([])
  expect((await workspace.wal.validateFloor(floor(2))).committed).toBe(false)
  failing.mockRestore(); const body = await workspace.fs.readText(HELPER_STATE_PATH), afterRecords = await records(2)
  expect(await abandonHelperMvu(state, request())).toEqual({ disabled: true, abandoned: 0 })
  expect(await workspace.fs.readText(HELPER_STATE_PATH)).toBe(body); expect(await records(2)).toBe(afterRecords)
  expect((await workspace.wal.validateFloor(floor(2))).committed).toBe(true)
  expect((await read()).mvu?.completed).toEqual(before.mvu?.completed)
})

it('旧任务 WAL 损坏时即使已有新楼层也拒绝放弃，不先关闭绑定', async () => {
  await oldPending(); const before = await read()
  await appendFile(join((await ws()).fs.root, 'state/wal', floor(1).replace(/[^A-Za-z0-9_.-]/g, '_'), 'records.jsonl'), '\nnot-json\n')
  await expect(abandonHelperMvu(state, request())).rejects.toThrow()
  expect((await state.loadBinding(session.id))?.helperMvu).toBe(true); expect(await read()).toEqual(before)
})

it('完成回执未收口时先修复；修复失败不关闭开关，也不清队列绕过故障', async () => {
  await oldPending(); const workspace = await ws(), before = await read()
  await workspace.wal.reopenFloor(floor(0))
  const failing = vi.spyOn(workspace.wal, 'commitFloor').mockRejectedValueOnce(new Error('回执修复失败'))
  await expect(abandonHelperMvu(state, request())).rejects.toThrow('回执修复失败')
  expect((await state.loadBinding(session.id))?.helperMvu).toBe(true); expect(await read()).toEqual(before)
  failing.mockRestore(); await abandonHelperMvu(state, request())
  expect((await workspace.wal.validateFloor(floor(0))).committed).toBe(true)
})

it('没有专属放弃记录的其它宿主未提交楼层不会被标记完成', async () => {
  await oldPending(); const workspace = await ws(), before = await read()
  await workspace.wal.reopenFloor(floor(2))
  await expect(abandonHelperMvu(state, request())).rejects.toThrow(/未收口的宿主事务/)
  expect((await workspace.wal.validateFloor(floor(2))).committed).toBe(false); expect(await read()).toEqual(before)
  expect((await state.loadBinding(session.id))?.helperMvu).toBe(true)
})

it('无任务时只关闭开关，不提交无关的未完成宿主 WAL', async () => {
  await initialize(); await start(1); state.openFloors.delete(session.id)
  expect(await abandonHelperMvu(state, request())).toEqual({ disabled: true, abandoned: 0 })
  expect((await (await ws()).wal.validateFloor(floor(1))).committed).toBe(false)
  expect(await (await ws()).fs.readText(HELPER_MVU_ABANDON_PATH)).toBeNull()
})

it('真实模板冻结后失去活动宿主楼层的未收口 prepared 阻止放弃', async () => {
  await initialize(); await start(1, true)
  await state.saveBinding({ ...(await state.loadBinding(session.id))!, helperMvu: false })
  await runTavernPipeline({ state, sessionId: session.id, agent: null, mode: 'live', historyOverride: [{ role: 'user', content: '工厂输入' }] })
  expect((await loadTemplateState((await ws()).fs)).generation?.status).toBe('prepared')
  state.openFloors.delete(session.id); const before = await read()
  await expect(abandonHelperMvu(state, request())).rejects.toThrow(/模板楼层尚未收口/)
  expect(await read()).toEqual(before); expect((await (await ws()).wal.validateFloor(floor(1))).committed).toBe(false)
})

it('工作区锁等待期间换绑后拒绝旧剧情请求，不改任何旧变量或新绑定', async () => {
  await oldPending(); const before = await read(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const holding = withWorkspaceLock((await ws()).fs.root, async () => { entered.resolve(); await release.promise })
  await entered.promise
  const looked = Promise.withResolvers<void>(), original = state.storyWorkspace.bind(state)
  const spy = vi.spyOn(state, 'storyWorkspace').mockImplementation(async (...args) => { const result = await original(...args); looked.resolve(); return result })
  const abandoning = abandonHelperMvu(state, request()); await looked.promise; spy.mockRestore()
  const other = (await state.createCharacter('另一工厂角色')).cardId
  await state.saveBinding({ ...(await state.loadBinding(session.id))!, cardId: other, storyId: undefined })
  release.resolve(); await holding
  await expect(abandoning).rejects.toThrow(/剧情绑定已改变/)
  expect((await state.loadBinding(session.id))?.cardId).toBe(other); expect(await read()).toEqual(before)
})

it('无历史和 WAL 的空会话可关闭，未创建状态或伪造初始化', async () => {
  expect(await abandonHelperMvu(state, request())).toEqual({ disabled: true, abandoned: 0 })
  expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
  expect(await (await ws()).wal.listFloors()).toEqual([])
})

it('初始化待处理任务放弃后保持未初始化，再次启用可以使用新的合法锚点', async () => {
  await start(1, true); await end(1); await abandonHelperMvu(state, request())
  expect((await read()).mvu).toMatchObject({ initialized: false, pending: [], completed: [] })
  await start(2); await end(2); await state.saveBinding({ ...(await state.loadBinding(session.id))!, helperMvu: true })
  expect((await prepareHelperMvuJob(ctx, state, leaseRequest())).job).toMatchObject({ kind: 'initialize', turn: 2 })
})

it('专属恢复记录不进入模型资产读取，路径大小写和点段不能绕过', () => {
  for (const path of [HELPER_MVU_ABANDON_PATH, 'state/./helper-mvu-abandon.json', 'STATE\\helper-mvu-abandon.JSON']) expect(resolveReadableAssetPath(path).ok).toBe(false)
})

it('已提交的放弃标记随剧情分支继承，子剧情可再次放弃而不改来源', async () => {
  await oldPending(); await abandonHelperMvu(state, request())
  const sourceSession = session, sourceStory = storyId, source = await read(), sourceMarker = await (await ws()).fs.readText(HELPER_MVU_ABANDON_PATH)
  const binding = (await state.loadBinding(sourceSession.id))!, childId = SessionId('abandon-child')
  const childStory = await state.forkStory(binding, childId, async () => {})
  session = Session.create(childId, sourceSession.snapshotEvents()); storyId = childStory
  await state.saveBinding({ ...binding, sessionId: childId, storyId: childStory, helperMvu: true, walLineage: [{ sessionId: sourceSession.id, throughTurn: 2 }] })
  await start(3, true); await end(3)
  expect(await abandonHelperMvu(state, request())).toEqual({ disabled: true, abandoned: 1 })
  expect((await read()).mvu?.pending).toEqual([]); expect((await read()).mvu?.completed).toEqual(source.mvu?.completed)
  const sourceWorkspace = await state.storyWorkspace(cardId, sourceStory)
  expect(await loadHelperState(sourceWorkspace.fs)).toEqual(source)
  expect(await sourceWorkspace.fs.readText(HELPER_MVU_ABANDON_PATH)).toBe(sourceMarker)
  expect(JSON.parse((await (await ws()).fs.readText(HELPER_MVU_ABANDON_PATH))!)).toMatchObject({ sessionId: childId, storyId: childStory, floor: floor(3) })
})
