/**
 * dsh-tavern agent 面插件（由 agent 预设 tavern 挂载，运行于 agent 作用域）。
 * 职责：
 * 1. 注册稳定 system 段 `tavern:standing` 与本轮 runtime context `tavern:turn`。
 *    已绑定：standing = 角色定义 + 预设骨架（冻结时钟，按会话钉死字节）；
 *    turn = 步骤 playbook + 世界书/记忆/变化层。
 *    未绑定：standing 固定短文案（不删段，避免段布局抖动打穿 KV），turn 为空。
 *    standing 段 order=210，排在工具说明（100–199）之后：即使骨架仍有残余抖动，
 *    稳定的工具说明仍能命中 DeepSeek 前缀缓存。绝不把整包 ST 预设改成 complete 段。
 * 2. 在 agent/request waterfall 中合入采样参数（temperature/maxTokens/stop）
 *    与 thinking→reasoningEffort（只写模型公布的档位；模型元数据经
 *    state.resolveModelInfoCached 进程内缓存，每步调用不重复解析）。
 * 3. 注册七个 Tavern 模型工具；agent/status 转入 idle 时 runMaintenance
 *    执行记忆超容量压缩（memoryMaintenance.ts，不记 WAL）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { runTavernPipeline } from './node/pipeline.js'
import { registerMemoryMaintenance } from './node/memoryMaintenance.js'
import type { TavernService } from './node/service.js'
import type { TavernState } from './node/state.js'
import { registerTavernTools } from './node/tools.js'
import { mergeTavernCallConfig, pickReasoningEffort } from './core/callConfig.js'
import { BOUND_DISCIPLINE, UNBOUND_STANDING, formatTurnPlaybook, neutralizeDshMustache } from './core/dshPrompt.js'
import { standingFingerprint } from './core/standingPin.js'
import type { SamplingSettings } from './core/types.js'

export const name = 'dsh-tavern-agent'
export const inject = ['tavern', 'systemPrompt', 'tools', 'llm']

const STANDING_SECTION = 'tavern:standing'
const TURN_CONTEXT = 'tavern:turn'
/** 工具说明占用 100–199；骨架放在其后，避免抖动打穿工具前缀。 */
const STANDING_ORDER = 210

function applyStanding(result: { sections: Array<{ name: string; text: string }> }, text: string): void {
  const index = result.sections.findIndex((s) => s.name === STANDING_SECTION)
  if (index !== -1) result.sections[index]!.text = text
}

function applyTurnContext(result: { contexts: Array<{ name: string; text: string }> }, text: string): void {
  const index = result.contexts.findIndex((c) => c.name === TURN_CONTEXT)
  if (index !== -1) result.contexts[index]!.text = text
  else if (text.trim()) result.contexts.push({ name: TURN_CONTEXT, text })
}

function joinPromptParts(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}

/** 只发送适配器公布的档位；deepseek-official 在解析失败时仍可关 thinking。 */
async function resolveTavernReasoningEffort(
  state: TavernState,
  llm: LlmRuntime | undefined,
  config: LlmCallConfig,
  sampling: SamplingSettings,
  signal: AbortSignal,
): Promise<string | undefined> {
  const current = config.reasoningEffort
  if (llm) {
    try {
      const info = await state.resolveModelInfoCached(llm, config.provider, config.model, signal)
      const picked = pickReasoningEffort(
        sampling.thinking,
        info.reasoning?.efforts,
        info.reasoning?.defaultEffort,
        current,
      )
      if (picked !== undefined) return picked
    } catch {
      // 解析失败不阻断采样合入
    }
  }
  if (sampling.thinking === 'disabled' && config.provider === 'deepseek-official') return 'off'
  return pickReasoningEffort(sampling.thinking, undefined, undefined, current)
}

export function apply(ctx: Context): void {
  const service = ctx.get('tavern') as TavernService
  const state = service.state
  const llm = ctx.get('llm') as LlmRuntime | undefined

  ctx.systemPrompt.section({ name: STANDING_SECTION, order: STANDING_ORDER, text: UNBOUND_STANDING })
  ctx.systemPrompt.context({ name: TURN_CONTEXT, order: 20, text: '' })

  ctx.on('agent/pre-step', async (payload, next) => {
    state.currentSteps.set(payload.agent.id, payload.step)
    return next()
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    const agent = context.agent
    if (!agent) return result

    const binding = await state.loadBinding(agent.id)
    if (!binding) {
      applyStanding(result, UNBOUND_STANDING)
      applyTurnContext(result, '')
      return result
    }
    try {
      const pipeline = await runTavernPipeline({ state, sessionId: agent.id, agent, llm, mode: 'live' })
      if (!pipeline) {
        applyStanding(result, UNBOUND_STANDING)
        applyTurnContext(result, '')
        return result
      }
      const standing = neutralizeDshMustache([BOUND_DISCIPLINE, pipeline.standing].filter((p) => p.trim()).join('\n\n'))
      applyStanding(
        result,
        state.pinStanding(
          agent.id,
          standingFingerprint(
            binding,
            { name: pipeline.userName, description: pipeline.personaDescription },
            state.standingRevTags(binding),
          ),
          standing,
        ),
      )
      const playbook = formatTurnPlaybook(state.currentSteps.get(agent.id) ?? 1)
      applyTurnContext(result, neutralizeDshMustache(joinPromptParts([playbook, pipeline.turnContext])))
    } catch (error) {
      ctx.logger.warn(`dsh-tavern: 提示词组装失败（保持未绑定短文案）：${error instanceof Error ? error.message : String(error)}`)
      applyStanding(result, UNBOUND_STANDING)
      applyTurnContext(result, '')
    }
    return result
  })

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const binding = await state.loadBinding(payload.agent.id)
    if (!binding) return config
    const sampling = state.config.sampling
    const reasoningEffort = await resolveTavernReasoningEffort(state, llm, config, sampling, payload.signal)
    const merged = mergeTavernCallConfig(config, sampling, reasoningEffort)
    return reasoningEffort === undefined ? merged : { ...merged, reasoningEffort: ReasoningEffortId(reasoningEffort) }
  })

  registerTavernTools(ctx, state)
  registerMemoryMaintenance(ctx, state, llm)
}
