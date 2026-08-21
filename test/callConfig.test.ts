/**
 * 采样合入与 reasoningEffort 挑选：只发送模型公布的档位；关 thinking 不瞎填；
 * 显式 low/high 档只在模型公布时采用，否则回退自动。
 */
import { describe, expect, it } from 'vitest'
import { mergeTavernCallConfig, pickReasoningEffort } from '../src/core/callConfig.js'
import { DEFAULT_SAMPLING } from '../src/core/types.js'

const DEEPSEEK = [{ id: 'off' }, { id: 'high' }, { id: 'max' }]
/** rc.2 起 deepseek 官方公布四档。 */
const DEEPSEEK_V4 = [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }]

describe('pickReasoningEffort', () => {
  it('关闭时选公布的 off，没有 off 则不填', () => {
    expect(pickReasoningEffort('disabled', DEEPSEEK, 'high', 'max')).toBe('off')
    expect(pickReasoningEffort('disabled', [{ id: 'high' }, { id: 'max' }], 'high', 'max')).toBeUndefined()
    expect(pickReasoningEffort('disabled', undefined, 'high', 'max')).toBeUndefined()
  })

  it('开启时保留会话已选的非 off 档', () => {
    expect(pickReasoningEffort('enabled', DEEPSEEK, 'high', 'max')).toBe('max')
    expect(pickReasoningEffort('enabled', DEEPSEEK, 'high', 'off')).toBe('high')
  })

  it('开启且无当前档时用模型默认，再否则第一个非 off', () => {
    expect(pickReasoningEffort('enabled', DEEPSEEK, 'high', undefined)).toBe('high')
    expect(pickReasoningEffort('enabled', DEEPSEEK, 'off', undefined)).toBe('high')
    expect(pickReasoningEffort('enabled', DEEPSEEK, undefined, undefined)).toBe('high')
  })

  it('解析失败（无公布档）时开启可沿用当前非 off', () => {
    expect(pickReasoningEffort('enabled', undefined, undefined, 'max')).toBe('max')
    expect(pickReasoningEffort('enabled', undefined, undefined, 'off')).toBeUndefined()
  })

  it('显式 low/high：模型公布该档时采用，即使会话当前是别的档', () => {
    expect(pickReasoningEffort('low', DEEPSEEK_V4, 'high', 'max')).toBe('low')
    expect(pickReasoningEffort('high', DEEPSEEK_V4, 'low', 'max')).toBe('high')
  })

  it('显式档位未被公布时回退自动；无公布档信息时不瞎填', () => {
    // 旧模型只有 off/high/max：选 low 回退到自动（当前 max）
    expect(pickReasoningEffort('low', DEEPSEEK, 'high', 'max')).toBe('max')
    expect(pickReasoningEffort('low', DEEPSEEK, 'high', undefined)).toBe('high')
    // 解析失败（ids 为空）时显式档位不可验证，回退自动
    expect(pickReasoningEffort('low', undefined, undefined, 'max')).toBe('max')
    expect(pickReasoningEffort('low', undefined, undefined, undefined)).toBeUndefined()
  })
})

describe('mergeTavernCallConfig', () => {
  it('透传 temperature / maxTokens / stop，并写入合法 reasoningEffort', () => {
    const sampling = { ...DEFAULT_SAMPLING, temperature: 0.8, maxTokens: 2048, stop: ['\n\n'] }
    expect(
      mergeTavernCallConfig({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, sampling, 'off'),
    ).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      temperature: 0.8,
      maxTokens: 2048,
      stop: ['\n\n'],
      reasoningEffort: 'off',
    })
  })

  it('maxTokens 为 null 且无 stop 时不覆盖这两项；无档位则不写 reasoningEffort', () => {
    const sampling = { ...DEFAULT_SAMPLING, maxTokens: null, stop: [] }
    expect(
      mergeTavernCallConfig({ provider: 'p', model: 'm', maxTokens: 111 }, sampling, undefined),
    ).toEqual({
      provider: 'p',
      model: 'm',
      temperature: sampling.temperature,
      maxTokens: 111,
    })
  })
})
