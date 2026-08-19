/**
 * 陈旧会话绑定回收：删除角色卡后 cardId 失效，按名字或「只剩一张卡」接回新工作区。
 */
import { describe, expect, it } from 'vitest'
import { resolveStaleBinding } from '../src/core/binding.js'

describe('resolveStaleBinding', () => {
  const binding = {
    sessionId: 's1',
    cardId: '测试角色-oldhash',
    cardName: '测试角色',
    presetId: null as string | null,
  }

  it('cardId 仍在列表中则保留，并补上 cardName', () => {
    const live = [{ cardId: binding.cardId, name: '测试角色' }]
    const next = resolveStaleBinding({ sessionId: 's1', cardId: binding.cardId }, live)
    expect(next?.cardId).toBe(binding.cardId)
    expect(next?.cardName).toBe('测试角色')
  })

  it('cardId 已删时按 cardName 接到新 ID', () => {
    const next = resolveStaleBinding(binding, [{ cardId: '测试角色-a1b2c3d4', name: '测试角色' }])
    expect(next?.cardId).toBe('测试角色-a1b2c3d4')
    expect(next?.cardName).toBe('测试角色')
  })

  it('没有 cardName 但库里只剩一张卡时接到那张', () => {
    const next = resolveStaleBinding(
      { sessionId: 's1', cardId: 'deleted-id' },
      [{ cardId: 'only-one', name: '测试角色' }],
    )
    expect(next?.cardId).toBe('only-one')
    expect(next?.cardName).toBe('测试角色')
  })

  it('无法回收时返回 null（不要继续用文件夹 ID 当角色名）', () => {
    expect(
      resolveStaleBinding(binding, [
        { cardId: 'a', name: '甲' },
        { cardId: 'b', name: '乙' },
      ]),
    ).toBeNull()
    expect(resolveStaleBinding(binding, [])).toBeNull()
  })
})
