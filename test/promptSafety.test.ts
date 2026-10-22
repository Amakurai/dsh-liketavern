/** 控制标记诊断按正文顺序定位：混合模型标记、重复项与结果上限不能让最早的违规位置丢失。 */
import { describe, expect, it } from 'vitest'
import { assertNoControlTokens, findControlTokens, hasControlToken } from '../src/core/promptSafety.js'

describe('控制标记诊断顺序', () => {
  const text = '[INST] 开头 <|im_start|> 中间 <｜Assistant｜> 结尾'

  it('混合格式按正文位置返回，上限只截掉较晚的标记', () => {
    expect(findControlTokens(text).map(finding => finding.token)).toEqual(['[INST]', '<|im_start|>', '<｜Assistant｜>'])
    expect(findControlTokens(text, 1)).toEqual([{ token: '[INST]', index: 0 }])
    expect(findControlTokens(text, 2).map(finding => finding.token)).toEqual(['[INST]', '<|im_start|>'])
    expect(() => assertNoControlTokens(text, '预设')).toThrow(/\[INST\].*字符位置 0/)
  })

  it('同一标记只报首次位置，重复项不占用结果上限', () => {
    const repeated = '[INST] [INST] <end_of_turn> <｜Assistant｜>'
    expect(findControlTokens(repeated, 2)).toEqual([
      { token: '[INST]', index: 0 },
      { token: '<end_of_turn>', index: repeated.indexOf('<end_of_turn>') },
    ])
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('无效或不足一条的上限 %s 不返回诊断', limit => {
    expect(findControlTokens(text, limit)).toEqual([])
  })

  it('普通 HTML 和颜文字仍可用，所有支持的控制标记仍被拒绝', () => {
    expect(hasControlToken('<div>你好 <|-_-|> <s>划去</s></div>')).toBe(false)
    for (const token of ['<｜Assistant｜>', '<|im_start|>', '<<SYS>>', '[INST]', '[/INST]', '<start_of_turn>', '</start_of_turn>', '<end_of_turn>']) {
      expect(hasControlToken(token), token).toBe(true)
    }
  })
})
