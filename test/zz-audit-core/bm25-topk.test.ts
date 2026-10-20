/** 审计复现：BM25 TopHits 用 topK 截断时结果是否与全量排序的前缀一致。 */
import { expect, it } from 'vitest'
import { Bm25Index } from '../../src/core/bm25.js'

/** 分数随 needle 出现次数增加；加入顺序故意打乱，逼迫堆走淘汰分支。 */
function makeIndex(): Bm25Index {
  const index = new Bm25Index()
  const docs: Array<[string, number]> = [
    ['d20', 20], ['d03', 3], ['d40', 40], ['d07', 7], ['d33', 33],
    ['d01', 1], ['d25', 25], ['d12', 12], ['d38', 38], ['d05', 5],
    ['d30', 30], ['d16', 16], ['d08', 8], ['d44', 44], ['d02', 2],
    ['d19', 19], ['d27', 27], ['d10', 10], ['d35', 35], ['d06', 6],
    ['d22', 22], ['d14', 14], ['d41', 41], ['d09', 9], ['d31', 31],
    ['d17', 17], ['d04', 4], ['d26', 26], ['d11', 11], ['d37', 37],
    ['d13', 13], ['d28', 28], ['d15', 15], ['d39', 39], ['d18', 18],
    ['d24', 24], ['d21', 21], ['d32', 32], ['d23', 23], ['d29', 29],
    ['d34', 34], ['d36', 36], ['d42', 42], ['d43', 43], ['d45', 45],
  ]
  for (const [id, count] of docs) {
    index.add({ id, text: Array.from({ length: count }, () => 'needle').join(' ') })
  }
  return index
}

it('topK 截断结果必须等于全量排序的前 topK（含大量淘汰）', () => {
  const index = makeIndex()
  const full = index.search('needle', { topK: 1000 }).map((hit) => hit.id)
  expect(full.length).toBeGreaterThan(3)
  for (const k of [1, 2, 3, 4, 5, 7, 10]) {
    const partial = index.search('needle', { topK: k }).map((hit) => hit.id)
    expect(partial, `topK=${k}`).toEqual(full.slice(0, k))
  }
})
