import { describe, expect, it } from 'vitest'
import { clipToTokenBudget, estimateTokens, tokenize } from '../src/core/tokenize.js'

describe('tokenize', () => {
  it('中文切滑窗 bigram', () => {
    expect(tokenize('我喜欢你')).toEqual(['我喜', '喜欢', '欢你'])
    expect(tokenize('你好')).toEqual(['你好'])
  })

  it('单字不成词', () => {
    expect(tokenize('火')).toEqual([])
  })

  it('英文按词切分并转小写', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world'])
    expect(tokenize('GPT4 OK')).toEqual(['gpt4', 'ok'])
  })

  it('ASCII 词内部 `_`、`-` 连写按整体', () => {
    expect(tokenize('foo_bar long-term id')).toEqual(['foo_bar', 'long-term', 'id'])
  })

  it('中英混排各自成词，边界不跨语言组 bigram', () => {
    // 「我喜欢」「apple」「派」三段；不出现「欢a」之类的跨界 bigram；「派」单字丢弃
    expect(tokenize('我喜欢apple派')).toEqual(['我喜', '喜欢', 'apple'])
  })

  it('标点空白跳过，空串返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize(' ，。！？ \n\t ')).toEqual([])
    expect(tokenize('你好, world!')).toEqual(['你好', 'world'])
  })
})

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('CJK 字符每个计 1', () => {
    expect(estimateTokens('我喜欢你')).toBe(4)
  })

  it('非 CJK 字符累计 ÷4 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('hello world')).toBe(3) // 11 字符 → ceil(11/4)
  })

  it('中英混合时两部分相加（CJK 密度显著更高）', () => {
    expect(estimateTokens('你好ab')).toBe(3) // 2 CJK + ceil(2/4)
    // 同字符数下，纯中文的估算远高于纯英文
    expect(estimateTokens('我喜欢你')).toBeGreaterThan(estimateTokens('abcd'))
  })
})

describe('clipToTokenBudget', () => {
  it('未超预算原样返回', () => {
    expect(clipToTokenBudget('你好', 10)).toEqual({ text: '你好', truncated: false, tokens: 2 })
  })

  it('超预算截断并标记', () => {
    const clipped = clipToTokenBudget('汉'.repeat(50), 8)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text).toContain('…（已截断）')
    expect(clipped.tokens).toBeLessThanOrEqual(8)
    expect(clipped.tokens).toBeLessThan(estimateTokens('汉'.repeat(50)))
  })
})
