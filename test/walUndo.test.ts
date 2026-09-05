/** 世界状态逆操作：保留新条目、保留人工修订、恢复被删条目以及保留不可解析行。 */
import { describe, expect, it } from 'vitest'
import { undoWorldDelta } from '../src/core/walUndo.js'

const row = (id: string, content: string) => JSON.stringify({ id, content }) + '\n'
describe('undoWorldDelta', () => {
  it('只移除本次追加的条目', () => {
    expect(undoWorldDelta(null, row('a', '模型'), row('a', '模型') + row('b', '人工'))).toBe(row('b', '人工'))
  })
  it('人工改写同 id 后保留其内容，同时恢复未冲突的修改', () => {
    expect(undoWorldDelta(row('a', '旧') + row('b', '旧'), row('a', '模型') + row('b', '模型'),
      row('a', '人工') + row('b', '模型'))).toBe(row('a', '人工') + row('b', '旧'))
  })
  it('恢复删除且未被重新创建的条目', () => {
    expect(undoWorldDelta(row('a', '旧'), '', row('b', '新'))).toBe(row('b', '新') + row('a', '旧'))
  })
  it('坏行原样保留，不把它当成可撤销 id', () => {
    expect(undoWorldDelta(null, row('a', '模型'), row('a', '模型') + 'bad-line\n')).toBe('bad-line\n')
  })
})
