/** 宿主分支请求的身份捕获：普通会话、服务生命周期和冲突来源均不得串改。 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { captureHostForkRequests, installHostForkCapture } from '../src/node/hostForkCapture.js'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('只记录匹配当前请求的 Tavern 子会话来源，保持普通创建和原始参数不变', async () => {
  const seen: Array<Record<string, unknown>> = []
  const agents = { async create(options: unknown) { seen.push(options as Record<string, unknown>); return options } }
  const input = { sessionId: 'session-child', seed: [1, 2, 3, 4], inheritedEventCount: 4, meta: { isSeeded: true, agentPreset: 'tavern' } }
  const controller = { async fork(_request: unknown) {
    await agents.create({ seed: [1], inheritedEventCount: 1, meta: { isSeeded: true, agentPreset: 'default' } })
    return agents.create(input)
  } }
  const originalCreate = agents.create, originalFork = controller.fork
  const saved: unknown[] = []
  const dispose = captureHostForkRequests(controller, agents, () => false, async (...args) => { saved.push(args) })
  try {
    await controller.fork({ sessionId: 'session-source', atSeq: 3 })
    expect(seen[0]?.meta).toEqual({ isSeeded: true, agentPreset: 'default' })
    expect(seen[1]?.meta).toEqual({ isSeeded: true, agentPreset: 'tavern' })
    expect(saved).toEqual([['session-child', 'session-source', [1, 2, 3, 4]]])
    expect(input.meta).toEqual({ isSeeded: true, agentPreset: 'tavern' })
  } finally { dispose() }
  expect(agents.create).toBe(originalCreate)
  expect(controller.fork).toBe(originalFork)
})

it('请求来源和现有子会话来源冲突时拒绝创建', async () => {
  const agents = { create: vi.fn(async (_options: unknown) => undefined) }
  const create = agents.create
  const controller = { async fork(_request: unknown) {
    return agents.create({ sessionId: 'session-child-conflict', seed: [1], inheritedEventCount: 1,
      meta: { isSeeded: true, agentPreset: 'tavern', parentSession: 'session-other' } })
  } }
  const dispose = captureHostForkRequests(controller, agents, () => false, async () => {})
  try {
    await expect(controller.fork({ sessionId: 'session-source' })).rejects.toThrow('来源身份不一致')
    expect(create).not.toHaveBeenCalled()
  } finally { dispose() }
})

it('旧宿主已提供正确父身份时保留原参数与创建时序', async () => {
  const input = { sessionId: 'session-legacy-child', seed: [1], inheritedEventCount: 1,
    meta: { isSeeded: true, agentPreset: 'tavern', parentSession: 'session-source' } }
  const create = vi.fn(async (options: unknown) => options), agents = { create }
  const controller = { async fork(_request: unknown) { return agents.create(input) } }
  const save = vi.fn(async () => {})
  const dispose = captureHostForkRequests(controller, agents, () => false, save)
  try {
    expect(await controller.fork({ sessionId: 'session-source' })).toBe(input)
    expect(create).toHaveBeenCalledWith(input)
    expect(save).not.toHaveBeenCalled()
  } finally { dispose() }
})

it('宿主分支服务晚于插件出现时仍安装追踪，卸载时恢复原方法', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const root = await mkdtemp(join(tmpdir(), 'tavern-fork-capture-')); roots.push(root)
  const agents = { async create(options: unknown) { return options } }
  const controller = { async fork(_request: unknown) {
    return agents.create({ sessionId: 'session-late-child', seed: [1], inheritedEventCount: 1, meta: { isSeeded: true, agentPreset: 'tavern' } })
  } }
  const originalFork = controller.fork, originalCreate = agents.create
  Reflect.apply(ctx.provide, ctx, ['agents', agents])
  installHostForkCapture(ctx, { root } as Parameters<typeof installHostForkCapture>[1])
  Reflect.apply(ctx.provide, ctx, ['sessionController', controller])
  await vi.waitFor(() => expect(controller.fork).not.toBe(originalFork))
  const result = await controller.fork({ sessionId: 'session-late' }) as { meta: { parentSession?: string } }
  expect(result.meta.parentSession).toBeUndefined()
  const files = await readdir(join(root, 'state', 'host-fork-identities'))
  expect(files).toHaveLength(1)
  expect(JSON.parse(await readFile(join(root, 'state', 'host-fork-identities', files[0]!), 'utf8'))).toMatchObject({
    sessionId: 'session-late-child', parentId: 'session-late', inheritedCount: 1,
  })
  await ctx.fiber.dispose(); contexts.pop()
  expect(controller.fork).toBe(originalFork)
  expect(agents.create).toBe(originalCreate)
})

it('来源记录写入失败时不创建宿主子会话', async () => {
  const create = vi.fn(async (_options: unknown) => undefined), agents = { create }
  const controller = { async fork(_request: unknown) {
    return agents.create({ sessionId: 'session-unwritten', seed: [1], inheritedEventCount: 1,
      meta: { isSeeded: true, agentPreset: 'tavern' } })
  } }
  const dispose = captureHostForkRequests(controller, agents, () => false, async () => { throw new Error('identity write failed') })
  try {
    await expect(controller.fork({ sessionId: 'session-source' })).rejects.toThrow('identity write failed')
    expect(create).not.toHaveBeenCalled()
  } finally { dispose() }
})
