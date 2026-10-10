/**
 * 分词与 token 估算单测。
 * 覆盖：CJK 滑窗 bigram（含单字不成词）、假名/谚文同样走 bigram、
 * 拉丁扩展/西里尔/希腊等按整词保留并转小写、混排在文字边界断词不跨语言组词、
 * 标点空白跳过、全角/半角/兼容写法经 NFKC 归一、analyzeText 额外切出 bigram 文字的单字与各段首尾字；
 * estimateTokens 口径钉死（不随分词范围变化）、clipToTokenBudget 截断。
 */
import { describe, expect, it } from 'vitest'
import { analyzeText, clipToTokenBudget, estimateTokens, isBigramTerm, isKana, tokenize } from '../src/core/tokenize.js'

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

  it('全角、半角与兼容写法归一到同一 token', () => {
    expect(tokenize('ＡＢＣ　ｈｅｌｌｏ　１２３')).toEqual(tokenize('ABC hello 123'))
    expect(tokenize('ＧＰＴ４')).toEqual(['gpt4'])
    // 半角片假名与浊点合成为常规片假名后再切 bigram
    expect(tokenize('ｶﾞｲﾄﾞ')).toEqual(tokenize('ガイド'))
    // 组合音标与预组合字符同形
    expect(tokenize('café')).toEqual(['café'])
    // 归一只发生在分词内部，全角标点仍是分隔符
    expect(tokenize('你好，ｗｏｒｌｄ！')).toEqual(['你好', 'world'])
  })

  it('analyzeText 同时给出检索词与 bigram 文字的每个字', () => {
    expect(analyzeText('凛去哪了')).toMatchObject({ terms: ['凛去', '去哪', '哪了'], chars: ['凛', '去', '哪', '了'] })
    // 单字切不出 bigram，但仍作为单字保留
    expect(analyzeText('樱')).toMatchObject({ terms: [], chars: ['樱'] })
    expect(analyzeText('我喜欢apple派')).toMatchObject({ terms: ['我喜', '喜欢', 'apple'], chars: ['我', '喜', '欢', '派'] })
    // 重复的字逐次保留，供索引统计词频
    expect(analyzeText('妹妹').chars).toEqual(['妹', '妹'])
    // 整词文字不拆成单字
    expect(analyzeText('Hello, world 42')).toEqual({ terms: ['hello', 'world', '42'], chars: [], initials: [], finals: [], words: [], sides: [],
      lefts: [], rights: [], lone: false })
    expect(analyzeText('Привет').chars).toEqual([])
    // 归一发生在切分之前
    expect(analyzeText('ｶﾞｲﾄﾞ')).toMatchObject({ terms: ['ガイ', 'イド'], chars: ['ガ', 'イ', 'ド'] })
    for (const text of ['', ' ，。 ', '我喜欢apple派', '안녕하세요 world', 'café 魔法塔']) {
      expect(analyzeText(text).terms).toEqual(tokenize(text))
    }
  })

  it('analyzeText 记下每段 bigram 文字的首字与尾字', () => {
    // 标点、空白和别的文字都是段的边界；单字成段时首尾是同一个字
    expect(analyzeText('凛的妹妹叫樱，住在冬木。')).toMatchObject({ initials: ['凛', '住'], finals: ['樱', '木'] })
    expect(analyzeText('Nova的剑 樱')).toMatchObject({ initials: ['的', '樱'], finals: ['剑', '樱'] })
    expect(analyzeText('')).toEqual({ terms: [], chars: [], initials: [], finals: [], words: [], sides: [], lefts: [], rights: [], lone: true })
  })

  it('analyzeText 找出单独成词的字：两侧都是标点、段首尾或虚词', () => {
    // 凛：句首 + 的；樱：叫 + 逗号；住：逗号 + 在；妹妹、冬木各自相连，虚词自己两侧是实字，都不算
    expect(analyzeText('凛的妹妹叫樱，住在冬木。').words).toEqual(['凛', '樱', '住'])
    // 「打听」「开始」里的字两侧有实字
    expect(analyzeText('去打听几点开始').words).toEqual([])
    // 泛义字不当边界：今天、后面、一直里的字不因此算单独成词
    expect(analyzeText('今天后面一直很吵').words).toEqual(['吵'])
    // 单字成段
    expect(analyzeText('樱 药').words).toEqual(['樱', '药'])
    // 引出名字的字后面跟一个字再跟边界：绰号鲸，——句中的「三号库房」不算，句末的「三号库」会被误算
    expect(analyzeText('头领绰号鲸，守着三号库房').words).toEqual(['鲸', '守'])
    expect(analyzeText('三号库').words).toEqual(['库'])
    expect(analyzeText('他姓秦。').words).toEqual(['秦'])
  })

  it('analyzeText 找出至少一侧是边界的字', () => {
    // 句首的雪、句末的吗；「今天吃东西」中间的字两侧都是实字或泛义字
    expect(analyzeText('雪今天吃东西了吗').sides).toEqual(['雪', '西', '了', '吗'])
    expect(analyzeText('几点开始放').sides).toEqual(['几', '放'])
    expect(new Set(analyzeText('凛的妹妹叫樱，').sides)).toEqual(new Set(['凛', '妹', '樱']))
  })

  it('撇号后面的词尾不算词，别处的单个字母照常保留', () => {
    expect(tokenize("It's Mara's key, don't touch")).toEqual(['it', 'mara', 'key', 'don', 'touch'])
    expect(tokenize('I\u2019d say we\u2019ll know when they\u2019re back, I\u2019ve seen it, I\u2019m sure')).toEqual(
      ['i', 'say', 'we', 'know', 'when', 'they', 'back', 'i', 'seen', 'it', 'i', 'sure'])
    // 全角撇号归一后同样处理
    expect(tokenize('Mara\uff07s key')).toEqual(['mara', 'key'])
    // 字母本身是名字：不在撇号后面就保留；撇号前面的也保留
    expect(tokenize('M gave T the file')).toEqual(['m', 'gave', 't', 'the', 'file'])
    expect(tokenize("D's plan")).toEqual(['d', 'plan'])
    expect(tokenize("O'Brien and D'Artagnan")).toEqual(['o', 'brien', 'and', 'd', 'artagnan'])
    expect(tokenize('小S和T先生')).toEqual(['s', 't', '先生'])
    // 开头的撇号前面没有词，不当作词尾
    expect(tokenize("'s Morgens")).toEqual(['s', 'morgens'])
    expect(tokenize("rock 'n' roll")).toEqual(['rock', 'n', 'roll'])
  })

  it('analyzeText 分别记下左侧、右侧是边界的字', () => {
    // 豆在句首，柯在虚词「过」之后；伤在「过」之前，文在句末
    expect(analyzeText('豆抓伤过柯文')).toMatchObject({ lefts: ['豆', '柯'], rights: ['伤', '文'] })
    // 「流浪猫豆是」里的豆只有右侧是边界
    expect(analyzeText('流浪猫豆是随船来的')).toMatchObject({ lefts: ['流', '随'], rights: ['豆', '来', '的'] })
    // 两者的并集就是 sides
    for (const text of ['雪今天吃东西了吗', '凛的妹妹叫樱，住在冬木。', '头领绰号鲸，守着三号库房']) {
      const tokens = analyzeText(text)
      expect(new Set([...tokens.lefts, ...tokens.rights])).toEqual(new Set(tokens.sides))
      // 两侧都是边界的字就是 words
      expect(tokens.words.every((char) => tokens.lefts.includes(char) && tokens.rights.includes(char))).toBe(true)
    }
  })

  it('analyzeText 判断整段是否只有被虚词或标点隔开的单个字', () => {
    for (const text of ['豆在哪', '药呢？', '岚的腿', '樱 药', '我走了', '樱']) expect(analyzeText(text).lone, text).toBe(true)
    // 两个相邻的非虚词字、泛义字挨着实字、整词文字都不算
    for (const text of ['豆今天吃了吗', '豆去哪了', '钥匙', '翡翠钥匙在哪', 'Nova呢', '樱 Nova']) expect(analyzeText(text).lone, text).toBe(false)
  })

  it('isBigramTerm 只认两个字都是 bigram 文字的词，isKana 只认假名', () => {
    expect(['魔法', 'かな', '안녕', '猫が'].every(isBigramTerm)).toBe(true)
    expect(['ab', 'a1', '魔', '魔法塔', 'x魔', ''].some(isBigramTerm)).toBe(false)
    expect(['か', 'カ', 'ー', 'ㇰ'].every(isKana)).toBe(true)
    expect(['魔', '안', 'a', '1'].some(isKana)).toBe(false)
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

  it('截断长正文不能把 emoji 切成半个字符', () => {
    const original = `a${'😀'.repeat(30)}`
    const result = clipToTokenBudget(original, 6)
    expect(result.truncated).toBe(true)
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text)
    expect(result.tokens).toBeLessThanOrEqual(6)
  })

  it('不同预算和混合语言始终返回合法 Unicode，并遵守原估算预算', () => {
    for (const original of [`a${'😀'.repeat(40)}`, `中文a${'𠮷😺'.repeat(30)}`]) {
      for (let budget = 1; budget < 40; budget++) {
        const result = clipToTokenBudget(original, budget)
        expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text)
        expect(result.tokens).toBe(estimateTokens(result.text))
        expect(result.tokens).toBeLessThanOrEqual(budget)
      }
    }
  })
})
