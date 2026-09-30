/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。因此优先最近一次请求头，缺失时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js'

export interface SessionModelRoute {
  provider?: string
  model?: string
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== ''

export function sessionModelRoute(agent: Pick<Agent, 'options' | 'session'>): SessionModelRoute {
  // 请求头与 options 各自成对取用，不能拼出「新 provider + 旧 model」这类不存在的组合。
  const logged = agent.session?.requestHeader?.()?.config
  const fromLog = present(logged?.provider) && present(logged?.model)
  const provider = fromLog ? logged!.provider : agent.options.provider
  const model = fromLog ? logged!.model : agent.options.model
  return {
    ...(present(provider) ? { provider: provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : provider } : {}),
    ...(present(model) ? { model } : {}),
  }
}
