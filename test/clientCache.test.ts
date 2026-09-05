/**
 * client/cache.ts 进程内元数据缓存（评审问题 8）：
 * - TTL 内命中不重拉 remote，过期后重拉；
 * - in-flight Promise 去重：同 key 并发只发一次 RPC，调用方共享同一结果/拒绝；
 * - 错误信封与 reject 都不缓存，下次调用立即重试；
 * - invalidate* 强制下次重拉（invalidateCharacter 同时清详情与头像）；
 * - 失效期间旧请求晚到时不得覆盖新缓存。
 * 注意：缓存是模块级状态，各用例使用互不相同的 key，避免跨用例串扰。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cachedAvatar,
  cachedCharacterDetail,
  cachedSessionBinding,
  invalidateCharacter,
  invalidateSessionBinding,
} from '../src/client/cache.js'
import type { SessionBinding } from '../src/core/binding.js'
import type { TavernRemote } from '../src/client/types.js'

/** 手写全字段绑定工厂（枚举/默认值不抄字面量处从 core 类型推导）。 */
function makeBinding(sessionId: string, cardId: string): SessionBinding {
  return {
    sessionId,
    cardId,
    cardName: '测试角色',
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
}

/** 手写假 remote：只实现缓存涉及的三个方法，调用次数可断言；返回形状经 cast 对齐契约。 */
function makeRemote() {
  const calls = { binding: 0, detail: 0, avatar: 0 }
  const remote = {
    getSessionBinding: async (req: { sessionId: string }) => {
      calls.binding += 1
      return { ok: true as const, value: { binding: makeBinding(req.sessionId, 'card-1'), userName: '用户', canSwipeGreeting: true } }
    },
    getCharacterDetail: async (req: { cardId: string }) => {
      calls.detail += 1
      return { ok: true as const, value: { cardId: req.cardId, name: '测试角色' } }
    },
    getAvatar: async () => {
      calls.avatar += 1
      return { ok: true as const, value: { dataUrl: 'data:image/png;base64,AA==' } }
    },
  } as unknown as TavernRemote
  return { remote, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('client 元数据缓存', () => {
  it('TTL 内命中缓存不重拉；过期后重拉', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const t0 = 1_700_000_000_000
    nowSpy.mockReturnValue(t0)
    const { remote, calls } = makeRemote()
    await cachedSessionBinding(remote, 's-ttl')
    await cachedSessionBinding(remote, 's-ttl')
    await cachedCharacterDetail(remote, 'c-ttl')
    await cachedCharacterDetail(remote, 'c-ttl')
    expect(calls).toEqual({ binding: 1, detail: 1, avatar: 0 })
    // 绑定/详情 TTL 30s：+29s 仍命中，+31s 重拉
    nowSpy.mockReturnValue(t0 + 29_000)
    await cachedSessionBinding(remote, 's-ttl')
    expect(calls.binding).toBe(1)
    nowSpy.mockReturnValue(t0 + 31_000)
    await cachedSessionBinding(remote, 's-ttl')
    await cachedCharacterDetail(remote, 'c-ttl')
    expect(calls).toEqual({ binding: 2, detail: 2, avatar: 0 })
  })

  it('头像 TTL 60s：30s 处仍命中，61s 处重拉', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const t0 = 1_700_000_000_000
    nowSpy.mockReturnValue(t0)
    const { remote, calls } = makeRemote()
    await cachedAvatar(remote, 'c-avatar-ttl')
    nowSpy.mockReturnValue(t0 + 31_000)
    await cachedAvatar(remote, 'c-avatar-ttl')
    expect(calls.avatar).toBe(1)
    nowSpy.mockReturnValue(t0 + 61_000)
    await cachedAvatar(remote, 'c-avatar-ttl')
    expect(calls.avatar).toBe(2)
  })

  it('同 key 并发共享一次 in-flight RPC', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fn = vi.fn(async () => {
      await gate
      return { ok: true as const, value: { dataUrl: null } }
    })
    const remote = { getAvatar: fn } as unknown as TavernRemote
    const p1 = cachedAvatar(remote, 'c-inflight')
    const p2 = cachedAvatar(remote, 'c-inflight')
    expect(fn).toHaveBeenCalledTimes(1)
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok && r2.ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    // in-flight 落定后值已缓存，后续命中不再打 remote
    await cachedAvatar(remote, 'c-inflight')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('错误信封不缓存，下次调用立即重试', async () => {
    let fail = true
    const fn = vi.fn(async () =>
      fail
        ? { ok: false as const, error: { code: 'test', message: 'boom' } }
        : { ok: true as const, value: { binding: null, userName: '用户', canSwipeGreeting: false } },
    )
    const remote = { getSessionBinding: fn } as unknown as TavernRemote
    const first = await cachedSessionBinding(remote, 's-err')
    expect(first.ok).toBe(false)
    fail = false
    const second = await cachedSessionBinding(remote, 's-err')
    expect(second.ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('reject 不缓存：并发共享同一拒绝，恢复后重试成功', async () => {
    let fail = true
    const fn = vi.fn(async () => {
      if (fail) throw new Error('net down')
      return { ok: true as const, value: { dataUrl: 'data:image/png;base64,BB==' } }
    })
    const remote = { getAvatar: fn } as unknown as TavernRemote
    const p1 = cachedAvatar(remote, 'c-reject')
    const p2 = cachedAvatar(remote, 'c-reject')
    const [e1, e2] = await Promise.all([
      p1.then(() => null, (e: unknown) => e),
      p2.then(() => null, (e: unknown) => e),
    ])
    expect(e1).toBeInstanceOf(Error)
    expect(e2).toBeInstanceOf(Error)
    expect(fn).toHaveBeenCalledTimes(1)
    fail = false
    const r = await cachedAvatar(remote, 'c-reject')
    expect(r.ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('invalidateSessionBinding 强制下次重拉', async () => {
    const { remote, calls } = makeRemote()
    await cachedSessionBinding(remote, 's-inv')
    expect(calls.binding).toBe(1)
    invalidateSessionBinding('s-inv')
    await cachedSessionBinding(remote, 's-inv')
    expect(calls.binding).toBe(2)
  })

  it('invalidateCharacter 同时失效详情与头像', async () => {
    const { remote, calls } = makeRemote()
    await cachedCharacterDetail(remote, 'c-inv')
    await cachedAvatar(remote, 'c-inv')
    expect(calls).toEqual({ binding: 0, detail: 1, avatar: 1 })
    invalidateCharacter('c-inv')
    await cachedCharacterDetail(remote, 'c-inv')
    await cachedAvatar(remote, 'c-inv')
    expect(calls).toEqual({ binding: 0, detail: 2, avatar: 2 })
  })

  it('失效期间旧请求晚到时不得覆盖新缓存', async () => {
    const pending: Array<(value: unknown) => void> = []
    const remote = {
      getSessionBinding: () => new Promise((resolve) => pending.push(resolve)),
    } as unknown as TavernRemote
    const old = cachedSessionBinding(remote, 's-race')
    invalidateSessionBinding('s-race')
    const fresh = cachedSessionBinding(remote, 's-race')
    expect(pending).toHaveLength(2)

    pending[1]!({ ok: true, value: { binding: null, userName: '新值', canSwipeGreeting: false } })
    await fresh
    pending[0]!({ ok: true, value: { binding: null, userName: '旧值', canSwipeGreeting: false } })
    await old

    const cached = await cachedSessionBinding(remote, 's-race')
    expect(cached.ok && cached.value.userName).toBe('新值')
  })
})
