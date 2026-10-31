/** 模型能力缓存的时钟边界：模拟公开 LlmRuntime 验证回拨失效、正常 TTL 与迟到旧请求不能污染新能力，不调用真实模型。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

let root: string, state: TavernState, now: number
const info = (window: number): LlmResolvedModelInfo => ({ provider: 'factory', id: 'model', name: '工厂模型', inputModalities: ['text'], context: { contextWindow: window } })
const runtime = (resolveModelInfo: () => Promise<LlmResolvedModelInfo>) => ({ resolveModelInfo }) as unknown as LlmRuntime
const read = (llm: LlmRuntime) => state.resolveModelInfoCached(llm, 'factory', 'model')
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-model-cache-clock-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'), presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('正常时钟在五分钟内复用，达到过期边界后读取新上下文窗口', async () => {
  const old = info(64_000), fresh = info(32_000)
  const resolve = vi.fn(async () => fresh).mockResolvedValueOnce(old), llm = runtime(resolve)
  expect(await read(llm)).toBe(old)
  now += 299_999
  expect(await read(llm)).toBe(old)
  now++
  expect(await read(llm)).toBe(fresh)
  expect(resolve).toHaveBeenCalledTimes(2)
})

it.each([1, 86_400_000])('时钟回拨 %s ms 后主动重读模型能力，不把负年龄当成未过期', async rollback => {
  const old = info(64_000), fresh = info(32_000)
  const resolve = vi.fn(async () => fresh).mockResolvedValueOnce(old), llm = runtime(resolve)
  expect(await read(llm)).toBe(old)
  now -= rollback
  expect(await read(llm)).toBe(fresh)
  expect(await read(llm)).toBe(fresh)
  expect(resolve).toHaveBeenCalledTimes(2)
})

it.each(['fulfilled', 'rejected'] as const)('回拨后的新解析与旧悬挂请求隔离，旧请求 %s 不覆盖或删除新能力', async settlement => {
  const old = info(64_000), fresh = info(32_000), pending = Promise.withResolvers<LlmResolvedModelInfo>()
  const resolve = vi.fn(async () => fresh).mockImplementationOnce(() => pending.promise), llm = runtime(resolve)
  const original = read(llm).catch((error: unknown) => error), failure = new Error('工厂旧解析迟到失败')
  try {
    now -= 1000
    const next = read(llm)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(await next).toBe(fresh)
    if (settlement === 'fulfilled') pending.resolve(old)
    else pending.reject(failure)
    expect(await original).toBe(settlement === 'fulfilled' ? old : failure)
    expect(await read(llm)).toBe(fresh)
    expect(resolve).toHaveBeenCalledTimes(2)
  } finally {
    pending.reject(failure)
    await original
  }
})

it('回拨后的刷新失败明确返回失败，下一次可重试，不退回未来时间戳的旧能力', async () => {
  const old = info(64_000), fresh = info(32_000), failure = new Error('工厂当前解析失败')
  const resolve = vi.fn(async () => fresh).mockResolvedValueOnce(old).mockRejectedValueOnce(failure), llm = runtime(resolve)
  expect(await read(llm)).toBe(old)
  now -= 1000
  await expect(read(llm)).rejects.toBe(failure)
  expect(await read(llm)).toBe(fresh)
  expect(resolve).toHaveBeenCalledTimes(3)
})
