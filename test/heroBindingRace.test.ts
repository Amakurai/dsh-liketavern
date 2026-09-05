/**
 * hero 自动清扫绑定的真实文件系统 + 宿主 Session 回归测试：
 * 异步读取及开始开场白期间只按最新日志执行条件清扫，手动解除仍可用。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { greetingMessage } from '../src/node/greetingSeed.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

let root: string
let state: TavernState
let service: TavernService
let session: Session

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-hero-binding-race-test-'))
  state = new TavernState({
    root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'), personas: join(root, 'personas'),
    regexDir: join(root, 'regex'), sessions: join(root, 'sessions'),
  }, () => resolveConfig({}))
  await state.init()
  const card = await state.createCharacter('测试角色')
  await state.saveCharacter(card.cardId, { firstMes: '测试开場白' })
  session = Session.create('session-hero-race-test' as Session['id'])
  session.append('agent-preset/selected', { agentPreset: 'tavern' })
  await state.saveBinding({
    sessionId: session.id, cardId: card.cardId, cardName: card.card.name,
    presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString(),
  })
  const ctx = {
    reflect: { provide: () => {} }, get: () => undefined,
    sessions: { get: (id: string) => id === session.id ? session : undefined }, agents: { get: () => undefined },
  } as unknown as Context
  service = new TavernService(ctx, state, {} as SettingsScope<TavernConfigRaw>)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('hero 自动清扫绑定', () => {
  it('尚未开始时清除遗留绑定，开始与清扫并发时保留已写开场白的绑定', async () => {
    const request = { sessionId: session.id }
    const original = await state.loadBinding(session.id)
    const started = service.ensureGreeting(request)
    const swept = service.clearSessionBinding({ ...request, onlyIfBlank: true })
    expect(await started).toEqual({ created: true, conversationStarted: true })
    expect(await swept).toEqual({ cleared: false })
    expect(await state.loadBinding(session.id)).toEqual(original)
    expect(session.snapshotEvents().filter((event) => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('空白会话允许条件清扫并真正删除绑定', async () => {
    expect(await service.clearSessionBinding({ sessionId: session.id, onlyIfBlank: true })).toEqual({ cleared: true })
    expect(await state.loadBinding(session.id)).toBeNull()
  })

  it('旧 turn 0 开场白同样阻止自动清扫，手动解除保持原行为', async () => {
    session.append('assistant/message', { turn: 0, step: 0, message: greetingMessage('旧测试开场白') }, { surfaceOp: 'append', sourceEventSeqs: [] })
    expect(await service.clearSessionBinding({ sessionId: session.id, onlyIfBlank: true })).toEqual({ cleared: false })
    expect(await state.loadBinding(session.id)).not.toBeNull()
    expect(await service.clearSessionBinding({ sessionId: session.id })).toEqual({ cleared: true })
    expect(await state.loadBinding(session.id)).toBeNull()
  })

  it('读绑定期间发生的新楼层，在异步资产读取完成后反映到返回状态', async () => {
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(state, 'resolvePersona').mockImplementation(async () => {
      reading.resolve()
      await release.promise
      return null
    })
    const pending = service.getSessionBinding({ sessionId: session.id })
    await reading.promise
    session.append('turn/start', { turn: 1 })
    release.resolve()
    expect((await pending).conversationStarted).toBe(true)
  })
})
