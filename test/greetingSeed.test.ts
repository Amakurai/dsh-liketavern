/**
 * 开场白 seed：一轮完整 turn、seq 连续、带本插件 greeting 来源。
 */
import { describe, expect, it } from 'vitest'
import { isTavernGreetingEvent, TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'

describe('greetingTurnEvents', () => {
  it('编成一轮完整 turn，seq 从 0 连续，且不含 session/end-seed', () => {
    const events = greetingTurnEvents('你好')
    expect(events.map((event) => event.type)).toEqual([
      'turn/start',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    for (const [index, event] of events.entries()) {
      expect(event.seq).toBe(index)
    }
  })

  it('assistant 消息带 tavern greeting 来源，正文是传入文本', () => {
    const events = greetingTurnEvents('第二句开场白')
    const assistant = events.find((event) => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    expect(isTavernGreetingEvent(assistant!)).toBe(true)
    const message = (assistant!.data as { message: { content: { type: string; text?: string }[]; source: { provider: string; model: string } } }).message
    expect(message.source.provider).toBe(TAVERN_GREETING_SOURCE.provider)
    expect(message.source.model).toBe(TAVERN_GREETING_SOURCE.model)
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    expect(text).toBe('第二句开场白')
  })
})
