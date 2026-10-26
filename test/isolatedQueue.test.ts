/** 只读展示突发回归：长历史首屏为每个气泡各发一次 output/render，真实 worker 队列须全部接住。 */
import { expect, it } from 'vitest'
import { isolated } from '../src/node/isolated.js'

it('64 个并发展示渲染全部完成，不因等待队列上限被拒', async () => {
  const texts = Array.from({ length: 64 }, (_, index) => `气泡 ${index}`)
  const results = await Promise.all(texts.map(text => isolated('render', { text, rules: [], macroCtx: { char: 'A', user: 'B' } })))
  expect(results.map(result => result.text)).toEqual(texts)
}, 30_000)
