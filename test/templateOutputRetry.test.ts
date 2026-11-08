/** 模板计算失败（非保存失败）不得被当作普通脚本异常提交楼层；同一结束帧重试应能完成收口。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Session as HostSession, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { loadTemplateState } from '../src/state/template.js'

const isolatedMock = vi.hoisted(() => ({ failNextTemplate: false }))
vi.mock('../src/node/isolated.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/node/isolated.js')>()
  return {
    ...actual,
    isolated: async (...args: Parameters<typeof actual.isolated>) => {
      if (isolatedMock.failNextTemplate && args[0] === 'template') {
        isolatedMock.failNextTemplate = false
        throw new Error('第三方正则或提示词计算超时，已终止 worker')
      }
      return actual.isolated(...args)
    },
  }
})

let root: string
let state: TavernState
let ws: Awaited<ReturnType<TavernState['storyWorkspace']>>
const SESSION = 'template-output-retry'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-template-output-retry-'))
  state = new TavernState({
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }, () => resolveConfig({}))
  await state.init()
  const { cardId } = await state.createCharacter('模板重试角色')
  await state.saveCharacter(cardId, { description: '<% incvar("visits") %>访问=<%- getvar("visits") %>' })
  await saveBinding(state.paths, {
    sessionId: SESSION, cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString(),
  })
  const binding = (await state.loadBinding(SESSION))!
  ws = await state.storyWorkspace(cardId, binding.storyId)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function completedReply(): Pick<Session, 'id' | 'snapshotEvents'> {
  const events = [
    {
      type: 'assistant/message', seq: 5, time: 0, data: {
        stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: '<% setvar("completed", 1) %>完成' }], source: { provider: 'factory', model: 'factory' } }),
      },
    },
    { type: 'turn/end', seq: 6, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  return { id: SESSION as Session['id'], snapshotEvents: () => events }
}

it('模板计算失败保留未提交楼层，同一 turn/end 重试成功后才提交', async () => {
  const live = HostSession.create(SESSION as Session['id'])
  live.append('agent-preset/selected', { agentPreset: 'tavern' })
  live.append('turn/start', { turn: 1 })
  live.append('step/start', { turn: 1, step: 1 })
  live.append('user/message', createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await onTurnStart(state, SESSION, 1, live)
  const pipeline = await runTavernPipeline({ state, sessionId: SESSION, agent: null, mode: 'live', historyOverride: [{ role: 'user', content: '你好' }] })
  expect(pipeline?.templateReplay).toBeDefined()
  expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')

  isolatedMock.failNextTemplate = true
  const reply = completedReply()
  await expect(onTurnEnd(state, SESSION, reply)).rejects.toThrow(/模板回复尚未保存/)
  expect(state.openFloors.get(SESSION)?.floor).toBe(`${SESSION}#t1`)
  expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(false)

  await expect(onTurnEnd(state, SESSION, reply)).resolves.toBeUndefined()
  expect(state.openFloors.has(SESSION)).toBe(false)
  expect((await ws.wal.validateFloor(`${SESSION}#t1`)).committed).toBe(true)
  const stored = await loadTemplateState(ws.fs)
  expect(stored.generation?.status).toBe('completed')
  expect(stored.outputs['5']?.text).toContain('完成')
})
