/**
 * 打开 fork 子会话：先 refresh 列表再 open，失败则再 refresh 一次。
 */
import { describe, expect, it, vi } from 'vitest'
import { openChildSession } from '../src/client/openChild.js'

describe('openChildSession', () => {
  it('refresh 成功后打开子会话', async () => {
    const open = vi.fn()
    const refresh = vi.fn(async () => undefined)
    await openChildSession({ open, refresh }, 'session-child')
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
})
