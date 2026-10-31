/** 元数据缓存故障恢复审查：断线时未返回的旧 RPC 不能阻止用户重试。 */
import { afterEach, expect, it, vi } from 'vitest'
import { cachedAvatar, invalidateCharacter } from '../src/client/cache.js'
import type { TavernRemote } from '../src/client/types.js'

afterEach(() => vi.restoreAllMocks())

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
