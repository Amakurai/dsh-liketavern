/**
 * 服务端卡面租约的接口预算回归：MAX_FRAMES 原先用 map.size 判定，把 15 分钟保留期内
 * 已关闭的墓碑也计入——卡面刷新不断产生新 frameId，累计后新帧被误拒，而报错让用户
 * 「关闭旧卡面」实际释放不了预算。验证：墓碑不占预算；未关闭帧占满预算后拒绝；
 * 关闭一个未关闭帧即释放预算。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { TavernState } from '../../src/node/state.js'
import { resolveConfig } from '../../src/node/config.js'
import { closeHelperFrame, openHelperFrame } from '../../src/node/helperFrameLease.js'
import type { HelperFrameClose, HelperFrameOpen } from '../../src/core/helperFrame.js'

let root: string, state: TavernState, ctx: Context, cardId: string, source: Session, messageId: number, storyId: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helper-frame-budget-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'), presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init(); cardId = (await state.createCharacter('预算工厂角色')).cardId
  ctx = new Context(); new SessionStore(ctx); new AgentRegistry(ctx); source = ctx.sessions.create(SessionId('frame-budget-story'))
  source.append('agent-preset/selected', { agentPreset: 'tavern' })
  source.append('turn/start', { turn: 1 })
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '用户台词' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  source.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '角色回复' }], source: { provider: 'factory', model: 'factory' } }) }, { surfaceOp: 'append' })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  messageId = source.snapshotEvents().find(event => event.type === 'assistant/message')!.seq
  await state.saveBinding({ sessionId: source.id, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: 'factory' })
  storyId = (await state.loadBinding(source.id))!.storyId!
})
afterEach(async () => { vi.restoreAllMocks(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

const frameRequest = (frameId: string): HelperFrameOpen => ({ sessionId: source.id, messageId, storyId, frameId, runtimeId: 'runtime-budget-1', epoch: 1, readOnly: false })

it('已关闭的帧不占接口预算：累计 1024 个墓碑后新帧仍可连接', async () => {
  for (let i = 0; i < 1024; i++) {
    const request = frameRequest(`budget-frame-${String(i).padStart(4, '0')}`)
    const opened = await openHelperFrame(ctx, state, request)
    closeHelperFrame(state, { ...request, token: opened.token } as HelperFrameClose)
  }
  // 修复前：map.size 达到 1024（全是墓碑）即在此抛「接口预算」
  await expect(openHelperFrame(ctx, state, frameRequest('budget-frame-fresh'))).resolves.toHaveProperty('token')
})

it('未关闭帧占满预算后拒绝新帧；关闭一个未关闭帧即释放预算', async () => {
  for (let i = 0; i < 1024; i++) await openHelperFrame(ctx, state, frameRequest(`budget-live-${String(i).padStart(4, '0')}`))
  await expect(openHelperFrame(ctx, state, frameRequest('budget-live-next'))).rejects.toThrow('接口预算')
  closeHelperFrame(state, { ...frameRequest('budget-live-0000'), token: undefined } as HelperFrameClose)
  await expect(openHelperFrame(ctx, state, frameRequest('budget-live-next'))).resolves.toHaveProperty('token')
})
