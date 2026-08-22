import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { runTavernPipeline } from './node/pipeline.js';
import { registerMemoryMaintenance } from './node/memoryMaintenance.js';
import { registerTavernTools } from './node/tools.js';
import { mergeTavernCallConfig, resolveTavernReasoningEffort } from './core/callConfig.js';
import { BOUND_DISCIPLINE, UNBOUND_STANDING, formatTurnPlaybook, isContinueInstruction, neutralizeDshMustache } from './core/dshPrompt.js';
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
        try {
            // 本轮是续写轮（continueFloor 的合成指令在 pendingInputs 里，turn/end 才清）时
            // 按 continue 场景组装：injection_trigger 过滤不同，standing 按场景分别钉死。
            const generationType = (state.pendingInputs.get(agent.id) ?? []).some(isContinueInstruction) ? 'continue' : 'normal';
            const pipeline = await runTavernPipeline({ state, sessionId: agent.id, agent, llm, mode: 'live', generationType });
            if (!pipeline) {
                applyStanding(result, UNBOUND_STANDING);
                applyTurnContext(result, '');
                return result;
            }
            const standing = neutralizeDshMustache([BOUND_DISCIPLINE, pipeline.standing].filter((p) => p.trim()).join('\n\n'));
            applyStanding(result, state.pinStanding(agent.id, generationType, standingFingerprint(binding, { name: pipeline.userName, description: pipeline.personaDescription }, state.standingRevTags(binding, { personaLorebookId: pipeline.personaLorebookId }), generationType), standing));
            const playbook = formatTurnPlaybook(state.currentSteps.get(agent.id) ?? 1);
            applyTurnContext(result, neutralizeDshMustache(joinPromptParts([playbook, pipeline.turnContext])));
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: 提示词组装失败（保持未绑定短文案）：${error instanceof Error ? error.message : String(error)}`);
            applyStanding(result, UNBOUND_STANDING);
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
