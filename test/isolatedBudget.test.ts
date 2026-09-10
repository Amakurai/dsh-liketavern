/** worker 阶段消息适配测试：用可控时钟证明装载与第三方计算各自累计，重复信号不能延期。 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isolated } from '../src/node/isolated.js'

const workers = vi.hoisted(() => ({ current: null as null | EventEmitter }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); workers.current = this }
    async terminate() { return 1 }
  },
}))
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => { vi.useRealTimers(); workers.current = null })
const input = { text: '工厂正文', rules: [], macroCtx: { char: 'A', user: 'B' } }

it('计算预算跨装载和重复 computing 信号累计，超时后释放 worker 槽位', async () => {
  const task = isolated('render', input, 100)
  const failure = expect(task).rejects.toThrow('第三方正则或提示词计算超时')
  workers.current!.emit('message', { computing: true })
  await vi.advanceTimersByTimeAsync(60)
  workers.current!.emit('message', { loading: true })
  await vi.advanceTimersByTimeAsync(500)
  workers.current!.emit('message', { computing: true })
  await vi.advanceTimersByTimeAsync(20)
  workers.current!.emit('message', { computing: true })
  await vi.advanceTimersByTimeAsync(21)
  await failure
  const next = isolated('render', input)
  workers.current!.emit('message', { value: { text: '下一任务', applied: [], warnings: [] } })
  expect((await next).text).toBe('下一任务')
})

it('重复 ready 和中间计算阶段不能刷新累计装载预算', async () => {
  const task = isolated('render', input, 1000)
  const failure = expect(task).rejects.toThrow('启动或装载超时')
  await vi.advanceTimersByTimeAsync(6000)
  workers.current!.emit('message', { ready: true })
  workers.current!.emit('message', { computing: true })
  await vi.advanceTimersByTimeAsync(10)
  workers.current!.emit('message', { loading: true })
  await vi.advanceTimersByTimeAsync(4001)
  await failure
})
