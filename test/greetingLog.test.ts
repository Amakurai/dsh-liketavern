/**
 * 开场白写脏空白会话的判定：无 turn/start + 本插件 greeting 来源。
 */
import { describe, expect, it } from 'vitest'
import {
  greetingFloorState,
  isGreetingOnlyBlank,
  isTavernGreetingEvent,
  pickGreetingText,
  sessionHasUserMessage,
  TAVERN_GREETING_SOURCE,
} from '../src/core/greetingLog.js'

function greetingEvent() {
  return {
    type: 'assistant/message',
    data: { message: { source: { ...TAVERN_GREETING_SOURCE } } },
  }
}

describe('isGreetingOnlyBlank', () => {
  it('空日志不是写脏空白', () => {
    expect(isGreetingOnlyBlank([])).toBe(false)
  })

  it('只有本插件开场白、没有 turn/start 时判定为写脏', () => {
    expect(isGreetingOnlyBlank([greetingEvent()])).toBe(true)
    expect(isTavernGreetingEvent(greetingEvent())).toBe(true)
  })

  it('其它 assistant 消息不算', () => {
    expect(
      isGreetingOnlyBlank([
        { type: 'assistant/message', data: { message: { source: { provider: 'deepseek', model: 'v4' } } } },
      ]),
    ).toBe(false)
  })

  it('已经有 turn/start 则不是可复用的写脏空白', () => {
    expect(isGreetingOnlyBlank([greetingEvent(), { type: 'turn/start' }])).toBe(false)
  })
})

describe('pickGreetingText', () => {
  it('空串和纯空白不算有开场白', () => {
    expect(pickGreetingText(['', '你好'], 0)).toBeUndefined()
    expect(pickGreetingText(['   '], 0)).toBeUndefined()
  })

  it('按下标取非空变体；越界回退到 0', () => {
    expect(pickGreetingText(['第一句', '第二句'], 1)).toBe('第二句')
    expect(pickGreetingText(['第一句', '第二句'], 9)).toBe('第一句')
  })
})

describe('greetingFloorState', () => {
  const greet = (id: string) => ({
    type: 'assistant/message',
    data: { message: { id, source: { ...TAVERN_GREETING_SOURCE } } },
  })

  it('只把第一条本插件开场白标成 greeting，并在有多条变体时给出 swipe', () => {
    expect(greetingFloorState([greet('a')], 'a', 0, 3)).toEqual({
      isGreeting: true,
      started: false,
      swipe: { index: 0, total: 3 },
    })
    expect(greetingFloorState([greet('a')], 'other', 0, 3).isGreeting).toBe(false)
    expect(greetingFloorState([greet('a')], 'a', 0, 1).swipe).toBeNull()
  })

  it('对话开始后仍识别开场白，但不再给出 swipe', () => {
    const events = [greet('a'), { type: 'user/message', data: {} }]
    expect(sessionHasUserMessage(events)).toBe(true)
    expect(greetingFloorState(events, 'a', 1, 3)).toEqual({
      isGreeting: true,
      started: true,
      swipe: null,
    })
  })

  it('后续 assistant 消息不是开场白', () => {
    const events = [
      greet('a'),
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: { message: { id: 'b', source: { provider: 'deepseek', model: 'v4' } } } },
    ]
    expect(greetingFloorState(events, 'b', 0, 3)).toEqual({
      isGreeting: false,
      started: true,
      swipe: null,
    })
  })
})
