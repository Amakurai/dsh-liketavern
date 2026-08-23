import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { runTavernPipeline } from './node/pipeline.js';
import { registerMemoryMaintenance } from './node/memoryMaintenance.js';
import { registerTavernTools } from './node/tools.js';
import { mergeTavernCallConfig, resolveTavernReasoningEffort } from './core/callConfig.js';
import { BOUND_DISCIPLINE, TURN_PLAYBOOK, UNBOUND_STANDING, isContinueInstruction, neutralizeDshMustache } from './core/dshPrompt.js';
import { standingFingerprint } from './core/standingPin.js';
export const name = 'dsh-tavern-agent';
export const inject = ['tavern', 'systemPrompt', 'tools', 'llm'];
const STANDING_SECTION = 'tavern:standing';
const TURN_CONTEXT = 'tavern:turn';
/** 工具说明占用 100–199；骨架放在其后，避免抖动打穿工具前缀。 */
const STANDING_ORDER = 210;
function applyStanding(result, text) {
    const index = result.sections.findIndex((s) => s.name === STANDING_SECTION);
    if (index !== -1)
        result.sections[index].text = text;
}
function applyTurnContext(result, text) {
    const index = result.contexts.findIndex((c) => c.name === TURN_CONTEXT);
    if (index !== -1)
        result.contexts[index].text = text;
    else if (text.trim())
        result.contexts.push({ name: TURN_CONTEXT, text });
}
function joinPromptParts(parts) {
    return parts.filter((p) => p.trim().length > 0).join('\n\n');
}
/** 解析模型公布的 reasoning 档；无 llm 或解析失败一律返回 undefined，回退交给 resolveTavernReasoningEffort。 */
async function resolveRequestReasoningEffort(state, llm, config, sampling, signal) {
    let reasoning;
    if (llm) {
        try {
            reasoning = (await state.resolveModelInfoCached(llm, config.provider, config.model, signal)).reasoning;
        }
        catch {
            // 解析失败不阻断采样合入
        }
    }
    return resolveTavernReasoningEffort(sampling.thinking, reasoning, config.reasoningEffort, config.provider);
}
export function apply(ctx) {
    const service = ctx.get('tavern');
    const state = service.state;
    const llm = ctx.get('llm');
    ctx.systemPrompt.section({ name: STANDING_SECTION, order: STANDING_ORDER, text: UNBOUND_STANDING });
    ctx.systemPrompt.context({ name: TURN_CONTEXT, order: 20, text: '' });
    ctx.on('agent/pre-step', async (payload, next) => {
        state.currentSteps.set(payload.agent.id, payload.step);
        return next();
    });
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next();
        const agent = context.agent;
        if (!agent)
            return result;
        const binding = await state.loadBinding(agent.id);
        if (!binding) {
            applyStanding(result, UNBOUND_STANDING);
            applyTurnContext(result, '');
            return result;
        }
        // 本轮是续写轮（continueFloor 的合成指令在 pendingInputs 里，turn/end 才清）时
        // 按 continue 场景组装：injection_trigger 过滤不同，standing 按场景分别钉死。
        // 提前到 try 外：组装失败时 catch 兜底还要按同一场景找钉位。
        const generationType = (state.pendingInputs.get(agent.id) ?? []).some(isContinueInstruction) ? 'continue' : 'normal';
        try {
            const pipeline = await runTavernPipeline({ state, sessionId: agent.id, agent, llm, mode: 'live', generationType });
            if (!pipeline) {
                applyStanding(result, UNBOUND_STANDING);
                applyTurnContext(result, '');
                return result;
            }
            const standing = neutralizeDshMustache([BOUND_DISCIPLINE, pipeline.standing].filter((p) => p.trim()).join('\n\n'));
            const pin = state.pinStanding(agent.id, generationType, standingFingerprint(binding, { name: pipeline.userName, description: pipeline.personaDescription }, state.standingRevTags(binding, { personaLorebookId: pipeline.personaLorebookId }), generationType), standing);
            applyStanding(result, pin.text);
            // 缓存观测：standing 是否复用钉位（recompute = 指纹变化重算并重钉，本轮前缀缓存打穿一次）。
            // recordTriggerLog 是整体覆盖写，必须把 pipeline 的明细行一并带上。
            state.recordTriggerLog(agent.id, [
                ...pipeline.logLines,
                `[standing:pin] ${pin.reused ? 'hit' : 'recompute（指纹变化，已重新钉死）'}`,
            ]);
            // playbook 固定不随 step 变化：宿主对 runtime context 快照按字节去重，
            // 同轮后续步骤的快照一个字节都不变 ⇒ 不再重复追加，前缀缓存全保。
            applyTurnContext(result, neutralizeDshMustache(joinPromptParts([TURN_PLAYBOOK, pipeline.turnContext])));
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: 提示词组装失败：${error instanceof Error ? error.message : String(error)}`);
            // 瞬时故障（磁盘抖动/单文件损坏）不该打穿整段前缀缓存、也不该让本轮扮演突然掉到
            // 未绑定文案：有同卡钉位就穿钉位（可能略旧但字节稳定）；换卡后对不上钉位才回退未绑定。
            applyStanding(result, state.peekStanding(agent.id, generationType, binding.cardId) ?? UNBOUND_STANDING);
            applyTurnContext(result, '');
        }
        return result;
    });
    ctx.on('agent/request', async (payload, next) => {
        const config = await next();
        const binding = await state.loadBinding(payload.agent.id);
        if (!binding)
            return config;
        const sampling = state.config.sampling;
        const reasoningEffort = await resolveRequestReasoningEffort(state, llm, config, sampling, payload.signal);
        const merged = mergeTavernCallConfig(config, sampling, reasoningEffort);
        return reasoningEffort === undefined ? merged : { ...merged, reasoningEffort: ReasoningEffortId(reasoningEffort) };
    });
    registerTavernTools(ctx, state);
    registerMemoryMaintenance(ctx, state, llm);
}
