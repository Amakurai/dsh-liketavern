/** 压缩重放的外层期限回归：共享表虽小，恢复多次引用仍获得累计工作预算，并继续服从显式超时。 */
import { EventEmitter } from 'node:events'
import type { WorkerOptions } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { measureTemplateReplayWork, type TemplateReplay } from '../src/core/templateReplay.js'
import { TEMPLATE_INPUT_MAX_CHARS } from '../src/core/templateBudget.js'
import { isolated, disposeIdleComputeWorkers } from '../src/node/isolated.js'
import type { TemplateContinuation } from '../src/core/templateContinuation.js'

const workers = vi.hoisted(() => ({ current: null as null | EventEmitter, id:0, posted:false }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor(_source: string, _options: WorkerOptions) { super(); workers.current = this }
    postMessage(request:{id:number}) { workers.id=request.id;workers.posted=true }
    ref() { return this }
    unref() { return this }
    async terminate() { this.emit('exit',1);return 1 }
  },
}))
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(async () => { await disposeIdleComputeWorkers();vi.useRealTimers();workers.current=null;workers.posted=false })
async function ready():Promise<void> {
  for(let attempt=0;attempt<10&&!workers.posted;attempt++)await Promise.resolve()
  expect(workers.posted).toBe(true)
}
function emit(message:Record<string,unknown>):void {workers.current!.emit('message',{id:workers.id,...message})}
const context: TemplateContext = { variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [], history: [], now: 1, seed: 1, phase: 'generate' }
const replay = (count: number): TemplateReplay => ({ version: 2, formatterVersion: 2, context, variables: emptyTemplateScopes(), messageVariablesHash: '0'.repeat(64),
  shared: [{ value: 'x'.repeat(100_000) }], operations: Array.from({ length: count }, () => ({ kind: 'render', text: '<%- value.length %>', data: { value: null }, refs: { value: 0 }, hash: '0'.repeat(64) })) })

it.each(['reply', 'continuation'] as const)('%s 的小体积共享日志恢复预算按实际引用工作量计算', async (source) => {
  const log = replay(20)
  // 传输约 100 KiB；逻辑入参约 2 MiB，旧默认 1s 会在恢复途中误杀。
  expect(JSON.stringify(log).length).toBeLessThan(256 * 1024)
  const carried = source === 'reply' ? { replay: log } : { templateContinuation: { replay: log } as TemplateContinuation }
  const task = isolated('template', { context, texts: [], ...carried })
  const settled = vi.fn(); void task.then(settled, settled)
  await ready()
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(1200)
  expect(settled).not.toHaveBeenCalled()
  const result = { texts: [], parts: [], variables: emptyTemplateScopes(), messageVariables: { version: 1, snapshots: {} } }
  emit({ value: result })
  expect(await task).toEqual(result)
})

it('共享引用累积工作量封顶，显式期限仍终止恢复任务', async () => {
  const log = replay(1500)
  expect(measureTemplateReplayWork(log)).toBe(TEMPLATE_INPUT_MAX_CHARS)
  const task = isolated('template', { context, texts: [], replay: log }, 80)
  const failure = expect(task).rejects.toThrow(/超时/)
  await ready()
  emit({ computing: true })
  await vi.advanceTimersByTimeAsync(81)
  await failure
})
