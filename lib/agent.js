import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { runTavernPipeline } from './node/pipeline.js';
import { registerMemoryMaintenance } from './node/memoryMaintenance.js';
import { blockHelperMvuAssembly, isHelperMvuBlocked, restoreHelperMvuInputs, stopForHelperMvu } from './node/helperMvuLifecycle.js';
import { onTurnStart } from './node/sessionLifecycle.js';
import { registerTavernTools } from './node/tools.js';
import { mergeTavernCallConfig, resolveTavernReasoningEffort } from './core/callConfig.js';
import { BOUND_DISCIPLINE, TURN_PLAYBOOK, UNBOUND_STANDING, isContinueInstruction, neutralizeDshMustache } from './core/dshPrompt.js';
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './node/presetAdapter.js';
import { attachPresetPlanMessage, createPresetPlanMessage, hasPresetPlanMessage } from './node/presetRequestProjection.js';
export const name = 'dsh-tavern-agent';
export const inject = ['tavern', 'systemPrompt', 'tools', 'llm'];
const STANDING_SECTION = 'tavern:standing';
const TURN_CONTEXT = 'tavern:turn';
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
    // rc.1 的 PTC SDK order=5000；旧 order=210 会把角色文本放到 SDK 前，损失工具前缀缓存。
    ctx.systemPrompt.section({ name: STANDING_SECTION, order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK') + 10, text: UNBOUND_STANDING });
    ctx.systemPrompt.context({ name: TURN_CONTEXT, order: 20, text: '' });
    ctx.on('agent/pre-step', async (payload, next) => {
        if (isHelperMvuBlocked(payload.agent, payload.turn)) {
            restoreHelperMvuInputs(payload.agent, payload.turn, payload.messages);
            return { kind: 'reject' };
        }
        state.currentSteps.set(payload.agent.id, payload.step);
        const decision = await next();
        if (decision.kind !== 'enter' || !state.presetAdapter)
            return decision;
        const pipeline = state.turnPlans.get(payload.agent.id)?.result;
        if (!pipeline?.layout)
            return decision;
        let hasPlan = false;
        for (const event of [...payload.agent.session.snapshotEvents()].reverse()) {
            if (event.type === 'user/message' && hasPresetPlanMessage(event.data, payload.agent.id, payload.turn)) {
                hasPlan = true;
                break;
            }
            if (event.type === 'turn/start')
                break;
        }
        if (hasPlan)
            return decision;
        const standing = neutralizeDshMustache(joinPromptParts([BOUND_DISCIPLINE, pipeline.standing]));
        const plan = { version: 1, sessionId: payload.agent.id, turn: payload.turn, layout: pipeline.layout,
            standingText: standing, contextText: neutralizeDshMustache(joinPromptParts([TURN_PLAYBOOK, pipeline.turnContext])) };
        // 最终路由到 agent/request 才确定。先给正常输入附加模型不可见元数据，
        // 不猜旧 header，也不给其它供应商增加一条人工台词。
        const last = decision.messages.at(-1);
        const messages = last ? [...decision.messages.slice(0, -1), attachPresetPlanMessage(last, plan)] : [createPresetPlanMessage(plan)];
        return { ...decision, messages };
    });
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const agent = context.agent;
        if (!agent)
            return next();
        const blocked = await blockHelperMvuAssembly(state, agent, context.signal);
        let result;
        try {
            result = await next();
        }
        catch (error) {
            const turn = state.currentTurns.get(agent.id);
            if (blocked && turn !== undefined)
                restoreHelperMvuInputs(agent, turn);
            throw error;
        }
        if (blocked) {
            applyStanding(result, UNBOUND_STANDING);
            applyTurnContext(result, '');
            return result;
        }
        // 首次门控可能延后了开层；变量回执已完成后才建立新 WAL，再冻结本轮提示词。
        const turn = state.currentTurns.get(agent.id);
        if (turn !== undefined && !state.openFloors.has(agent.id)) {
            await state.enqueueSessionTask(agent.id, () => onTurnStart(state, agent.id, turn, agent.session));
        }
        // 其它 assemble 插件或延后开层期间可能出现初始化任务；冻结计划前再核验一次。
        if (await blockHelperMvuAssembly(state, agent, context.signal)) {
            applyStanding(result, UNBOUND_STANDING);
            applyTurnContext(result, '');
            return result;
        }
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
            const pin = state.pinStanding(agent.id, generationType, pipeline.standingKey, standing);
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
            // 超时、损坏资产等不能悄悄变成缺设定的一轮；让宿主显示失败并允许用户修复后重试。
            throw error;
        }
        return result;
    });
    ctx.on('agent/request', async (payload, next) => {
        const config = await next();
        const binding = await state.loadBinding(payload.agent.id);
        if (!binding)
            return config.provider === PRESET_ADAPTER_PROVIDER ? { ...config, provider: PRESET_ADAPTER_SOURCE_PROVIDER } : config;
        const sampling = state.turnPlans.get(payload.agent.id)?.result.sampling ?? state.config.sampling;
        const reasoningEffort = await resolveRequestReasoningEffort(state, llm, config, sampling, payload.signal);
        const merged = mergeTavernCallConfig(config, sampling, reasoningEffort, payload.agent.options.maxTokens);
        const resolved = reasoningEffort === undefined ? merged : { ...merged, reasoningEffort: ReasoningEffortId(reasoningEffort) };
        if (state.presetAdapter && (resolved.provider === PRESET_ADAPTER_SOURCE_PROVIDER || resolved.provider === PRESET_ADAPTER_PROVIDER)) {
            // 旧版本未完成轮没有布局快照，必须完成旧冻结计划，不能为升级重跑模板。
            if (!state.turnPlans.get(payload.agent.id)?.result.layout)
                return { ...resolved, provider: PRESET_ADAPTER_SOURCE_PROVIDER };
            state.presetAdapter.ensureRegistered();
            return { ...resolved, provider: PRESET_ADAPTER_PROVIDER };
        }
        return resolved;
    });
    registerTavernTools(ctx, state);
    ctx.on('agent/turn-stopping', ({ agent, signal }) => stopForHelperMvu(state, agent, signal));
    registerMemoryMaintenance(ctx, state, llm);
}
