/**
 * 世界书按条阅读：目录、uid/关键词匹配、正文预算截断。
 */
import { describe, expect, it } from 'vitest'
import {
  clipLoreContents,
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
    automationId: '',
    ...partial,
  }
}

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
    const big = makeEntry({ key: 'a', uid: 'a', content: '汉'.repeat(100) })
    const small = makeEntry({ key: 'b', uid: 'b', content: '尾' })
    const clipped = clipLoreContents([big, small], 30)
    expect(clipped.entries[0]?.truncated).toBe(true)
    expect(clipped.omitted).toBe(1)
  })
})
