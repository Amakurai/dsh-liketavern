/** 完整性与隔离回归：真实 worker 超时、辅助流终止协议、未知 RPC 键，以及资产读取边界。 */
import { describe, expect, it } from 'vitest'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { collectCompleteText } from '../src/node/collectText.js'
import { compressMemoryBatch } from '../src/node/memoryMaintenance.js'
import { isolated } from '../src/node/isolated.js'
import { compileRegexScripts } from '../src/core/regex.js'
import { emptyTemplateScopes } from '../src/core/template.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { METHODS, type TavernMethodResults } from '../src/remote.js'
import { TavernService } from '../src/node/service.js'

const stream = (chunks: StreamChunk[]) => ({ async *[Symbol.asyncIterator]() { yield* chunks } })
describe('辅助流只接收完整结果', () => {
  it.each(['error', 'aborted', 'max-tokens', 'tool-calls', 'missing'] as const)('%s 不得成为可归档摘要', async (kind) => {
    const chunks = [{ type: 'text-delta', text: '半截事实' }, ...(kind === 'missing' ? [] : [{ type: 'finish', reason: { kind, failure: { message: '失败' } } }])] as StreamChunk[]
    const llm = { stream: () => stream(chunks) } as unknown as LlmRuntime
    expect(await compressMemoryBatch(llm, 'test', 'test', ['事实一', '事实二'])).toBeNull()
  })
  it('正常 stop 返回完整正文；缺帧与挂起适配器均失败', async () => {
    expect(await collectCompleteText(stream([{ type: 'text-delta', text: '完整' }, { type: 'finish', reason: { kind: 'stop' } }] as StreamChunk[]), AbortSignal.timeout(1000))).toBe('完整')
    const stuck = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<StreamChunk>>(() => {}) }) }
    await expect(collectCompleteText(stuck, AbortSignal.timeout(25))).rejects.toThrow()
  })
})

it('重叠分支正则被 worker 超时终止，主线程计时器仍能执行；下一任务可成功', async () => {
  const rules = compileRegexScripts([{ id: 'bad', scriptName: 'bad', findRegex: '^([a-z]|a)+$', replaceString: '', placement: [2], disabled: false }], 'card')
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 30)
  try {
    await expect(isolated('render', { text: 'a'.repeat(40) + '!', rules, macroCtx: { char: 'C', user: 'U' } }, 80)).rejects.toThrow('超时')
    expect(heartbeat).toBe(true)
    const result = await isolated('render', { text: 'normal', rules: [], macroCtx: { char: 'C', user: 'U' } })
    expect(result.text).toBe('normal')
  } finally { clearTimeout(timer) }
})

it('受信装载不占计算预算：小预算模板任务成功，死循环模板仍被终止', async () => {
  const context = { variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [], history: [], now: 1000, seed: 1, phase: 'generate' }
  // vendor 库装载（数百毫秒）在 computing 信号前完成；100ms 预算只覆盖第三方模板执行。
  const result = await isolated('template', { texts: ['<%= "ok" %>'], context }, 100)
  expect(result.texts).toEqual(['ok'])
  await expect(isolated('template', { texts: ['<% while (true) {} %>'], context }, 100)).rejects.toThrow(/interrupt|超时/)
})

it('remote 注册表和 service 方法集均受契约检查约束', () => {
  for (const method of Object.keys(METHODS)) expect(typeof TavernService.prototype[method as keyof TavernMethodResults]).toBe('function')
  expect(METHODS.getMemories.req.safeParse({ cardId: 'test', storyId: 'story-test' }).success).toBe(true)
  for (const path of ['stories/story-test/memory/a.md', 'stories/../card.json', 'state/./wal/a.json', 'story.json']) {
    expect(resolveReadableAssetPath(path).ok).toBe(false)
  }
})

it('预加载的第三方代码也受 worker 计算预算约束，不能借用装载预算', async () => {
  const entries = parseLorebook({ entries: [{ content: '@@preload\n<% while (true) {} %>' }] }, { source: 'global', sourceRef: 'factory' })
  const context = { variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries, presets: [], history: [], now: 1000, seed: 1, phase: 'generate' }
  await expect(isolated('template', { texts: ['ok'], context }, 100)).rejects.toThrow('第三方正则或提示词计算超时')
})
