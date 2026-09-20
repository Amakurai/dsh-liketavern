/** 角色卡数据兼容：V3 nickname 只影响模型身份，空值与非法值安全回退展示名。 */
import { describe, expect, it } from 'vitest'
import { characterPromptName } from '../src/core/characterData.js'
import { parseJsonCard } from '../src/state/card.js'

describe('角色提示词身份', () => {
  it('原样使用 V3 nickname，并保留 card.name 作为资产展示名', () => {
    const card = parseJsonCard({
      spec: 'chara_card_v3',
      data: { name: '完整角色名', nickname: '  阿澜  ' },
    })
    expect(characterPromptName(card)).toBe('  阿澜  ')
    expect(card.name).toBe('完整角色名')
  })

  it.each([undefined, '', 42, null])('nickname=%j 时回退角色名', (nickname) => {
    const card = parseJsonCard({
      spec: 'chara_card_v3',
      data: { name: '完整角色名', ...(nickname === undefined ? {} : { nickname }) },
    })
    expect(characterPromptName(card)).toBe('完整角色名')
  })

  it('非空白字符也按规范原样保留，不静默改写作者字段', () => {
    const card = parseJsonCard({ spec: 'chara_card_v3', data: { name: '完整角色名', nickname: '   ' } })
    expect(characterPromptName(card)).toBe('   ')
  })

  it('V2 自定义字段与 data.extensions.nickname 不冒充 V3 规范身份', () => {
    const v2 = parseJsonCard({ spec: 'chara_card_v2', data: { name: 'V2 名字', nickname: '自定义值' } })
    const nested = parseJsonCard({
      spec: 'chara_card_v3',
      data: { name: 'V3 名字', extensions: { nickname: '厂商扩展值' } },
    })
    expect(characterPromptName(v2)).toBe('V2 名字')
    expect(characterPromptName(nested)).toBe('V3 名字')
  })

  it('直接 nickname 与同名扩展并存时只使用规范字段', () => {
    const card = parseJsonCard({
      spec: 'chara_card_v3',
      data: { name: '完整角色名', nickname: '规范昵称', extensions: { nickname: '扩展昵称' } },
    })
    expect(characterPromptName(card)).toBe('规范昵称')
  })
})
