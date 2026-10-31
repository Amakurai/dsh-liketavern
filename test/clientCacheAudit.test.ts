/** 元数据缓存故障恢复审查：断线时未返回的旧 RPC 不能阻止用户重试。 */
import { afterEach, expect, it, vi } from 'vitest'
import { cachedAvatar, cachedCharacterDetail, cachedSessionBinding, invalidateCharacter } from '../src/client/cache.js'
import type { TavernRemote } from '../src/client/types.js'

afterEach(() => vi.restoreAllMocks())

it('系统时钟回拨后重新读取绑定、角色详情和头像，不把负年龄当作长期有效', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  let label = '旧结果'
  const remote = {
    getSessionBinding: vi.fn(async () => ({ ok: true, value: { binding: null, userName: label, canSwipeGreeting: false } })),
    getCharacterDetail: vi.fn(async () => ({ ok: true, value: { cardId: 'clock-card', name: label } })),
    getAvatar: vi.fn(async () => ({ ok: true, value: { dataUrl: label } })),
  } as unknown as TavernRemote
  await cachedSessionBinding(remote, 'clock-session'); await cachedCharacterDetail(remote, 'clock-card'); await cachedAvatar(remote, 'clock-card')
  label = '时钟校正后的结果'
  now.mockReturnValue(1_699_999_000_000)
  expect(await cachedSessionBinding(remote, 'clock-session')).toMatchObject({ ok: true, value: { userName: label } })
  expect(await cachedCharacterDetail(remote, 'clock-card')).toMatchObject({ ok: true, value: { name: label } })
  expect(await cachedAvatar(remote, 'clock-card')).toEqual({ ok: true, value: { dataUrl: label } })
  await cachedSessionBinding(remote, 'clock-session'); await cachedCharacterDetail(remote, 'clock-card'); await cachedAvatar(remote, 'clock-card')
  for (const method of [remote.getSessionBinding, remote.getCharacterDetail, remote.getAvatar]) expect(method).toHaveBeenCalledTimes(2)
})

it('时钟回拨不会让悬挂请求永久占住重试入口，迟到结果不能覆盖重试内容', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getAvatar']>>>()
  const getAvatar = vi.fn().mockImplementationOnce(() => delayed.promise).mockResolvedValue({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  const remote = { getAvatar } as unknown as TavernRemote
  const old = cachedAvatar(remote, 'clock-pending-card')
  try {
    now.mockReturnValue(1_699_999_000_000)
    const retry = cachedAvatar(remote, 'clock-pending-card')
    expect(retry).not.toBe(old)
    expect(await retry).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
    delayed.resolve({ ok: true, value: { dataUrl: 'stale-avatar' } })
    await old
    expect(await cachedAvatar(remote, 'clock-pending-card')).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  } finally { delayed.resolve({ ok: true, value: { dataUrl: 'stale-avatar' } }); await old }
})

it('读取超时后允许重试，并且旧回包不能覆盖重试结果', async () => {
  const now = vi.spyOn(Date, 'now')
  now.mockReturnValue(1_700_000_000_000)
  const key = 'audit-pending-avatar'
  let resolveOld!: (value: Awaited<ReturnType<TavernRemote['getAvatar']>>) => void
  const getAvatar = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    .mockResolvedValue({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  const remote = { getAvatar } as unknown as TavernRemote
  const old = cachedAvatar(remote, key)
  now.mockReturnValue(1_700_000_019_999)
  expect(cachedAvatar(remote, key)).toBe(old)
  expect(getAvatar).toHaveBeenCalledOnce()
  now.mockReturnValue(1_700_000_020_000)
  const retry = cachedAvatar(remote, key)
  try {
    expect(getAvatar).toHaveBeenCalledTimes(2)
    expect(await retry).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
    resolveOld({ ok: true, value: { dataUrl: 'stale-avatar' } })
    await old
    expect(await cachedAvatar(remote, key)).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  } finally {
    resolveOld({ ok: true, value: { dataUrl: 'stale-avatar' } })
    await old
    invalidateCharacter(key)
  }
})

it('连续浏览大量角色后释放早期头像，仍复用持续访问的头像', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const getAvatar = vi.fn(async ({ cardId }: { cardId: string }) => ({ ok: true as const, value: { dataUrl: cardId } }))
  const remote = { getAvatar } as unknown as TavernRemote
  await cachedAvatar(remote, 'old-card')
  await cachedAvatar(remote, 'active-card')
  for (let index = 0; index < 2_000; index++) {
    await cachedAvatar(remote, `browsed-${index}`)
    if (index % 16 === 0) await cachedAvatar(remote, 'active-card')
  }
  const before = getAvatar.mock.calls.length
  await cachedAvatar(remote, 'active-card')
  await cachedAvatar(remote, 'browsed-1999')
  expect(getAvatar).toHaveBeenCalledTimes(before)
  await cachedAvatar(remote, 'old-card')
  expect(getAvatar).toHaveBeenCalledTimes(before + 1)
})

it('悬挂请求也受容量限制；淘汰后重新读取，迟到回包不覆盖新头像', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getAvatar']>>>()
  const getAvatar = vi.fn().mockImplementationOnce(() => delayed.promise)
    .mockResolvedValue({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  const remote = { getAvatar } as unknown as TavernRemote
  const old = cachedAvatar(remote, 'stalled-card')
  try {
    for (let index = 0; index < 2_000; index++) await cachedAvatar(remote, `new-card-${index}`)
    const retry = cachedAvatar(remote, 'stalled-card')
    expect(retry).not.toBe(old)
    expect(await retry).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
    delayed.resolve({ ok: true, value: { dataUrl: 'stale-avatar' } })
    await old
    expect(await cachedAvatar(remote, 'stalled-card')).toEqual({ ok: true, value: { dataUrl: 'fresh-avatar' } })
  } finally {
    delayed.resolve({ ok: true, value: { dataUrl: 'stale-avatar' } })
    await old
  }
})
