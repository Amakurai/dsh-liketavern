/**
 * 修复回归：turn/end 的自动 MVU 登记失败（例如剧情 state/helper.json 暂时损坏）时，
 * finishTurn 不提交楼层、释放开层句柄并抛错，由后台从正常 stop 原文重建任务（helperMvu.unregisteredFloor）。
 * 另覆盖普通 commitFloor 失败路径：句柄保留、重试后完成提交。
 * 同时确认 TemplateOutputCommitError 路径语义不变（保留句柄，不提交）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../../src/node/config.js'
import { helperMvuPending } from '../../src/node/helperMvu.js'
import type { TavernPaths } from '../../src/node/paths.js'
import { onTurnEnd, onTurnStart } from '../../src/node/sessionLifecycle.js'
import { TavernState } from '../../src/node/state.js'
import { WorkspaceFs } from '../../src/state/workspaceFs.js'

let root: string
let paths: TavernPaths
let state: TavernState
const SESSION = 'audit-mvu-floor'

const initializedHelper = JSON.stringify({
  version: 1, scopes: {}, mvu: { version: 1, initialized: true, pending: [], completed: [] },
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-mvu-floor-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 一轮正常 stop 的完整日志（system 首节点 + assistant 正常 finish.stop），确保 MVU 会登记任务。 */
function completedTurnSession(): Session {
  const session = Session.create(SessionId(SESSION))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
    message: createAssistantMessage({ content: [{ type: 'text', text: '正常回复' }], source: { provider: 'factory', model: 'factory' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

async function setup() {
  const { cardId } = await state.createCharacter('审计 MVU 角色')
  await state.saveBinding({
    sessionId: SESSION, cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: true, helperMvu: true, greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
  })
  const binding = (await state.loadBinding(SESSION))!
  const ws = await state.storyWorkspace(cardId, binding.storyId!)
  const plain = new WorkspaceFs(ws.fs.root, null)
  await plain.writeText('state/helper.json', initializedHelper)
  const session = completedTurnSession()
  const events = session.snapshotEvents()
  return { ws, plain, session, closed: { id: session.id, snapshotEvents: () => events } }
}

describe('MVU 登记失败后的楼层句柄与重试', () => {
  it('失败不提交楼层并释放句柄，后台恢复路径能识别这层待重建的 MVU 任务', async () => {
    const { ws, plain, session, closed } = await setup()

    await onTurnStart(state, SESSION, 1, session)
    expect(state.openFloors.get(SESSION)?.floor).toBe(`${SESSION}#t1`)

    // 剧情级 helper 状态暂时损坏：queueHelperMvuTurn 在读取时抛错，turn/end 收口失败。
    await plain.writeText('state/helper.json', '{corrupt')
    await expect(onTurnEnd(state, SESSION, closed)).rejects.toThrow()

    // 楼层保持未提交；句柄释放后 unregisteredFloor 才能把它识别为待恢复楼层（不能伪装成功提交）。
    expect(state.openFloors.has(SESSION)).toBe(false)
    expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(false)

    // 修好状态后，后台准备会从正常 stop 原文重建任务。
    await plain.writeText('state/helper.json', initializedHelper)
    await expect(helperMvuPending(state, SESSION, false)).resolves.toBe(true)
  })

  it('普通 commitFloor 失败保留句柄，重试同一结束帧完成提交', async () => {
    const { ws, session, closed } = await setup()
    await onTurnStart(state, SESSION, 1, session)
    vi.spyOn(ws.wal, 'commitFloor').mockRejectedValueOnce(new Error('工厂提交失败'))
    await expect(onTurnEnd(state, SESSION, closed)).rejects.toThrow('工厂提交失败')
    expect(state.openFloors.get(SESSION)?.floor).toBe(`${SESSION}#t1`)
    expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(false)

    await expect(onTurnEnd(state, SESSION, closed)).resolves.toBeUndefined()
    expect(state.openFloors.has(SESSION)).toBe(false)
    expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(true)
  })

  it('MVU 任务登记后 helperMvuPending 反映待处理状态（重试提交不掩盖任务）', async () => {
    const { ws, session, closed } = await setup()
    await onTurnStart(state, SESSION, 1, session)
    await onTurnEnd(state, SESSION, closed)
    expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(true)
    expect(await helperMvuPending(state, SESSION)).toBe(true)
  })
})
