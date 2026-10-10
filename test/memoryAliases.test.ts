/**
 * 记忆检索别名的纯函数：提示词、模型回复的解析、别名清理与别名文件格式。
 * 回复来自模型、文件可能被手改，都按不可信输入对待：不合格式的行和条目被丢弃，不会把解释性的话或功能词变成检索词。
 */
import { describe, expect, it } from 'vitest'
import {
  ALIAS_LIMIT, ALIAS_MAX_CHARS, buildAliasPrompt, normalizeAliases, parseAliasFile, parseAliasReply, serializeAliasFile,
} from '../src/core/memoryAliases.js'

describe('buildAliasPrompt', () => {
  it('按序号列出每条记忆，正文里的换行压成一行', () => {
    const prompt = buildAliasPrompt(['医务室的止痛剂少了两箱。', '砚的女儿叫禾，\n寄养在姑妈家。'])
    expect(prompt).toContain('【1】医务室的止痛剂少了两箱。')
    expect(prompt).toContain('【2】砚的女儿叫禾， 寄养在姑妈家。')
    expect(prompt.split('\n').filter((line) => line.startsWith('【'))).toHaveLength(2)
    expect(prompt).toContain(`${ALIAS_LIMIT}`)
  })
})

describe('parseAliasReply', () => {
  const bodies = ['医务室的止痛剂上个月少了两箱。', '禾对合成蛋白过敏，只能吃温室种的豆子。', '总部计划明年关闭灰烬站。']

  it('接受几种常见的序号写法与分隔符，没有对应行的位置为 null', () => {
    const reply = ['1: 药、药品、失窃、偷药', '【2】禾，过敏；食物｜饮食禁忌'].join('\n')
    expect(parseAliasReply(reply, bodies)).toEqual([['药', '药品', '失窃', '偷药'], ['禾', '过敏', '食物', '饮食禁忌'], null])
    expect(parseAliasReply('1. 药、失窃\n2、禾\n(3) 关站 / 停运\n', bodies)).toEqual([['药', '失窃'], ['禾'], ['关站', '停运']])
    expect(parseAliasReply('- [3]：关站、撤离\r\n- 1) 药', bodies)).toEqual([['药'], null, ['关站', '撤离']])
  })

  it('没有序号的话、越界的序号、重复的序号都不算', () => {
    const reply = ['好的，以下是别名：', '3 条记忆的别名如下', '1: 药、失窃', '1: 重复的一行', '4: 越界', '0: 越界', '总结：以上。'].join('\n')
    expect(parseAliasReply(reply, bodies)).toEqual([['药', '失窃'], null, null])
    expect(parseAliasReply('', bodies)).toEqual([null, null, null])
    expect(parseAliasReply('模型拒绝了这个请求。', bodies)).toEqual([null, null, null])
  })

  it('有序号但后面是空的：记为没有别名，而不是没有回复', () => {
    expect(parseAliasReply('1:\n2: 禾', bodies)).toEqual([[], ['禾'], null])
  })
})

describe('normalizeAliases', () => {
  it('去掉包裹的引号、括号与首尾标点，去重时不分大小写', () => {
    expect(normalizeAliases(['“药”', '「失窃」。', ' 《药品》 ', '药', '**偷药**', 'Key', 'key'], '正文'))
      .toEqual(['药', '失窃', '药品', '偷药', 'Key'])
  })

  it('丢掉过长的、切不出检索词的、与正文相同的', () => {
    const body = '北门每晚落锁'
    expect(normalizeAliases(['字'.repeat(ALIAS_MAX_CHARS + 1), '……', '', '   ', body, '北门'], body)).toEqual(['北门'])
    expect(normalizeAliases(['字'.repeat(ALIAS_MAX_CHARS)], body)).toHaveLength(1)
  })

  it('丢掉不该成为检索词的：单个虚词与假名、功能词；数词和泛义字的单字名保留', () => {
    expect(normalizeAliases(['他', '的', 'の', '什么', '我们', '这件事', 'the', 'it', '七', '月', '豆', '没有人知道'], '正文'))
      .toEqual(['这件事', '七', '月', '豆', '没有人知道'])
  })

  it('最多保留上限个，非字符串的项忽略', () => {
    const many = Array.from({ length: 20 }, (_, i) => `别名${i}`)
    expect(normalizeAliases(many, '正文')).toHaveLength(ALIAS_LIMIT)
    expect(normalizeAliases([1, null, { a: 1 }, ['药'], '药'], '正文')).toEqual(['药'])
  })
})

describe('别名文件', () => {
  it('往返一致，记录按 id 排序', () => {
    const records = new Map([['m-b', { hash: 'bb', aliases: ['药', '失窃'] }], ['m-a', { hash: 'aa', aliases: [] }]])
    const text = serializeAliasFile(records)
    expect(text.indexOf('m-a')).toBeLessThan(text.indexOf('m-b'))
    expect(text.endsWith('\n')).toBe(true)
    expect([...parseAliasFile(text)].sort()).toEqual([...records].sort())
  })

  it('损坏的文件、形状不对的条目被丢弃，手改进去的功能词不生效', () => {
    expect(parseAliasFile('{ 不是 JSON').size).toBe(0)
    expect(parseAliasFile('[]').size).toBe(0)
    expect(parseAliasFile('{"entries":[]}').size).toBe(0)
    const text = JSON.stringify({ version: 1, entries: {
      good: { hash: 'h1', aliases: ['药', '他', '什么', 42] },
      nohash: { aliases: ['药'] },
      emptyhash: { hash: '', aliases: ['药'] },
      notlist: { hash: 'h2', aliases: '药' },
      nothing: null,
    } })
    expect([...parseAliasFile(text)]).toEqual([['good', { hash: 'h1', aliases: ['药'] }]])
  })
})
