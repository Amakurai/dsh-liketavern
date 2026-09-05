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
