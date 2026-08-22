/**
 * turn 层预算单测（core/turnBudget.ts）。
 * 覆盖：
 * - clipWorldDeltasForTurn：从最新往旧装载、保序返回（旧→新）、超预算跳过但继续尝试
 *   更旧条目、dropped 计数、预算内全保留、空列表。
 * - WI_PERCENT_WINDOW_BASE / WORLD_DELTA_TURN_BUDGET：导出常量形状（防止误改后
 *   worldbook/pipeline 引用漂移到未定义值）。
 */
import { describe, expect, it } from 'vitest'
import type { WorldDelta } from '../src/core/types.js'
import { clipWorldDeltasForTurn, WI_PERCENT_WINDOW_BASE, WORLD_DELTA_TURN_BUDGET } from '../src/core/turnBudget.js'

let seq = 0
function makeDelta(content: string, partial: Partial<WorldDelta> = {}): WorldDelta {
  seq += 1
  return {
    id: `d${seq}`,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    type: 'add',
    ref: null,
    content,
    keys: [],
    order: 100,
    sourceRange: 't1',
    expires: null,
    ...partial,
  }
}

/** 确定性估算：content 长度即 token 数，便于精确构造预算边界。 */
const estimate = (text: string) => text.length

describe('clipWorldDeltasForTurn', () => {
  it('预算内全保留且维持原时序（旧→新）', () => {
    const deltas = [makeDelta('a'.repeat(10)), makeDelta('b'.repeat(10))]
    const { kept, dropped } = clipWorldDeltasForTurn(deltas, estimate, 100)
    expect(kept.map((d) => d.id)).toEqual(deltas.map((d) => d.id))
    expect(dropped).toBe(0)
  })

  it('超预算优先保留最新：最旧的先被裁', () => {
    const old = makeDelta('x'.repeat(60))
    const mid = makeDelta('y'.repeat(20))
    const newest = makeDelta('z'.repeat(20))
    const { kept, dropped } = clipWorldDeltasForTurn([old, mid, newest], estimate, 50)
    expect(kept.map((d) => d.id)).toEqual([mid.id, newest.id])
    expect(dropped).toBe(1)
  })

  it('单条超预算的跳过但继续尝试更旧的（对齐世界书预算的 skip-and-continue）', () => {
    const huge = makeDelta('h'.repeat(100))
    const small = makeDelta('s'.repeat(10))
    const { kept, dropped } = clipWorldDeltasForTurn([huge, small], estimate, 50)
    expect(kept.map((d) => d.id)).toEqual([small.id])
    expect(dropped).toBe(1)
  })

  it('预算 0 时全部裁掉；空列表原样返回', () => {
    const deltas = [makeDelta('a'), makeDelta('b')]
    expect(clipWorldDeltasForTurn(deltas, estimate, 0)).toEqual({ kept: [], dropped: 2 })
    expect(clipWorldDeltasForTurn([], estimate, 100)).toEqual({ kept: [], dropped: 0 })
  })
})

describe('导出常量', () => {
  it('WI_PERCENT_WINDOW_BASE 为 128K 量级；delta 预算为正数', () => {
    expect(WI_PERCENT_WINDOW_BASE).toBe(131072)
    expect(WORLD_DELTA_TURN_BUDGET).toBeGreaterThan(0)
  })
})
