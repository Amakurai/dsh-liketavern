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

it('未到条数上限的大头像也受总量约束，持续读取的头像优先保留', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024)
  const getAvatar = vi.fn(async () => ({ ok: true as const, value: { dataUrl } }))
  const remote = { getAvatar } as unknown as TavernRemote
  await cachedAvatar(remote, 'large-old')
  await cachedAvatar(remote, 'large-active')
  for (let index = 0; index < 10; index++) {
    await cachedAvatar(remote, `large-${index}`)
    await cachedAvatar(remote, 'large-active')
  }
  const before = getAvatar.mock.calls.length
  await cachedAvatar(remote, 'large-active'); await cachedAvatar(remote, 'large-9')
  expect(getAvatar).toHaveBeenCalledTimes(before)
  await cachedAvatar(remote, 'large-old')
  expect(getAvatar).toHaveBeenCalledTimes(before + 1)
})

it('单张超出缓存预算的头像仍正常返回，但不挤掉已缓存的正常头像', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(32 * 1024 * 1024)
  const getAvatar = vi.fn(async ({ cardId }: { cardId: string }) => ({ ok: true as const, value: { dataUrl: cardId === 'huge' ? huge : 'normal-avatar' } }))
  const remote = { getAvatar } as unknown as TavernRemote
  await cachedAvatar(remote, 'normal')
  for (let index = 0; index < 2; index++) {
    const pending = cachedAvatar(remote, 'huge')
    expect(cachedAvatar(remote, 'huge')).toBe(pending)
    const result = await pending
    expect(result.ok && result.value.dataUrl?.length).toBe(huge.length)
    await cachedAvatar(remote, 'normal')
  }
  expect(getAvatar).toHaveBeenCalledTimes(3)
})

it('按体积淘汰已返回头像时，不取消另一张头像正在共享的读取', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  const delayed = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getAvatar']>>>()
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024)
  const getAvatar = vi.fn(async ({ cardId }: { cardId: string }) => cardId === 'still-loading' ? delayed.promise : { ok: true as const, value: { dataUrl } })
  const remote = { getAvatar } as unknown as TavernRemote
  const loading = cachedAvatar(remote, 'still-loading')
  try {
    for (let index = 0; index < 10; index++) await cachedAvatar(remote, `pressure-${index}`)
    expect(cachedAvatar(remote, 'still-loading')).toBe(loading)
    expect(getAvatar.mock.calls.filter(([request]) => request.cardId === 'still-loading')).toHaveLength(1)
  } finally { delayed.resolve({ ok: true, value: { dataUrl: 'loaded-avatar' } }); await loading }
  expect(await cachedAvatar(remote, 'still-loading')).toEqual({ ok: true, value: { dataUrl: 'loaded-avatar' } })
})
