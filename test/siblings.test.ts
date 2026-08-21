/**
 * 分支兄弟索引（core/siblings）：
 * - normalizeSiblingForks：不可信 JSON 归一化，坏记录跳过；
 * - recordSiblingFork：追加幂等（childSessionId 去重），拒绝自环；
 * - siblingSwipe：同父同层成组、位次按创建先后（根在前）、嵌套同层 fork 并组、
 *   不同楼层互不串组、exists 过滤已删会话后位次重算；
 * - pruneSiblingForks：剪掉悬空记录并报告变化。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeSiblingForks,
  pruneSiblingForks,
  recordSiblingFork,
  siblingSwipe,
  type SiblingFork,
} from '../src/core/siblings.js'

let seq = 0
function makeFork(parent: string, turn: number, child: string, createdAt?: string): SiblingFork {
  seq += 1
  return {
    parentSessionId: parent,
    turn,
    childSessionId: child,
    createdAt: createdAt ?? `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  }
}

describe('normalizeSiblingForks', () => {
  it('非数组/坏记录跳过，合法记录保留', () => {
    expect(normalizeSiblingForks(null)).toEqual([])
    expect(normalizeSiblingForks({})).toEqual([])
    const raw = [
      makeFork('A', 3, 'B'),
      { parentSessionId: '', turn: 1, childSessionId: 'X', createdAt: 't' },
      { parentSessionId: 'A', turn: 'x', childSessionId: 'Y' },
      { parentSessionId: 'A', turn: -1, childSessionId: 'Z', createdAt: 't' },
      'garbage',
      { parentSessionId: 'A', turn: 2, childSessionId: 'C' },
    ]
    const out = normalizeSiblingForks(raw)
    expect(out).toHaveLength(2)
    expect(out[0]!.childSessionId).toBe('B')
    // createdAt 缺失补空串
    expect(out[1]).toEqual({ parentSessionId: 'A', turn: 2, childSessionId: 'C', createdAt: '' })
  })
})

describe('recordSiblingFork', () => {
  it('追加记录；childSessionId 重复时幂等', () => {
    const f1 = makeFork('A', 3, 'B')
    const forks = recordSiblingFork([], f1)
    expect(forks).toHaveLength(1)
    const again = recordSiblingFork(forks, makeFork('A', 3, 'B'))
    expect(again).toHaveLength(1)
  })

  it('自环记录被拒绝', () => {
    expect(recordSiblingFork([], makeFork('A', 3, 'A'))).toHaveLength(0)
  })
})

describe('siblingSwipe', () => {
  it('同父同层 fork 成组：父在前，子按创建先后，index 为当前会话位次', () => {
    const forks = [makeFork('A', 3, 'B'), makeFork('A', 3, 'C')]
    expect(siblingSwipe(forks, 'A', 3)).toEqual({ index: 0, total: 3, siblings: ['A', 'B', 'C'] })
    expect(siblingSwipe(forks, 'C', 3)).toEqual({ index: 2, total: 3, siblings: ['A', 'B', 'C'] })
  })

  it('嵌套同层 fork 并入同一组（分支里再分支同一楼层）', () => {
    const forks = [makeFork('A', 3, 'B'), makeFork('B', 3, 'C')]
    expect(siblingSwipe(forks, 'B', 3)).toEqual({ index: 1, total: 3, siblings: ['A', 'B', 'C'] })
    expect(siblingSwipe(forks, 'C', 3)?.siblings).toEqual(['A', 'B', 'C'])
  })

  it('不同楼层互不串组；无记录的楼层返回 null', () => {
    const forks = [makeFork('A', 3, 'B'), makeFork('A', 5, 'D')]
    expect(siblingSwipe(forks, 'A', 3)).toEqual({ index: 0, total: 2, siblings: ['A', 'B'] })
    expect(siblingSwipe(forks, 'A', 5)).toEqual({ index: 0, total: 2, siblings: ['A', 'D'] })
    expect(siblingSwipe(forks, 'D', 3)).toBeNull()
    expect(siblingSwipe(forks, 'A', 7)).toBeNull()
    expect(siblingSwipe([], 'A', 3)).toBeNull()
  })

  it('exists 过滤已删除会话：成员剔除后位次重算', () => {
    const forks = [makeFork('A', 3, 'B'), makeFork('A', 3, 'C')]
    const exists = (id: string) => id !== 'B'
    expect(siblingSwipe(forks, 'A', 3, exists)).toEqual({ index: 0, total: 2, siblings: ['A', 'C'] })
    expect(siblingSwipe(forks, 'C', 3, exists)).toEqual({ index: 1, total: 2, siblings: ['A', 'C'] })
    // 只剩自己时视为无兄弟
    const onlyB = (id: string) => id === 'B'
    expect(siblingSwipe(forks, 'B', 3, onlyB)).toBeNull()
  })
})

describe('pruneSiblingForks', () => {
  it('剪掉父或子已不存在的记录并报告变化', () => {
    const forks = [makeFork('A', 3, 'B'), makeFork('A', 3, 'C'), makeFork('X', 1, 'Y')]
    const pruned = pruneSiblingForks(forks, (id) => id !== 'C' && id !== 'X')
    expect(pruned.changed).toBe(true)
    expect(pruned.forks.map((f) => f.childSessionId)).toEqual(['B'])
    const same = pruneSiblingForks(pruned.forks, () => true)
    expect(same.changed).toBe(false)
    expect(same.forks).toHaveLength(1)
  })
})
