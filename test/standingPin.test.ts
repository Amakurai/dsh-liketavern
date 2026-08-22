/**
 * standing 会话钉死：指纹不变复用第一次文本；换卡/预设/人设才接受新值。
 * 生成场景（generationType）并入指纹与钉位：同一会话 normal/continue 交替时各自复用首次字节。
 * stableFingerprintHash：键序无关、内容变即变，供 standingRevTags 把设置压成一个标记。
 */
import { describe, expect, it } from 'vitest'
import { STANDING_PIN_VERSION, pinStandingText, stableFingerprintHash, standingFingerprint, standingPinKey } from '../src/core/standingPin.js'
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

  it('生成场景并入指纹：normal / continue / impersonate 互不相同，缺省 = normal', () => {
    const a = { cardId: 'c1', presetId: 'p1', personaId: null as string | null }
    expect(standingFingerprint(a)).toBe(standingFingerprint(a, undefined, [], 'normal'))
    expect(standingFingerprint(a, undefined, [], 'normal')).not.toBe(standingFingerprint(a, undefined, [], 'continue'))
    expect(standingFingerprint(a, undefined, [], 'continue')).not.toBe(standingFingerprint(a, undefined, [], 'impersonate'))
    // 场景值大小写/空白归一化（与 assemble 的 toLowerCase 一致）
    expect(standingFingerprint(a, undefined, [], ' Continue ')).toBe(standingFingerprint(a, undefined, [], 'continue'))
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

  it('同会话分场景钉死：normal 与 continue 交替时各自复用首次字节', () => {
    const pins = new Map()
    const normalKey = standingPinKey('s1', 'normal')
    const continueKey = standingPinKey('s1', 'continue')
    expect(normalKey).not.toBe(continueKey)
    expect(pinStandingText(pins, normalKey, 'fp-n', 'NORMAL-1')).toBe('NORMAL-1')
    expect(pinStandingText(pins, continueKey, 'fp-c', 'CONT-1')).toBe('CONT-1')
    // 交替回到 normal：拿到的是 normal 轮钉死的字节，不是 continue 轮的，也不重算
    expect(pinStandingText(pins, normalKey, 'fp-n', 'NORMAL-2')).toBe('NORMAL-1')
    expect(pinStandingText(pins, continueKey, 'fp-c', 'CONT-2')).toBe('CONT-1')
    // 同场景下指纹变化（编辑预设等）仍重算重钉
    expect(pinStandingText(pins, normalKey, 'fp-n2', 'NORMAL-3')).toBe('NORMAL-3')
    expect(pinStandingText(pins, continueKey, 'fp-c', 'CONT-3')).toBe('CONT-1')
  })
})

describe('stableFingerprintHash', () => {
  it('与键序无关：同内容不同字面量顺序得到同一哈希', () => {
    expect(stableFingerprintHash({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(
      stableFingerprintHash({ b: { d: [3, 4], c: 2 }, a: 1 }),
    )
  })

  it('任意一项变化即换哈希，数组顺序有意义', () => {
    expect(stableFingerprintHash({ a: 1 })).not.toBe(stableFingerprintHash({ a: 2 }))
    expect(stableFingerprintHash({ a: [1, 2] })).not.toBe(stableFingerprintHash({ a: [2, 1] }))
    expect(stableFingerprintHash({ a: null })).not.toBe(stableFingerprintHash({ a: 0 }))
  })

  it('固定长度的十六进制，可直接拼进指纹标记', () => {
    expect(stableFingerprintHash({ a: 1 })).toMatch(/^[0-9a-f]{8}$/)
    expect(stableFingerprintHash(null)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('isRuntimeContextSnapshot', () => {
  it('识别 dsh 追加的 runtime context 快照', () => {
    expect(isRuntimeContextSnapshot('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')).toBe(true)
    expect(isRuntimeContextSnapshot('Current runtime context: none.')).toBe(true)
    expect(isRuntimeContextSnapshot('你好')).toBe(false)
  })
})
