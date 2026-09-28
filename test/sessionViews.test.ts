/**
 * 会话视图登记表：宿主 0.1.7 移除 list.current 后，由会话作用域组件登记当前显示的会话。
 * 覆盖：计数令牌（同会话多组件）、最近登记的 Tavern 视图为当前、非 Tavern 视图不算、
 * 撤销幂等、通知合并到微任务而不是在组件 effect 中同步触发。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentTavernSession, hasShownSession, isSessionShown, isTavernSessionShown, markSessionView, subscribeSessionViews } from '../src/client/sessionViews.js'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const mark = (id: string, tavern: boolean) => { const undo = markSessionView(id, tavern); cleanups.push(undo); return undo }

describe('sessionViews', () => {
  it('没有登记时没有显示中的会话，也没有当前 Tavern 会话', () => {
    expect(hasShownSession()).toBe(false)
    expect(currentTavernSession()).toBeUndefined()
  })

  it('同一会话由头部与英雄区各登记一次，撤销其一仍在显示', () => {
    const header = mark('a', true)
    mark('a', true)
    header()
    expect(isSessionShown('a')).toBe(true)
    expect(currentTavernSession()).toBe('a')
  })

  it('非 Tavern 会话算作已显示，但不成为当前 Tavern 会话', () => {
    mark('coding', false)
    expect(hasShownSession()).toBe(true)
    expect(isTavernSessionShown('coding')).toBe(false)
    expect(currentTavernSession()).toBeUndefined()
  })

  it('多个 Tavern 视图取最近登记的；它卸载后回到仍在显示的那个', () => {
    mark('a', true)
    const b = mark('b', true)
    expect(currentTavernSession()).toBe('b')
    b()
    b()
    expect(currentTavernSession()).toBe('a')
  })

  it('通知在微任务里合并一次，登记期间不会同步回调', async () => {
    const listener = vi.fn()
    cleanups.push(subscribeSessionViews(listener))
    mark('a', true)
    mark('b', false)
    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
