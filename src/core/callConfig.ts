/**
 * 把 Tavern 采样合入 dsh LlmCallConfig。
 * reasoningEffort 是适配器私有 id：只发送模型公布的档位，避免 UNSUPPORTED_REASONING_EFFORT。
 */
import type { SamplingSettings } from './types.js'

const OFF_IDS = new Set(['off', 'none', 'disabled'])

function isOffEffort(id: string | undefined): boolean {
  return id !== undefined && OFF_IDS.has(id.toLowerCase())
}

export interface AdvertisedReasoning {
  id: string
}

/**
 * 按 Tavern「深度思考」开关挑选 reasoningEffort。
 * 关 → 公布的 off 档（没有则 undefined，调用方不得瞎填）；
 * 开 → 保留会话已选的非 off 档，否则模型默认，否则第一个非 off 档。
 */
export function pickReasoningEffort(
  thinking: SamplingSettings['thinking'],
  efforts: readonly AdvertisedReasoning[] | undefined,
  defaultEffort: string | undefined,
  current: string | undefined,
): string | undefined {
  const ids = efforts?.map((e) => e.id) ?? []
  const advertised = (id: string) => ids.length === 0 || ids.includes(id)

  if (thinking === 'disabled') {
    return ids.find((id) => isOffEffort(id))
  }

  if (current && !isOffEffort(current) && advertised(current)) return current
  if (defaultEffort && !isOffEffort(defaultEffort) && advertised(defaultEffort)) return defaultEffort
  return ids.find((id) => !isOffEffort(id))
}

export interface CallConfigPatch {
  temperature?: number
  maxTokens?: number
  stop?: string[]
  reasoningEffort?: string
}

/** 透传 temperature / maxTokens / stop，并在有合法档位时写入 reasoningEffort。 */
export function mergeTavernCallConfig<T extends CallConfigPatch>(
  config: T,
  sampling: SamplingSettings,
  reasoningEffort: string | undefined,
): T {
  return {
    ...config,
    temperature: sampling.temperature,
    ...(sampling.maxTokens !== null ? { maxTokens: sampling.maxTokens } : {}),
    ...(sampling.stop.length > 0 ? { stop: [...sampling.stop] } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}
