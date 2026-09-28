/**
 * 插件内部使用的会话端口：把宿主 ISessions 与导航动作合成一个稳定对象交给各 slot。
 *
 * 宿主 0.1.7 起 ISessions 不再有 `open`；显示会话改由 uiWorkspace.openSession 完成
 * （与侧边栏点选同一动作）。旧宿主仍回退 `sessions.open`，两者都缺时明确报错，
 * 不能让分支/开场白切换在调用方静默失败。宿主方法依赖 this，统一按方法调用形态转发。
 */
import type { ClientContext } from './types.js'

export interface TavernSessions {
  open(id: string): void
  refresh?: () => Promise<void>
  binding?: ClientContext['sessions']['binding']
  list: ClientContext['sessions']['list']
  scope?(id: string): unknown
  sessionOf?(ctx: unknown): { rename(title: string): Promise<unknown> } | undefined
}

export function openSessionView(ctx: Pick<ClientContext, 'get' | 'sessions'>, id: string): void {
  const ui = ctx.get('uiWorkspace') as { openSession?(target: string): void } | undefined
  if (ui && typeof ui.openSession === 'function') {
    ui.openSession(id)
    return
  }
  const legacy = ctx.sessions as { open?(id: string): void }
  if (typeof legacy.open === 'function') {
    legacy.open(id)
    return
  }
  throw new Error('宿主没有可用的会话导航接口')
}

export function createSessionsPort(ctx: Pick<ClientContext, 'get' | 'sessions'>): TavernSessions {
  const host = ctx.sessions
  return {
    open: (id) => openSessionView(ctx, id),
    ...(typeof host.refresh === 'function' ? { refresh: () => host.refresh!() } : {}),
    ...(typeof host.binding === 'function' ? { binding: ((id: string) => host.binding!(id)) as NonNullable<ClientContext['sessions']['binding']> } : {}),
    list: host.list,
    ...(typeof host.scope === 'function' ? { scope: (id: string) => host.scope!(id) } : {}),
    ...(typeof host.sessionOf === 'function' ? { sessionOf: (scope: unknown) => host.sessionOf!(scope) } : {}),
  }
}
