/**
 * 分词与 token 估算单测。
 * 覆盖：CJK 滑窗 bigram（含单字不成词）、假名/谚文同样走 bigram、
 * 拉丁扩展/西里尔/希腊等按整词保留并转小写、混排在文字边界断词不跨语言组词、
 * 标点空白跳过；estimateTokens 口径钉死（不随分词范围变化）、clipToTokenBudget 截断。
 */
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

  it('日文假名切 bigram（平假名、片假名、长音号）', () => {
    expect(tokenize('こんにちは')).toEqual(['こん', 'んに', 'にち', 'ちは'])
    expect(tokenize('コーヒー')).toEqual(['コー', 'ーヒ', 'ヒー'])
    // 假名与汉字都属 bigram 文字，连写时同段滑窗
    expect(tokenize('猫がいる')).toEqual(['猫が', 'がい', 'いる'])
  })

  it('韩文谚文音节切 bigram', () => {
    expect(tokenize('안녕하세요')).toEqual(['안녕', '녕하', '하세', '세요'])
    expect(tokenize('사랑')).toEqual(['사랑'])
  })

  it('西里尔、希腊、带音标拉丁按整词保留并转小写', () => {
    expect(tokenize('Привет мир')).toEqual(['привет', 'мир'])
    expect(tokenize('Ελλάδα')).toEqual(['ελλάδα'])
    expect(tokenize('café')).toEqual(['café'])
    expect(tokenize('Café au lait')).toEqual(['café', 'au', 'lait'])
    expect(tokenize('naïve Zoë')).toEqual(['naïve', 'zoë'])
  })

  it('非 ASCII 词同样支持 `_`、`-` 连写', () => {
    expect(tokenize('санкт-петербург')).toEqual(['санкт-петербург'])
  })

  it('混排在文字边界断词：bigram 文字与拉丁词各自成段', () => {
    // \p{L} 也覆盖表意字，若词分支排在 bigram 分支之前，「日本語Test」会被吞成一个词
    expect(tokenize('日本語Test')).toEqual(['日本', '本語', 'test'])
    expect(tokenize('你好World')).toEqual(['你好', 'world'])
    expect(tokenize('hello안녕하세요')).toEqual(['hello', '안녕', '녕하', '하세', '세요'])
    expect(tokenize('Привет世界')).toEqual(['привет', '世界'])
  })

  it('多语种正文都能产出 token（BM25 去重与检索不会静默失效）', () => {
    for (const text of ['안녕하세요', 'こんにちは', 'Привет, как дела', 'café crème', 'Ελλάδα']) {
      expect(tokenize(text).length).toBeGreaterThan(0)
    }
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

  it('口径钉死：只有 CJK 表意字算 1，假名/谚文/西里尔仍按其余字符 ÷4', () => {
    // 分词放宽到假名/谚文/西里尔后，估算口径必须一字不变（预算分配是全局共用的）
    const pinned: Array<[string, number]> = [
      ['', 0],
      ['我喜欢你', 4],
      ['hello world', 3],
      ['abcd', 1],
      ['abcde', 2],
      ['café', 1],
      ['こんにちは', 2],
      ['안녕하세요', 2],
      ['Привет', 2],
      ['Ελλάδα', 2],
      ['你好ab', 3],
      ['我喜欢apple派', 6],
      ['foo_bar long-term id', 5],
    ]
    for (const [text, tokens] of pinned) {
      expect(estimateTokens(text)).toBe(tokens)
    }
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
