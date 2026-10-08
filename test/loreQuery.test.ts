/**
 * 世界书按条阅读：目录、uid/关键词匹配、正文预算截断。
 */
import { describe, expect, it } from 'vitest'
import {
  clipLoreContents,
  budgetLoreCatalog,
  isLoreCatalogQuery,
  selectLoreEntries,
  toLoreCatalogItem,
} from '../src/core/loreQuery.js'
import {
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type WorldInfoEntry,
} from '../src/core/types.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { parseLorebook } from '../src/state/lorebook.js'

function makeEntry(partial: Partial<WorldInfoEntry> & { key: string }): WorldInfoEntry {
  return {
    uid: partial.uid ?? partial.key,
    source: 'global',
    sourceRef: 'book',
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    comment: '',
    content: '',
    constant: false,
    enabled: true,
    order: 100,
    position: WIPosition.BeforeCharDefs,
    depth: 4,
    role: WIRole.System,
    outletName: '',
    probability: 100,
    useProbability: false,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
    ...partial,
  }
}

describe('世界书完整身份', () => {
  const book = (sourceRef: string, uid: string, content: string) => parseLorebook(
    { entries: { [uid]: { content, key: ['港口'] } } }, { source: 'global', sourceRef })

  it('完整 key 精确定位优先于其它条目的同名 uid 和后缀', () => {
    const target = book('first', 'city', '真正的城市条目')[0]!
    const collision = book('second', target.key, '另一条合法但同名的 uid')[0]!
    expect(selectLoreEntries([collision, target], { uid: target.key }).map(entry => entry.content))
      .toEqual(['真正的城市条目'])
  })

  it('保留合法 uid 中的前后空白，并优先精确匹配', () => {
    const entries = [...book('book', ' city ', '空白身份'), ...book('book', 'city', '无空白身份')]
    expect(selectLoreEntries(entries, { uid: ' city ' }).map(entry => entry.content)).toEqual(['空白身份'])
    expect(selectLoreEntries(entries, { uid: 'global:book: city ' }).map(entry => entry.content)).toEqual(['空白身份'])
  })

  it('短 uid 仍能列出各书同名条目，未命中的带空白输入保留兼容查询', () => {
    const entries = [...book('first', 'city', '第一本'), ...book('second', 'city', '第二本')]
    expect(selectLoreEntries(entries, { uid: 'city' })).toHaveLength(2)
    expect(selectLoreEntries(entries, { uid: ' city ' })).toHaveLength(2)
  })
})

describe('isLoreCatalogQuery', () => {
  it('无 uid/query 为目录模式', () => {
    expect(isLoreCatalogQuery({})).toBe(true)
    expect(isLoreCatalogQuery({ source: 'character' })).toBe(true)
    expect(isLoreCatalogQuery({ uid: 'a' })).toBe(false)
    expect(isLoreCatalogQuery({ query: '剑' })).toBe(false)
  })
})

describe('selectLoreEntries', () => {
  const entries = [
    makeEntry({ key: 'global:book:sword', uid: 'sword', keys: ['长剑'], comment: '武器', content: '一把生锈的长剑', order: 10 }),
    makeEntry({ key: 'character:card:city', uid: 'city', source: 'character', sourceRef: 'card', keys: ['都城'], content: '王都在北方', order: 20 }),
    makeEntry({ key: 'global:book:off', uid: 'off', enabled: false, keys: ['秘辛'], content: '未启用的秘密', order: 5 }),
  ]

  it('按 uid 精确取条（含 disabled）', () => {
    expect(selectLoreEntries(entries, { uid: 'off' }).map((e) => e.uid)).toEqual(['off'])
    expect(selectLoreEntries(entries, { uid: 'global:book:sword' }).map((e) => e.uid)).toEqual(['sword'])
  })

  it('按关键词排序：键命中优于正文', () => {
    const hits = selectLoreEntries(entries, { query: '长剑' })
    expect(hits[0]?.uid).toBe('sword')
  })

  it('source 过滤', () => {
    expect(selectLoreEntries(entries, { query: '北', source: 'character' }).map((e) => e.uid)).toEqual(['city'])
    expect(selectLoreEntries(entries, { query: '北', source: 'global' })).toEqual([])
  })
})

describe('toLoreCatalogItem / clipLoreContents', () => {
  it('目录只有预览不含全文', () => {
    const item = toLoreCatalogItem(makeEntry({ key: 'k', uid: 'k', content: '全文很长'.repeat(20), comment: '注' }))
    expect(item.preview.length).toBeLessThanOrEqual(80)
    expect(item.comment).toBe('注')
    expect(item.preview).toBeTruthy()
  })

  it('正文按预算截断并计 omitted', () => {
    const big = makeEntry({ key: 'a', uid: 'a', content: '汉'.repeat(1000) })
    const small = makeEntry({ key: 'b', uid: 'b', content: '尾' })
    const clipped = clipLoreContents([big, small], 300)
    expect(clipped.entries[0]?.truncated).toBe(true)
    expect(clipped.omitted).toBe(1)
    expect(clipped.tokensUsed).toBe(estimateTokens(JSON.stringify(clipped, null, 2)))
    expect(clipped.tokensUsed).toBeLessThanOrEqual(300)
  })

  it('完整目录跳过过大定位，展示字段和触发键裁剪不改写完整key', () => {
    const huge = makeEntry({ key: '过大定位'.repeat(1000), uid: 'huge', content: '正文' })
    const anchor = makeEntry({ key: 'global:book:anchor', uid: 'anchor', comment: '巨大注释'.repeat(1000),
      keys: ['港口', '触发关键词'.repeat(100), '码头'], content: '锚点正文' })
    const output = budgetLoreCatalog([huge, anchor], 500)
    expect(output).toMatchObject({ ok: true, count: 2, omitted: 1, truncated: true,
      entries: [{ uid: 'anchor', key: anchor.key, metadataTruncated: true, keysOmitted: 1, keys: ['港口', '码头'] }] })
    expect(output.tokensUsed).toBe(estimateTokens(JSON.stringify(output, null, 2)))
    expect(output.tokensUsed).toBeLessThanOrEqual(500)
  })

  it('正文转义后的完整JSON仍有界，预算不足响应头时明确拒绝', () => {
    const output = clipLoreContents([makeEntry({ key: 'global:book:control', uid: 'control', content: '\u0000'.repeat(4000) })], 200)
    expect(output.entries[0]?.truncated).toBe(true)
    expect(output.tokensUsed).toBe(estimateTokens(JSON.stringify(output, null, 2)))
    expect(output.tokensUsed).toBeLessThanOrEqual(200)
    expect(() => budgetLoreCatalog([], 0)).toThrow('响应元数据')
  })
})
