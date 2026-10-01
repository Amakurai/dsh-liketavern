/** 辅助流取消竞态：合法的缓冲适配器可同步兑现 next，已取消请求仍必须拒绝完整正文并关闭流。 */
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { collectCompleteText } from '../src/node/collectText.js'
import { compressMemoryBatch } from '../src/node/memoryMaintenance.js'

const chunks: readonly StreamChunk[] = [
  { type: 'text-delta', text: '取消后的工厂正文' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** AsyncIterable 允许 next 直接返回已兑现 Promise；不依靠定时器或真实网络制造竞态。 */
function bufferedStream(controller: AbortController, abortAt?: number) {
  let index = 0
  const next = vi.fn((): Promise<IteratorResult<StreamChunk>> => {
    if (index === abortAt) controller.abort(new Error('同步取消工厂调用'))
    const value = chunks[index++]
    return Promise.resolve(value ? { done: false, value } : { done: true, value: undefined })
  })
  const close = vi.fn((): Promise<IteratorResult<StreamChunk>> => Promise.resolve({ done: true, value: undefined }))
  const stream: AsyncIterable<StreamChunk> = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
  return { stream, next, close }
}

it('已取消请求不消费已缓冲正文', async () => {
  const controller = new AbortController(), error = new Error('开始收集前已取消')
  controller.abort(error)
  const fixture = bufferedStream(controller)
  await expect(collectCompleteText(fixture.stream, controller.signal)).rejects.toBe(error)
  expect(fixture.next).not.toHaveBeenCalled()
})

it.each([0, 1, 2])('next 同步取消后即使已经兑现正常帧也拒绝（正文/stop/关闭边界=%s）', async abortAt => {
  const controller = new AbortController(), fixture = bufferedStream(controller, abortAt)
  await expect(collectCompleteText(fixture.stream, controller.signal)).rejects.toThrow('同步取消工厂调用')
  expect(fixture.next).toHaveBeenCalledTimes(abortAt + 1)
  expect(fixture.close).toHaveBeenCalledOnce()
})

it('维护流在创建时被取消，完整缓冲 stop 也不能成为有效摘要', async () => {
  const controller = new AbortController(), fixture = bufferedStream(controller)
  const llm = { stream: () => {
    controller.abort(new Error('维护适配器创建时取消'))
    return fixture.stream
  } } as unknown as LlmRuntime
  expect(await compressMemoryBatch(llm, 'factory', 'factory', ['工厂事实'], controller.signal)).toBeNull()
  expect(fixture.next).not.toHaveBeenCalled()
})

it('next 同步取消后抛错时保留取消原因，关闭流同步抛错也不覆盖它', async () => {
  const controller = new AbortController(), cancel = new Error('同步取消原因')
  const close = vi.fn(() => { throw new Error('关闭流失败') })
  const stream: AsyncIterable<StreamChunk> = { [Symbol.asyncIterator]: () => ({
    next: () => { controller.abort(cancel); throw new Error('next 同步失败') }, return: close,
  }) }
  await expect(collectCompleteText(stream, controller.signal)).rejects.toBe(cancel)
  expect(close).toHaveBeenCalledOnce()
})

it('未取消的 next 故障保持原原因，失败的关闭操作不取代模型流异常', async () => {
  const controller = new AbortController(), original = new Error('模型流故障')
  const stream: AsyncIterable<StreamChunk> = { [Symbol.asyncIterator]: () => ({
    next: () => { throw original }, return: () => { throw new Error('关闭流失败') },
  }) }
  await expect(collectCompleteText(stream, controller.signal)).rejects.toBe(original)
})

it('未取消的缓冲 stop 流仍返回完整正文并关闭流', async () => {
  const controller = new AbortController(), fixture = bufferedStream(controller)
  expect(await collectCompleteText(fixture.stream, controller.signal)).toBe('取消后的工厂正文')
  expect(fixture.next).toHaveBeenCalledTimes(3)
  expect(fixture.close).toHaveBeenCalledOnce()
})
