/**
 * tavernMode 单元测试。
 * 覆盖：空值 / 目录 id / 带路径前缀的 id 都只认最后一段 `tavern`。
 */
import { describe, expect, it } from 'vitest'
import { isTavernPresetId, TAVERN_AGENT_PRESET } from '../src/core/tavernMode.js'

describe('isTavernPresetId', () => {
  it('认目录 id tavern', () => {
    expect(isTavernPresetId(TAVERN_AGENT_PRESET)).toBe(true)
    expect(isTavernPresetId('tavern')).toBe(true)
  })

  it('路径或命名空间前缀只看最后一段', () => {
    expect(isTavernPresetId('user/tavern')).toBe(true)
    expect(isTavernPresetId('presets:tavern')).toBe(true)
  })

  it('其它预设与空值都不算', () => {
    expect(isTavernPresetId(undefined)).toBe(false)
    expect(isTavernPresetId(null)).toBe(false)
    expect(isTavernPresetId('')).toBe(false)
    expect(isTavernPresetId('coding')).toBe(false)
    expect(isTavernPresetId('tavern-extra')).toBe(false)
  })
})
