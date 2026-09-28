/**
 * 会话导航端口：宿主 0.1.7 的 ISessions 没有 open，必须经 uiWorkspace.openSession 显示会话；
 * 旧宿主回退 sessions.open，两者都缺时明确报错。端口转发保持宿主方法的 this。
 */
import { describe, expect, it, vi } from 'vitest'
import { createSessionsPort, openSessionView } from '../src/client/navigation.js'
import type { ClientContext } from '../src/client/types.js'

const list = { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} }

describe('openSessionView', () => {
  it('优先使用 uiWorkspace.openSession，并以方法形态调用', () => {
    const ui = { calls: [] as string[], openSession(id: string) { this.calls.push(id) } }
    const legacy = vi.fn()
    openSessionView({ get: name => name === 'uiWorkspace' ? ui : undefined, sessions: { open: legacy, list } }, 'child')
    expect(ui.calls).toEqual(['child'])
    expect(legacy).not.toHaveBeenCalled()
  })

  it('旧宿主没有 uiWorkspace 时回退 sessions.open', () => {
    const open = vi.fn()
    openSessionView({ get: () => undefined, sessions: { open, list } }, 'child')
    expect(open).toHaveBeenCalledWith('child')
  })

  it('两条导航路径都缺失时明确失败，不让分支切换静默无效', () => {
    expect(() => openSessionView({ get: () => undefined, sessions: { list } }, 'child')).toThrow('会话导航')
  })
})

describe('createSessionsPort', () => {
  it('转发 refresh/binding/scope/sessionOf 时保留宿主实例的 this', async () => {
    class HostSessions {
      readonly list = list
      readonly log: string[] = []
      async refresh() { this.log.push('refresh') }
      binding(id: string) { this.log.push(`binding:${id}`); return undefined }
      scope(id: string) { this.log.push(`scope:${id}`); return { id } }
      sessionOf(scope: unknown) { this.log.push('sessionOf'); return scope ? { rename: async () => undefined } : undefined }
    }
    const host = new HostSessions()
    const port = createSessionsPort({ get: () => undefined, sessions: host as unknown as ClientContext['sessions'] })
    await port.refresh?.()
    port.binding?.('a')
    port.sessionOf?.(port.scope?.('a'))
    expect(host.log).toEqual(['refresh', 'binding:a', 'scope:a', 'sessionOf'])
    expect(port.list).toBe(list)
  })
})
