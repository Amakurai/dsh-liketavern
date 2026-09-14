/**
 * 打开 fork 子会话：先 refresh 列表再 open，失败则再 refresh 一次。
 */
import { describe, expect, it, vi } from 'vitest'
import { openChildSession } from '../src/client/openChild.js'

describe('openChildSession', () => {
  it('refresh 成功后打开子会话', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => undefined)
    await openChildSession({ open, refresh, list: { getSnapshot: () => ({ current: 'source' }) } }, 'session-child', undefined, 'source')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('session-child')
  })

  it('第一次 open 抛错时再 refresh 一次后重试', async () => {
    const open = vi.fn()
    open.mockImplementationOnce(() => {
      throw new Error('sessions.select: unknown session session-child')
    })
    const refresh = vi.fn(async () => undefined)
    await openChildSession({ open, refresh }, 'session-child')
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it.each(['before', 'refresh', 'refresh-reject', 'retry'] as const)('离开来源会话后不执行迟到的导航：%s', async stage => {
    let current = stage === 'before' ? 'other' : 'source'
    const pending = Promise.withResolvers<void>()
    const open = vi.fn()
    if (stage === 'retry') open.mockImplementationOnce(() => { throw new Error('unknown session') })
    const refresh = vi.fn(() => pending.promise)
    if (stage === 'retry') refresh.mockImplementationOnce(async () => {})
    const scope = vi.fn(() => ({})), rename = vi.fn(async () => {})
    const opening = openChildSession({ open, refresh, list: { getSnapshot: () => ({ current }) }, scope, sessionOf: () => ({ rename }) }, 'session-child', 'Created branch', 'source')
    // 首次打开失败后的第二次 refresh 同样是导航竞态窗口。
    await Promise.resolve()
    current = 'other'
    if (stage === 'refresh-reject') pending.reject(new Error('offline'))
    else pending.resolve()
    await opening
    expect(open).toHaveBeenCalledTimes(stage === 'retry' ? 1 : 0)
    expect(refresh).toHaveBeenCalledTimes(stage === 'retry' ? 2 : 1)
    expect(scope).toHaveBeenCalledWith('session-child')
    expect(rename).toHaveBeenCalledWith('Created branch')
  })
})
