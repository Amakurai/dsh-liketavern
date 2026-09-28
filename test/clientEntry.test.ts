/**
 * 客户端入口的 assistant-step 接管：宿主 0.1.7 的会话列表没有 current，
 * 旧判定恒为假，导致 Tavern 消息始终走原生排版、HTML 卡面显示成代码块。
 * 这里用真实 apply 与会话视图登记表验证：Tavern 视图显示时注册覆盖位，
 * 只剩非 Tavern 视图或全部卸载时撤销，让原生 AssistantNodeView 接手。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'
import { markSessionView } from '../src/client/sessionViews.js'
import type { ClientContext } from '../src/client/types.js'

// 入口只注册组件、不渲染；宿主 primitives 依赖浏览器包，按其它客户端测试的做法替换为空组件。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => new Proxy({}, {
  get: (_target, key) => key === 'then' ? undefined : () => null,
  has: () => true,
}))

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function context() {
  const registered = new Map<string, number>()
  const effects: Array<() => void> = []
  const register = vi.fn((options: { name: string; key?: string; id?: string }) => {
    const cell = `${options.name}:${options.key ?? options.id ?? ''}`
    registered.set(cell, (registered.get(cell) ?? 0) + 1)
    return () => { registered.set(cell, (registered.get(cell) ?? 1) - 1) }
  })
  const remote = { getSettings: async () => ({ ok: false as const, error: { code: 'fixture', message: 'offline' } }) }
  const ctx = {
    remote: { $mount: async () => undefined },
    get: (name: string) => name === 'remote.tavern' ? remote : undefined,
    slots: { register },
    locale: { register: () => () => {}, subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }) },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    workspaces: {},
    effect: (fn: () => void | (() => void)) => { const dispose = fn(); if (dispose) effects.push(dispose) },
  } as unknown as ClientContext
  cleanups.push(() => { for (const dispose of effects.splice(0).reverse()) dispose() })
  return { ctx, occupied: () => (registered.get('conversation.chat.node:assistant-step') ?? 0) > 0 }
}

it('Tavern 会话显示期间接管 assistant-step，切到普通会话后交还原生排版', async () => {
  const { ctx, occupied } = context()
  await apply(ctx)
  expect(occupied()).toBe(false)

  const tavern = markSessionView('tavern-session', true)
  cleanups.push(tavern)
  await Promise.resolve()
  expect(occupied()).toBe(true)

  tavern()
  const coding = markSessionView('coding-session', false)
  cleanups.push(coding)
  await Promise.resolve()
  expect(occupied()).toBe(false)
})
