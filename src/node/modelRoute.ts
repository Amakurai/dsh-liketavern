/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。换模时宿主先向日志追加 model/selection，下一次请求才写
 * request/header；只看最近请求头会让换模后第一轮仍用旧模型。因此按宿主 modelSelection 投影同一
 * 口径取值：尚未被请求使用的最新选择优先，其次最近请求头，日志都没有时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js'

export interface SessionModelRoute {
  provider?: string
  model?: string
}

interface RoutePair { provider: string; model: string }

const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** 只接受成对的路由，不能拼出「新 provider + 旧 model」这类不存在的组合。 */
function pairOf(value: unknown): RoutePair | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  return present(provider) && present(model) ? { provider, model } : undefined
}

/** 对齐宿主 applyModelSelectionProjection：请求用过同一路由后，待用选择即消耗。 */
function loggedRoute(session: Partial<Pick<Agent['session'], 'snapshotEvents' | 'requestHeader'>> | undefined): RoutePair | undefined {
  const events = session?.snapshotEvents?.()
  if (!events) return pairOf(session?.requestHeader?.()?.config)
  let lastUsed: RoutePair | undefined
  let pending: RoutePair | undefined
  for (const event of events) {
    const type = String(event.type)
    if (type === 'model/selection') {
      pending = pairOf(event.data) ?? pending
    } else if (type === 'request/header') {
      const used = pairOf((event.data as { header?: { config?: unknown } } | undefined)?.header?.config)
      if (!used) continue
      lastUsed = used
      if (pending && pending.provider === used.provider && pending.model === used.model) pending = undefined
    }
  }
  // 早于快照折叠点的请求头不在事件里，但宿主仍能重建它。
  return pending ?? lastUsed ?? pairOf(session?.requestHeader?.()?.config)
}

export function sessionModelRoute(agent: Pick<Agent, 'options' | 'session'>): SessionModelRoute {
  const route = loggedRoute(agent.session) ?? pairOf(agent.options)
  if (!route) return {}
  return { provider: route.provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : route.provider, model: route.model }
}
