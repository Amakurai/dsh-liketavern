/**
 * 人设解析：绑定指定 > 默认页 > 库里只剩一条。
 */
import { describe, expect, it } from 'vitest'
import { pickPersona } from '../src/core/persona.js'

describe('pickPersona', () => {
  const test = { id: 'persona-test', name: 'test' }
  const other = { id: 'persona-other', name: 'other' }

  it('优先用会话绑定的人设', () => {
    expect(pickPersona(test, other, [other])).toEqual(test)
  })

  it('绑定为空时用默认页人设', () => {
    expect(pickPersona(null, test, [test, other])).toEqual(test)
  })

  it('绑定和默认都空、库里只剩一条时用那条', () => {
    expect(pickPersona(null, null, [test])).toEqual(test)
  })

  it('库里有多条且都未指定时不猜，避免绑错人', () => {
    expect(pickPersona(null, null, [test, other])).toBeNull()
    expect(pickPersona(null, null, [])).toBeNull()
  })
})
