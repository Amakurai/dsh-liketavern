/** worker 阶段消息适配测试：用可控时钟证明装载与第三方计算各自累计，重复信号不能延期。 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isolated, disposeIdleComputeWorkers } from '../src/node/isolated.js'

const workers = vi.hoisted(() => ({ current: null as null | EventEmitter, id:0, posted:false, terminated:0 }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); workers.current = this }
    postMessage(request:{id:number}) { workers.id=request.id;workers.posted=true }
    ref() { return this }
    unref() { return this }
    async terminate() { workers.terminated++;this.emit('exit',1);return 1 }
  },
}))
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(async () => { await disposeIdleComputeWorkers();vi.useRealTimers();workers.current=null;workers.posted=false;workers.terminated=0 })
const input = { text: '工厂正文', rules: [], macroCtx: { char: 'A', user: 'B' } }
async function ready():Promise<void> {
  // acquireWorker 经异步租借后才挂监听器并发送请求；不能在构造瞬间伪造 worker 已完成。
  for(let attempt=0;attempt<10&&!workers.posted;attempt++)await Promise.resolve()
  expect(workers.posted).toBe(true)
}
function emit(message:Record<string,unknown>):void {workers.current!.emit('message',{id:workers.id,...message})}

it('计算预算跨装载和重复 computing 信号累计，超时后释放 worker 槽位', async () => {
  const task = isolated('render', input, 100)
  const failure = expect(task).rejects.toThrow('第三方正则或提示词计算超时')
  await ready()
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(60)
  emit({ loading: true })
  await vi.advanceTimersByTimeAsync(500)
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(20)
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(21)
  await failure
  expect(workers.terminated).toBe(1)
  workers.posted=false
  const next = isolated('render', input)
  await ready()
  emit({ value: { text: '下一任务', applied: [], warnings: [] } })
  expect((await next).text).toBe('下一任务')
})

it('重复 loading 和中间计算阶段不能刷新累计装载预算', async () => {
  const task = isolated('render', input, 1000)
  const failure = expect(task).rejects.toThrow('启动或装载超时')
  await ready()
  await vi.advanceTimersByTimeAsync(6000)
  emit({ loading: true })
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(10)
  emit({ loading: true })
  await vi.advanceTimersByTimeAsync(4001)
  await failure
})
