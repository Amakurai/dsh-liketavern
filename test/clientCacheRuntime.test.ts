/** 客户端宿主隔离：同名角色和会话在不同 remote 中不得共用缓存或飞行请求，旧回包不污染新宿主。 */
import { expect, it, vi } from 'vitest'
import { cachedAvatar, cachedCharacterDetail, cachedSessionBinding, invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import type { TavernRemote } from '../src/client/types.js'

function host(name: string) {
  return {
    getAvatar: vi.fn(async () => ({ ok: true as const, value: { dataUrl: name } })),
    getCharacterDetail: vi.fn(async () => ({ ok: true as const, value: { cardId: 'same-card', name } })),
    getSessionBinding: vi.fn(async () => ({ ok: true as const, value: { binding: null, userName: name, canSwipeGreeting: false } })),
  } as unknown as TavernRemote
}

it('两个宿主的同名角色、头像和会话分别读取各自的值', async () => {
  const a = host('宿主甲'), b = host('宿主乙')
  for (const remote of [a, b]) {
    const name = remote === a ? '宿主甲' : '宿主乙'
    expect(await cachedAvatar(remote, 'same-card')).toEqual({ ok: true, value: { dataUrl: name } })
    expect(await cachedCharacterDetail(remote, 'same-card')).toEqual({ ok: true, value: { cardId: 'same-card', name } })
    expect(await cachedSessionBinding(remote, 'same-session')).toMatchObject({ ok: true, value: { userName: name } })
  }
  await cachedAvatar(a, 'same-card')
  expect(a.getAvatar).toHaveBeenCalledOnce()
  expect(b.getAvatar).toHaveBeenCalledOnce()
})

it('宿主切换不复用旧飞行请求，迟到结果仍只回填原宿主', async () => {
  const delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getAvatar']>>>()
  const a = { getAvatar: vi.fn(() => delayed.promise) } as unknown as TavernRemote
  const b = host('新宿主')
  const old = cachedAvatar(a, 'pending-same-card')
  const fresh = cachedAvatar(b, 'pending-same-card')
  // 先检查是否混用了请求，避免失败用例等待永不结束的旧请求。
  expect(b.getAvatar).toHaveBeenCalledOnce()
  expect(fresh).not.toBe(old)
  expect(await fresh).toEqual({ ok: true, value: { dataUrl: '新宿主' } })
  delayed.resolve({ ok: true, value: { dataUrl: '旧宿主' } })
  await old
  expect(await cachedAvatar(b, 'pending-same-card')).toEqual({ ok: true, value: { dataUrl: '新宿主' } })
})

it('显式失效可刷新所有仍被使用的宿主缓存', async () => {
  const a = host('甲'), b = host('乙')
  for (const remote of [a, b]) {
    await cachedAvatar(remote, 'invalidate-card')
    await cachedCharacterDetail(remote, 'invalidate-card')
    await cachedSessionBinding(remote, 'invalidate-session')
  }
  invalidateCharacter('invalidate-card')
  invalidateSessionBinding('invalidate-session')
  for (const remote of [a, b]) {
    await cachedAvatar(remote, 'invalidate-card')
    await cachedCharacterDetail(remote, 'invalidate-card')
    await cachedSessionBinding(remote, 'invalidate-session')
    expect(remote.getAvatar).toHaveBeenCalledTimes(2)
    expect(remote.getCharacterDetail).toHaveBeenCalledTimes(2)
    expect(remote.getSessionBinding).toHaveBeenCalledTimes(2)
  }
})
