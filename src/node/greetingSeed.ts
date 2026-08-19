/**
 * 开场白 seed：编成一轮完整 turn（start/step/message/end），seq 从 0 连续。
 * swipe 必须把这段放进 agents.create 的 seed；子会话发布后再 append 会和
 * 刚启动的 agent loop 抢号，客户端打开历史会出现 Failed to fetch。
 */
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TAVERN_GREETING_SOURCE } from '../core/greetingLog.js'

const SEED_SESSION_ID = 'session-tavern-greeting-seed' as Session['id']

export function greetingMessage(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { ...TAVERN_GREETING_SOURCE },
  })
}

/** 脱离态编一轮开场白；调用方把返回值当作 agents.create 的 seed。不含 session/end-seed。 */
export function greetingTurnEvents(text: string): SessionEvent[] {
  const detached = Session.create(SEED_SESSION_ID)
  detached.append('turn/start', { turn: 1 })
  detached.append('step/start', { turn: 1, step: 1 })
  detached.append(
    'assistant/message',
    { turn: 1, step: 1, message: greetingMessage(text) },
    { surfaceOp: 'append', sourceEventSeqs: [] },
  )
  detached.append('step/end', { turn: 1, step: 1 })
  detached.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [...detached.events]
}
