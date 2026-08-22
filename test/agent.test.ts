/**
 * dsh 段文本中性化、未绑卡 standing、纪律、固定 turn playbook 与步骤收口通知。
 */
import { describe, expect, it } from 'vitest'
import { BOUND_DISCIPLINE, CONTINUE_INSTRUCTION_PREFIX, TURN_PLAYBOOK, TURN_STEP_NOTICE_PREFIX, TURN_WRITE_ACK_PREFIX, UNBOUND_STANDING, formatTurnStepNotice, isSyntheticUserText, neutralizeDshMustache } from '../src/core/dshPrompt.js'

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

describe('TURN_PLAYBOOK', () => {
  it('内容固定不随 step 变化（宿主按字节去重，多步后续零快照开销）', () => {
    expect(TURN_PLAYBOOK).toContain('【本轮】')
    expect(TURN_PLAYBOOK).toContain('够用就直接以角色身份回复')
    expect(TURN_PLAYBOOK).toContain('按条补读')
    expect(TURN_PLAYBOOK).toContain('不重复追加')
    expect(TURN_PLAYBOOK.includes('{{')).toBe(false)
  })
})

describe('formatTurnStepNotice', () => {
  it('第 2 步软收口「查/写完就落地」；第 3 步起强收口停止再检索', () => {
    expect(formatTurnStepNotice(2)).toContain(`${TURN_STEP_NOTICE_PREFIX}本轮第 2 步`)
    expect(formatTurnStepNotice(2)).toContain('现在输出扮演正文')
    expect(formatTurnStepNotice(2)).not.toContain('停止再检索')
    expect(formatTurnStepNotice(3)).toContain(`${TURN_STEP_NOTICE_PREFIX}本轮第 3 步`)
    expect(formatTurnStepNotice(3)).toContain('停止再检索或写入')
    expect(formatTurnStepNotice(3)).toContain('必须输出扮演正文')
    expect(formatTurnStepNotice(7)).toContain('第 7 步')
    // 非法 step 回退到第 2 步的软收口
    expect(formatTurnStepNotice(0)).toContain('本轮第 2 步')
    // 步骤通知是合成文本：不当用户台词、不扫世界书
    expect(isSyntheticUserText(formatTurnStepNotice(2))).toBe(true)
  })
})

describe('isSyntheticUserText', () => {
  it('识别 runtime context、同轮写入确认、续写指令与步骤收口通知', () => {
    expect(isSyntheticUserText('Current runtime context. x')).toBe(true)
    expect(isSyntheticUserText(`${TURN_WRITE_ACK_PREFIX}记忆 id=1 已落盘。`)).toBe(true)
    expect(isSyntheticUserText(`${CONTINUE_INSTRUCTION_PREFIX}上一条角色回复可能被截断。`)).toBe(true)
    expect(isSyntheticUserText(`${TURN_STEP_NOTICE_PREFIX}本轮第 2 步：现在输出扮演正文。`)).toBe(true)
    expect(isSyntheticUserText('你好')).toBe(false)
  })
})
