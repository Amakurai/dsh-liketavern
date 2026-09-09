/**
 * dsh-tavern agent 面插件（由 agent 预设 tavern 挂载，运行于 agent 作用域）。
 * 职责：
 * 1. 注册稳定 system 段 `tavern:standing` 与本轮 runtime context `tavern:turn`。
 *    已绑定：standing = 角色定义 + 预设骨架（冻结时钟，按会话钉死字节）；
 *    turn = 固定 playbook（不随 step 变，宿主按字节去重不重复追加）+ 世界书/记忆/变化层。
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
import { blockHelperMvuAssembly, isHelperMvuBlocked, restoreHelperMvuInputs, stopForHelperMvu } from './node/helperMvuLifecycle.js'
import { onTurnStart } from './node/sessionLifecycle.js'
import type { TavernService } from './node/service.js'
import type { TavernState } from './node/state.js'
import { registerTavernTools } from './node/tools.js'
import { mergeTavernCallConfig, resolveTavernReasoningEffort, type AdvertisedReasoningInfo } from './core/callConfig.js'
import { BOUND_DISCIPLINE, TURN_PLAYBOOK, UNBOUND_STANDING, isContinueInstruction, neutralizeDshMustache } from './core/dshPrompt.js'
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

/** 解析模型公布的 reasoning 档；无 llm 或解析失败一律返回 undefined，回退交给 resolveTavernReasoningEffort。 */
async function resolveRequestReasoningEffort(
  state: TavernState,
  llm: LlmRuntime | undefined,
  config: LlmCallConfig,
  sampling: SamplingSettings,
  signal: AbortSignal,
): Promise<string | undefined> {
  let reasoning: AdvertisedReasoningInfo | undefined
  if (llm) {
    try {
      reasoning = (await state.resolveModelInfoCached(llm, config.provider, config.model, signal)).reasoning
    } catch {
      // 解析失败不阻断采样合入
    }
  }
  return resolveTavernReasoningEffort(sampling.thinking, reasoning, config.reasoningEffort, config.provider)
}

export function apply(ctx: Context): void {
  const service = ctx.get('tavern') as TavernService
  const state = service.state
  const llm = ctx.get('llm') as LlmRuntime | undefined

  ctx.systemPrompt.section({ name: STANDING_SECTION, order: STANDING_ORDER, text: UNBOUND_STANDING })
  ctx.systemPrompt.context({ name: TURN_CONTEXT, order: 20, text: '' })

  ctx.on('agent/pre-step', async (payload, next) => {
    if (isHelperMvuBlocked(payload.agent, payload.turn)) {
      restoreHelperMvuInputs(payload.agent, payload.turn, payload.messages)
      return { kind: 'reject' }
    }
    state.currentSteps.set(payload.agent.id, payload.step)
    return next()
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (!agent) return next()
    const blocked = await blockHelperMvuAssembly(state, agent, context.signal)
    let result
    try { result = await next() }
    catch (error) {
      const turn = state.currentTurns.get(agent.id)
      if (blocked && turn !== undefined) restoreHelperMvuInputs(agent, turn)
      throw error
    }
    if (blocked) {
      applyStanding(result, UNBOUND_STANDING)
      applyTurnContext(result, '')
      return result
    }
    // 首次门控可能延后了开层；变量回执已完成后才建立新 WAL，再冻结本轮提示词。
    const turn = state.currentTurns.get(agent.id)
    if (turn !== undefined && !state.openFloors.has(agent.id)) {
      await state.enqueueSessionTask(agent.id, () => onTurnStart(state, agent.id, turn, agent.session))
    }
    // 其它 assemble 插件或延后开层期间可能出现初始化任务；冻结计划前再核验一次。
    if (await blockHelperMvuAssembly(state, agent, context.signal)) {
      applyStanding(result, UNBOUND_STANDING)
      applyTurnContext(result, '')
      return result
    }

    const binding = await state.loadBinding(agent.id)
    if (!binding) {
      applyStanding(result, UNBOUND_STANDING)
      applyTurnContext(result, '')
      return result
    }
    // 本轮是续写轮（continueFloor 的合成指令在 pendingInputs 里，turn/end 才清）时
    // 按 continue 场景组装：injection_trigger 过滤不同，standing 按场景分别钉死。
    // 提前到 try 外：组装失败时 catch 兜底还要按同一场景找钉位。
    const generationType = (state.pendingInputs.get(agent.id) ?? []).some(isContinueInstruction) ? 'continue' : 'normal'
    try {
      const pipeline = await runTavernPipeline({ state, sessionId: agent.id, agent, llm, mode: 'live', generationType })
      if (!pipeline) {
        applyStanding(result, UNBOUND_STANDING)
        applyTurnContext(result, '')
        return result
      }
      const standing = neutralizeDshMustache([BOUND_DISCIPLINE, pipeline.standing].filter((p) => p.trim()).join('\n\n'))
      const pin = state.pinStanding(
        agent.id,
        generationType,
        pipeline.standingKey,
        standing,
      )
      applyStanding(result, pin.text)
      // 缓存观测：standing 是否复用钉位（recompute = 指纹变化重算并重钉，本轮前缀缓存打穿一次）。
      // recordTriggerLog 是整体覆盖写，必须把 pipeline 的明细行一并带上。
      state.recordTriggerLog(agent.id, [
        ...pipeline.logLines,
        `[standing:pin] ${pin.reused ? 'hit' : 'recompute（指纹变化，已重新钉死）'}`,
      ])
      // playbook 固定不随 step 变化：宿主对 runtime context 快照按字节去重，
      // 同轮后续步骤的快照一个字节都不变 ⇒ 不再重复追加，前缀缓存全保。
      applyTurnContext(result, neutralizeDshMustache(joinPromptParts([TURN_PLAYBOOK, pipeline.turnContext])))
    } catch (error) {
      ctx.logger.warn(`dsh-tavern: 提示词组装失败：${error instanceof Error ? error.message : String(error)}`)
      // 超时、损坏资产等不能悄悄变成缺设定的一轮；让宿主显示失败并允许用户修复后重试。
      throw error
    }
    return result
  })

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const binding = await state.loadBinding(payload.agent.id)
    if (!binding) return config
    const sampling = state.turnPlans.get(payload.agent.id)?.result.sampling ?? state.config.sampling
    const reasoningEffort = await resolveRequestReasoningEffort(state, llm, config, sampling, payload.signal)
    const merged = mergeTavernCallConfig(config, sampling, reasoningEffort)
    return reasoningEffort === undefined ? merged : { ...merged, reasoningEffort: ReasoningEffortId(reasoningEffort) }
  })

  registerTavernTools(ctx, state)
  ctx.on('agent/turn-stopping', ({ agent, signal }) => stopForHelperMvu(state, agent, signal))
  registerMemoryMaintenance(ctx, state, llm)
}
