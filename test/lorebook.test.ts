/**
 * 世界书归一化（lorebook）单元测试。
 * 覆盖：原生 WI 对象 map 解析（/regex/ 键、null 跟随全局、selectiveLogic 数值、容错转换）、
 * character_book 条目（extensions 覆盖、before_char/after_char 字符串 position）、
 * 往返导出一致性、mergeDeltasForExport 三种 type 与 revoked/过期忽略、
 * 导入硬上限与错型拒绝（条目数 2000 / 正文 100000 / 键 500；键容器与 content 错型归一化时抛错，
 * 非对象条目保持静默跳过以兼容旧导入）。
 */
import { describe, expect, it } from 'vitest'
import type { WorldDelta } from '../src/core/types.js'
import { exportLorebook, mergeDeltasForExport, parseLorebook } from '../src/state/lorebook.js'

const NATIVE_MAP = {
  entries: {
    '0': {
      uid: 0,
      key: ['foo', '/ba+r/gi'],
      keysecondary: ['baz'],
      comment: '条目A',
      content: '内容A',
      constant: false,
      disable: false,
      order: '50', // 字符串数字容错
      position: 4,
      depth: 2,
      role: 1,
      outletName: '',
      probability: '80',
      useProbability: 1, // 非 boolean 容错
      selective: true,
      selectiveLogic: 2,
      scanDepth: null, // 条目级 null = 跟随全局
      caseSensitive: null,
      matchWholeWords: true,
      excludeRecursion: true,
      preventRecursion: false,
      delayUntilRecursion: 1,
      sticky: 2,
      cooldown: null,
      delay: 0,
      group: 'g1',
      groupWeight: 80,
      groupOverride: true,
      automationId: 'auto1',
    },
    '7': {
      key: ['x'],
      content: 'c',
      disable: 1,
      position: 99, // 非法 → 回落 0
      selectiveLogic: 9, // 非法 → 回落 0
      role: 5, // 非法 → 回落 0
    },
  },
}

describe('parseLorebook：原生 WI 对象 map', () => {
  const entries = parseLorebook(NATIVE_MAP, { source: 'global', sourceRef: 'book1' })

  it('map 键即 uid，key 组为 source:sourceRef:uid', () => {
    expect(entries).toHaveLength(2)
    expect(entries[0]!.uid).toBe('0')
    expect(entries[0]!.key).toBe('global:book1:0')
    expect(entries[1]!.uid).toBe('7')
  })

  it('字段全量映射，含 /regex/ 键原样保留与容错转换', () => {
    const e = entries[0]!
    expect(e.keys).toEqual(['foo', '/ba+r/gi'])
    expect(e.secondaryKeys).toEqual(['baz'])
    expect(e.comment).toBe('条目A')
    expect(e.content).toBe('内容A')
    expect(e.constant).toBe(false)
    expect(e.enabled).toBe(true)
    expect(e.order).toBe(50)
    expect(e.position).toBe(4)
    expect(e.depth).toBe(2)
    expect(e.role).toBe(1)
    expect(e.probability).toBe(80)
    expect(e.useProbability).toBe(true)
    expect(e.selective).toBe(true)
    expect(e.selectiveLogic).toBe(2)
    expect(e.matchWholeWords).toBe(true)
    expect(e.excludeRecursion).toBe(true)
    expect(e.preventRecursion).toBe(false)
    expect(e.delayUntilRecursion).toBe(1)
    expect(e.sticky).toBe(2)
    expect(e.delay).toBe(0)
    expect(e.group).toBe('g1')
    expect(e.groupWeight).toBe(80)
    expect(e.groupOverride).toBe(true)
    expect(e.automationId).toBe('auto1')
  })

  it('条目级 null 保留为 null（跟随全局）', () => {
    expect(entries[0]!.scanDepth).toBeNull()
    expect(entries[0]!.caseSensitive).toBeNull()
    expect(entries[0]!.cooldown).toBeNull()
  })

  it('缺省与非法值回落默认', () => {
    const e = entries[1]!
    expect(e.enabled).toBe(false) // disable: 1 → true
    expect(e.position).toBe(0)
    expect(e.selectiveLogic).toBe(0)
    expect(e.role).toBe(0)
    expect(e.order).toBe(100)
    expect(e.depth).toBe(4)
    expect(e.probability).toBe(100)
    expect(e.useProbability).toBe(true)
    expect(e.selective).toBe(true)
    expect(e.constant).toBe(false)
    expect(e.delayUntilRecursion).toBe(0)
    expect(e.sticky).toBeNull()
    expect(e.outletName).toBe('')
  })

  it('非法输入抛中文错误', () => {
    expect(() => parseLorebook('nope', { source: 'global', sourceRef: 'b' })).toThrow(/不是对象或条目数组/)
    expect(() => parseLorebook({}, { source: 'global', sourceRef: 'b' })).toThrow(/缺少 entries/)
  })
})

describe('parseLorebook：character_book 条目', () => {
  const book = {
    name: '内嵌书',
    entries: [
      {
        keys: ['剑'],
        secondary_keys: ['断'],
        content: '断剑重铸',
        enabled: true,
        insertion_order: 42,
        comment: '武器',
        selective: true,
        constant: false,
        priority: 5, // 遗留字段，忽略
        case_sensitive: true, // extensions 无 case_sensitive 时回落顶层
        position: 'before_char', // 被 extensions.position 覆盖
        extensions: {
          position: 4,
          depth: 6,
          role: 2,
          outlet_name: 'out1',
          probability: 55,
          useProbability: false,
          selectiveLogic: 3,
          scan_depth: 8,
          match_whole_words: false,
          exclude_recursion: true,
          prevent_recursion: true,
          delay_until_recursion: 2,
          sticky: 3,
          cooldown: 1,
          delay: 0,
          group: 'g',
          group_weight: 40,
          group_override: true,
          automation_id: 'a',
          ignore_budget: true,
        },
      },
      { keys: ['城'], content: '王城', position: 'after_char', enabled: 1 },
    ],
  }

  it('extensions snake_case 覆盖顶层，extensions.position 数值优先于顶层字符串', () => {
    const entries = parseLorebook(book, { source: 'character', sourceRef: 'cardX' })
    expect(entries).toHaveLength(2)
    const e = entries[0]!
    expect(e.key).toBe('character:cardX:0') // 无 uid → 数组下标
    expect(e.keys).toEqual(['剑'])
    expect(e.secondaryKeys).toEqual(['断'])
    expect(e.order).toBe(42)
    expect(e.position).toBe(4) // extensions.position 覆盖 'before_char'
    expect(e.depth).toBe(6)
    expect(e.role).toBe(2)
    expect(e.outletName).toBe('out1')
    expect(e.probability).toBe(55)
    expect(e.useProbability).toBe(false)
    expect(e.selectiveLogic).toBe(3)
    expect(e.scanDepth).toBe(8)
    expect(e.caseSensitive).toBe(true) // 顶层 case_sensitive 兜底
    expect(e.matchWholeWords).toBe(false)
    expect(e.excludeRecursion).toBe(true)
    expect(e.preventRecursion).toBe(true)
    expect(e.delayUntilRecursion).toBe(2)
    expect(e.sticky).toBe(3)
    expect(e.cooldown).toBe(1)
    expect(e.group).toBe('g')
    expect(e.groupWeight).toBe(40)
    expect(e.groupOverride).toBe(true)
    expect(e.automationId).toBe('a')
    expect(e.ignoreBudget).toBe(true)
    expect(e.selective).toBe(true)
    expect(e.enabled).toBe(true)
  })

  it('顶层字符串 position：after_char → 1；缺省走 character_book 默认', () => {
    const entries = parseLorebook(book, { source: 'character', sourceRef: 'cardX' })
    const e = entries[1]!
    expect(e.position).toBe(1)
    expect(e.enabled).toBe(true) // enabled: 1 容错
    expect(e.uid).toBe('1')
    expect(e.order).toBe(100)
    expect(e.depth).toBe(4)
    expect(e.selective).toBe(false) // character_book selective 默认 false
    expect(e.caseSensitive).toBeNull()
    expect(e.scanDepth).toBeNull()
    expect(e.sticky).toBeNull()
  })

  it('顶层即条目数组同样可解析', () => {
    const viaObject = parseLorebook(book, { source: 'character', sourceRef: 'cardX' })
    const viaArray = parseLorebook(book.entries, { source: 'character', sourceRef: 'cardX' })
    expect(viaArray).toEqual(viaObject)
  })
})

describe('exportLorebook：ST 原生形态与往返', () => {
  it('导出 {entries: {<uid>: {...}}}，字段对齐原生 WI JSON', () => {
    const once = parseLorebook(NATIVE_MAP, { source: 'global', sourceRef: 'b' })
    const exported = exportLorebook(once, '任意名字') as { entries: Record<string, Record<string, unknown>> }
    expect(Object.keys(exported.entries)).toEqual(['0', '7'])
    const e0 = exported.entries['0']!
    expect(e0.uid).toBe('0')
    expect(e0.key).toEqual(['foo', '/ba+r/gi'])
    expect(e0.keysecondary).toEqual(['baz'])
    expect(e0.disable).toBe(false)
    expect(e0.scanDepth).toBeNull()
    expect(e0.selectiveLogic).toBe(2)
    expect(e0.groupWeight).toBe(80)
    expect(e0.groupOverride).toBe(true)
    expect(exported.entries['7']!.disable).toBe(true)
    expect(exported.entries['7']!.groupWeight).toBe(100)
    expect(exported.entries['7']!.groupOverride).toBe(false)
  })

  it('parse(export(parse(x))) 深相等（往返无损）', () => {
    const once = parseLorebook(NATIVE_MAP, { source: 'global', sourceRef: 'b' })
    const twice = parseLorebook(exportLorebook(once, 'b'), { source: 'global', sourceRef: 'b' })
    expect(twice).toEqual(once)
  })
})

describe('导入硬上限与错型拒绝（统一拒绝口径，不做静默截断）', () => {
  const OPTS = { source: 'global', sourceRef: 'b' } as const

  it('条目数超过 2000 拒绝导入（map 与数组形态同口径）', () => {
    const map: Record<string, unknown> = {}
    for (let i = 0; i < 2001; i++) map[String(i)] = { key: [`k${i}`], content: 'c' }
    expect(() => parseLorebook({ entries: map }, OPTS)).toThrow(/条目数 2001 超过上限 2000/)
    const arr = Array.from({ length: 2001 }, (_, i) => ({ keys: [`k${i}`], content: 'c' }))
    expect(() => parseLorebook(arr, OPTS)).toThrow(/条目数/)
    // 恰好 2000 条放行
    const ok = Array.from({ length: 2000 }, (_, i) => ({ keys: [`k${i}`], content: 'c' }))
    expect(parseLorebook(ok, OPTS)).toHaveLength(2000)
  })

  it('单条正文超过 100000 字符拒绝（native 与 character_book 条目同口径）', () => {
    expect(() => parseLorebook({ entries: [{ key: ['a'], content: 'x'.repeat(100_001) }] }, OPTS)).toThrow(/正文/)
    expect(() => parseLorebook({ entries: [{ keys: ['a'], content: 'x'.repeat(100_001) }] }, OPTS)).toThrow(/正文/)
    // 恰好 100000 字符放行
    const ok = parseLorebook({ entries: [{ keys: ['a'], content: 'x'.repeat(100_000) }] }, OPTS)
    expect(ok).toHaveLength(1)
  })

  it('单个触发键超过 500 字符拒绝（主键与次级键同口径）', () => {
    expect(() => parseLorebook({ entries: [{ keys: ['k'.repeat(501)], content: 'c' }] }, OPTS)).toThrow(/触发键/)
    expect(() => parseLorebook({ entries: [{ key: ['a'], keysecondary: ['s'.repeat(501)], content: 'c' }] }, OPTS)).toThrow(
      /触发键/,
    )
    // 恰好 500 字符放行
    const ok = parseLorebook({ entries: [{ keys: ['k'.repeat(500)], content: 'c' }] }, OPTS)
    expect(ok).toHaveLength(1)
  })

  it('合法 JSON 但字段错型在归一化时抛错，而不是落盘后在 .includes()/.map() 才炸', () => {
    // key 给字符串而不是数组：旧口径会被 toStrArr 静默塌缩成 []，现在直接拒绝
    expect(() => parseLorebook({ entries: [{ key: 'not-array', content: 'c' }] }, OPTS)).toThrow(/不是数组/)
    expect(() => parseLorebook({ entries: [{ keys: ['a'], secondary_keys: 'x', content: 'c' }] }, OPTS)).toThrow(/不是数组/)
    // content 是对象：旧口径静默塌缩成 ''，现在拒绝
    expect(() => parseLorebook({ entries: [{ keys: ['a'], content: { nested: true } }] }, OPTS)).toThrow(
      /content 不是字符串/,
    )
  })

  it('非对象条目保持静默跳过（兼容已在工作区落盘的旧导入文件）', () => {
    const entries = parseLorebook({ entries: [{ keys: ['a'], content: 'c' }, null, 42, 'junk'] }, OPTS)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.keys).toEqual(['a'])
  })
})

describe('mergeDeltasForExport', () => {
  const originals = parseLorebook(
    {
      entries: {
        '1': { key: ['a'], content: '旧内容', order: 10 },
        '2': { key: ['b'], content: '将被作废' },
      },
    },
    { source: 'character', sourceRef: 'c' },
  )

  function delta(partial: Partial<WorldDelta> & Pick<WorldDelta, 'id' | 'type'>): WorldDelta {
    return {
      ts: '2026-01-01T00:00:00.000Z',
      ref: null,
      content: '',
      keys: [],
      order: 100,
      sourceRange: 'msg#1-2',
      expires: null,
      ...partial,
    }
  }

  it('update 替换 content、invalidate 标记禁用、add 追加新条目', () => {
    const merged = mergeDeltasForExport(originals, [
      delta({ id: '1', type: 'update', ref: '1', content: '新内容' }),
      delta({ id: '2', type: 'invalidate', ref: '2' }),
      delta({ id: '3', type: 'add', content: '新增设定', keys: ['新'], order: 77 }),
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0]!.content).toBe('新内容')
    expect(merged[1]!.enabled).toBe(false)
    const added = merged[2]!
    expect(added.uid).toBe('delta-3')
    expect(added.key).toBe('global:delta:delta-3')
    expect(added.source).toBe('global')
    expect(added.keys).toEqual(['新'])
    expect(added.content).toBe('新增设定')
    expect(added.order).toBe(77)
    expect(added.enabled).toBe(true)
    expect(added.position).toBe(1) // AfterCharDefs
  })

  it('revoked 与已过期的 delta 忽略', () => {
    const merged = mergeDeltasForExport(originals, [
      delta({ id: '1', type: 'update', ref: '1', content: '已撤销', revoked: true }),
      delta({ id: '5', type: 'add', content: '过期设定', expires: '2000-01-01T00:00:00.000Z' }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]!.content).toBe('旧内容')
  })

  it('ref 未命中的 update/invalidate 忽略，且不修改入参', () => {
    const merged = mergeDeltasForExport(originals, [
      delta({ id: '6', type: 'update', ref: '999', content: '无目标' }),
      delta({ id: '7', type: 'invalidate', ref: '999' }),
    ])
    expect(merged).toHaveLength(2)
    expect(originals[0]!.content).toBe('旧内容') // 入参未被改
    expect(originals[1]!.enabled).toBe(true)
  })
})
