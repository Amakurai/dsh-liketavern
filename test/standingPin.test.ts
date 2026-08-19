/**
 * standing 会话钉死：指纹不变复用第一次文本；换卡/预设/人设才接受新值。
 */
import { describe, expect, it } from 'vitest'
import { STANDING_PIN_VERSION, pinStandingText, standingFingerprint } from '../src/core/standingPin.js'
import { isRuntimeContextSnapshot } from '../src/core/dshPrompt.js'

describe('standingFingerprint', () => {
  it('同一绑定得到同一指纹，换卡则变', () => {
    const a = { cardId: 'c1', presetId: 'p1', personaId: null as string | null }
    expect(standingFingerprint(a)).toBe(standingFingerprint({ ...a }))
    expect(standingFingerprint(a)).not.toBe(standingFingerprint({ ...a, cardId: 'c2' }))
    expect(standingFingerprint(a)).not.toBe(standingFingerprint({ ...a, presetId: null }))
  })

  it('改人设名字或描述会换指纹，避免 standing 钉死旧的 {{user}}', () => {
    const a = { cardId: 'c1', presetId: 'p1', personaId: 'persona-1' as string | null }
    expect(standingFingerprint(a, { name: 'User' })).not.toBe(standingFingerprint(a, { name: 'test' }))
    expect(standingFingerprint(a, { name: 'test', description: '' })).not.toBe(
      standingFingerprint(a, { name: 'test', description: '妹妹' }),
    )
  })

  it('指纹含 STANDING_PIN_VERSION，纪律变更可打穿进程内钉死', () => {
    const a = { cardId: 'c1', presetId: 'p1', personaId: null as string | null }
    expect(standingFingerprint(a).startsWith(`${STANDING_PIN_VERSION}\0`)).toBe(true)
  })

  it('资产修订号变化会换指纹（编辑预设/世界书后下一轮即重算 standing）', () => {
    const a = { cardId: 'c1', presetId: 'p1', personaId: null as string | null }
    expect(standingFingerprint(a, undefined, ['preset:p1=0', 'lore:w1=0'])).not.toBe(
      standingFingerprint(a, undefined, ['preset:p1=1', 'lore:w1=0']),
    )
    expect(standingFingerprint(a, undefined, ['preset:p1=0', 'lore:w1=0'])).not.toBe(
      standingFingerprint(a, undefined, ['preset:p1=0', 'lore:w1=1']),
    )
    // 缺省 revs 与空数组一致（兼容旧调用方）
    expect(standingFingerprint(a)).toBe(standingFingerprint(a, undefined, []))
  })
})

describe('pinStandingText', () => {
  it('指纹不变时丢弃后续计算结果', () => {
    const pins = new Map()
    expect(pinStandingText(pins, 's1', 'fp', 'FIRST')).toBe('FIRST')
    expect(pinStandingText(pins, 's1', 'fp', 'SECOND')).toBe('FIRST')
  })

  it('指纹变化时接受新文本', () => {
    const pins = new Map()
    pinStandingText(pins, 's1', 'fp-a', 'A')
    expect(pinStandingText(pins, 's1', 'fp-b', 'B')).toBe('B')
    expect(pinStandingText(pins, 's1', 'fp-b', 'C')).toBe('B')
  })

  it('不同会话互不干扰', () => {
    const pins = new Map()
    pinStandingText(pins, 's1', 'fp', 'A')
    expect(pinStandingText(pins, 's2', 'fp', 'B')).toBe('B')
    expect(pinStandingText(pins, 's1', 'fp', 'Z')).toBe('A')
  })
})

describe('isRuntimeContextSnapshot', () => {
  it('识别 dsh 追加的 runtime context 快照', () => {
    expect(isRuntimeContextSnapshot('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')).toBe(true)
    expect(isRuntimeContextSnapshot('Current runtime context: none.')).toBe(true)
    expect(isRuntimeContextSnapshot('你好')).toBe(false)
  })
})
