/**
 * dsh 段文本中性化、未绑卡 standing、纪律与本轮 playbook。
 */
import { describe, expect, it } from 'vitest'
import { BOUND_DISCIPLINE, TURN_WRITE_ACK_PREFIX, UNBOUND_STANDING, formatTurnPlaybook, isSyntheticUserText, neutralizeDshMustache } from '../src/core/dshPrompt.js'

describe('neutralizeDshMustache', () => {
  it('把残留 ST 宏改成全角花括号，避免 dsh section 插值抛错', () => {
    expect(neutralizeDshMustache('{{setvar::x::1}} 与 {{char}}')).toBe('｛｛setvar::x::1｝｝ 与 ｛｛char｝｝')
  })

  it('无花括号时原样返回', () => {
    expect(neutralizeDshMustache('角色定义')).toBe('角色定义')
  })
})

describe('UNBOUND_STANDING', () => {
  it('是固定短文案（未绑卡时不删段，保证前缀稳定）', () => {
    expect(UNBOUND_STANDING).toContain('尚未绑定角色卡')
    expect(UNBOUND_STANDING).toContain('不要调用 tavern_* 工具')
    expect(UNBOUND_STANDING.includes('{{')).toBe(false)
  })
})

describe('BOUND_DISCIPLINE', () => {
  it('要求默认直接扮演、最后一步才出正文，并写明工具写入下一轮才注入', () => {
    expect(BOUND_DISCIPLINE).toContain('默认直接以角色身份回复')
    expect(BOUND_DISCIPLINE).toContain('最后一步输出扮演正文')
    expect(BOUND_DISCIPLINE).toContain('检索层从下一轮更新')
    expect(BOUND_DISCIPLINE.includes('{{')).toBe(false)
  })
})

describe('formatTurnPlaybook', () => {
  it('第一步鼓励够用就演；第二步鼓励收口；第三步起强收口', () => {
    expect(formatTurnPlaybook(1)).toContain('【本轮】')
    expect(formatTurnPlaybook(1)).toContain('够用就直接以角色身份回复')
    expect(formatTurnPlaybook(1)).toContain('按条补读')
    expect(formatTurnPlaybook(2)).toContain('【本轮第 2 步】')
    expect(formatTurnPlaybook(2)).toContain('现在输出扮演正文')
    expect(formatTurnPlaybook(2)).not.toContain('停止再检索')
    expect(formatTurnPlaybook(3)).toContain('【本轮第 3 步】')
    expect(formatTurnPlaybook(3)).toContain('停止再检索或写入')
    expect(formatTurnPlaybook(3)).toContain('必须输出扮演正文')
    expect(formatTurnPlaybook(7)).toContain('【本轮第 7 步】')
    expect(formatTurnPlaybook(0)).toContain('【本轮】')
  })
})

describe('isSyntheticUserText', () => {
  it('识别 runtime context 与同轮写入确认', () => {
    expect(isSyntheticUserText('Current runtime context. x')).toBe(true)
    expect(isSyntheticUserText(`${TURN_WRITE_ACK_PREFIX}记忆 id=1 已落盘。`)).toBe(true)
    expect(isSyntheticUserText('你好')).toBe(false)
  })
})
