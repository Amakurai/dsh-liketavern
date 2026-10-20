/**
 * A4 修复验证：host 侧按“error 字段是否存在”判定失败，并校验成功消息必须带 value。
 * { error: '' } 与缺少 value 的成功消息都必须明确失败，不能再 resolve undefined。
 */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { disposeIdleComputeWorkers, isolated } from '../../src/node/isolated.js'

const workers = vi.hoisted(() => ({ current: null as null | EventEmitter, id: 0, posted: false }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); workers.current = this }
    postMessage(request: { id: number }) { workers.id = request.id; workers.posted = true }
    ref() { return this }
    unref() { return this }
    async terminate() { this.emit('exit', 1); return 1 }
  },
}))
afterEach(async () => { await disposeIdleComputeWorkers(); workers.current = null; workers.posted = false })

const input = { text: '工厂正文', rules: [], macroCtx: { char: 'A', user: 'B' } }
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 10 && !workers.posted; attempt++) await Promise.resolve()
  expect(workers.posted).toBe(true)
}

it('A4：error 为空字符串时明确失败', async () => {
  const task = isolated('render', input)
  await ready()
  workers.current!.emit('message', { id: workers.id, error: '' })
  await expect(task).rejects.toThrow(/未提供原因/)
})

it('A4：成功消息缺少 value 时明确失败', async () => {
  const task = isolated('render', input)
  await ready()
  workers.current!.emit('message', { id: workers.id })
  await expect(task).rejects.toThrow(/空结果/)
})
