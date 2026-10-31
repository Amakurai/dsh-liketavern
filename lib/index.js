import '@deepseek-ai/dsh-typert-registry';
import { Config, TAVERN_NS, TavernConfigSchema, resolveConfig } from './node/config.js';
import { adoptHostFork, ensureGreeting } from './node/floors.js';
import { createGreetingRetirement } from './node/greetingRetirement.js';
import { tavernPaths } from './node/paths.js';
import { installTavernPreset } from './node/presetInstall.js';
import { createTavernService } from './node/service.js';
import { recordRequestDiagnostics, registerRequestDiagnostics } from './node/requestDiagnostics.js';
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER, registerPresetAdapter } from './node/presetAdapter.js';
import { createPresetRequestProjector } from './node/presetRequestProjection.js';
import { onTurnStart, onTurnEnd } from './node/sessionLifecycle.js';
import { registerPromptInputTracking } from './node/pendingInputs.js';
import { registerHelperMvuLifecycle, reserveHelperMvuMaintenance } from './node/helperMvuLifecycle.js';
import { TavernState } from './node/state.js';
import { isTavernRuntimeSession } from './node/tavernSession.js';
import { TYPERT_HOST } from './remote.js';
export const name = 'dsh-liketavern';
export { Config };
export const inject = ['settings', 'sessions', 'agents', 'typert', 'workspaceRegistry', 'agentPresets'];
export async function apply(ctx, config) {
    const ns = ctx.fiber.entry?.options.id ?? TAVERN_NS;
    ctx.effect(() => ctx.settings.configure({ auto: false }), 'dsh-tavern settings');
    const scope = {
        get: () => TavernConfigSchema(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()]))),
        revision: () => {
            const descriptor = ctx.settings.describe().find(item => item.ns === ns);
            if (!descriptor || !Number.isSafeInteger(descriptor.revision))
                throw new Error('宿主未提供 Tavern 设置修订号');
            return descriptor.revision;
        },
        update: (patch, expectedRevision) => ctx.settings.update(ns, patch, expectedRevision),
    };
    const state = new TavernState(tavernPaths(), () => resolveConfig(scope.get()), (message) => ctx.logger.warn(message));
    await state.init();
    createTavernService(ctx, state, scope);
    try {
        const disposePreset = await installTavernPreset(ctx);
        ctx.effect(() => disposePreset, 'dsh-tavern preset');
    }
    catch (error) {
        ctx.logger.warn(`dsh-tavern: agent 预设安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
    registerRequestDiagnostics(ctx, state);
    state.presetAdapter = registerPresetAdapter(ctx, (options, model) => {
        // 摘要、标题和明确的独立代答没有普通聊天布局；仍复用相同官方传输。
        if (options.purpose || !options.sessionId)
            return options;
        const session = ctx.sessions.get(options.sessionId);
        if (session && !isTavernRuntimeSession(ctx, session))
            return options;
        const notes = new Set();
        // 请求副本清理开关随本轮计划冻结（plan.cleanup），这里不读当前设置。
        const projector = createPresetRequestProjector(ctx, {
            onDiagnostic: diagnostic => {
                if (diagnostic.kind === 'text-budget') {
                    if (notes.size >= 128)
                        notes.delete(notes.values().next().value);
                    const window = diagnostic.contextWindow === undefined ? '模型窗口未知'
                        : `模型窗口 ${diagnostic.contextWindow}，输出预留 ${diagnostic.reservedOutputTokens}，可用 ${diagnostic.availableTextTokens}`;
                    notes.add(`文本估算：投影前≈${diagnostic.beforeTextTokens} tokens，投影后≈${diagnostic.afterTextTokens} tokens；${window}。不含图片、工具编码和供应商消息封装。`
                        + (diagnostic.exceedsAvailable ? '估算已超过可用窗口，可能请求失败；请缩短预设、减少深度 system 或清理历史。' : ''));
                }
                else if (diagnostic.kind === 'request-cleanup') {
                    if (notes.size < 128)
                        notes.add(`请求清理：${diagnostic.hideHarnessIdentity ? '已删除宿主身份句' : '保留宿主身份句'}；`
                            + `${diagnostic.droppedWorkspaceInstructions > 0 ? `已剔除 ${diagnostic.droppedWorkspaceInstructions} 条工作区指令` : '无工作区指令'}。`);
                }
                else if (notes.size < 128)
                    notes.add(diagnostic.kind === 'compaction-clamp'
                        ? `历史消息 ${diagnostic.messageId} 已压缩，提示词位置映射至摘要 ${diagnostic.summaryMessageId} 的边界。`
                        : diagnostic.kind === 'messages-system-layout'
                            ? 'DeepSeek Messages 不支持此预设的中途 system 位置；全部系统指令合入首条完整提示，保留工具说明。user/assistant 条目仍按布局投影，供应商可能合并相邻同角色消息。'
                            : '当前模型仅支持首条 system；系统角色预设合入首条完整提示，user/assistant 角色仍按布局插入。');
            }
        });
        const projected = projector.project(options, model);
        recordRequestDiagnostics(state, options.sessionId, projected, 'tavern-adapter', [...notes]);
        return projected;
    });
    const preparePresetAdapter = () => {
        const providers = ctx.get('llm')?.listProviders() ?? [];
        if (providers.some(provider => provider.id === PRESET_ADAPTER_PROVIDER)
            || !providers.some(provider => provider.id === PRESET_ADAPTER_SOURCE_PROVIDER))
            return;
        try {
            state.presetAdapter.ensureRegistered();
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: DeepSeek 布局通道尚未就绪：${String(error)}`);
        }
    };
    preparePresetAdapter();
    ctx.on('llm/adapters-updated', preparePresetAdapter);
    registerHelperMvuLifecycle(ctx);
    ctx.effect(() => ctx.typert.register(TYPERT_HOST), 'dsh-tavern.typert');
    const greetingRetirement = createGreetingRetirement(ctx);
    const adoptOrRetireSession = (session) => {
        let isFork = false;
        try {
            isFork = Boolean(session.header.parentSession) && isTavernRuntimeSession(ctx, session);
        }
        catch {
            return;
        }
        if (!isFork) {
            greetingRetirement.schedule(session);
            return;
        }
        void state.trackBindingAdoption(session.id, () => adoptHostFork({ ctx, state }, session))
            .then((adopted) => { if (adopted)
            ctx.logger.info(`dsh-tavern: 已为宿主分支 ${session.id} 准备独立剧情`); greetingRetirement.afterAdoption(session); })
            .catch((error) => ctx.logger.warn(`dsh-tavern: 宿主分支绑定剧情失败：${error instanceof Error ? error.message : String(error)}`));
    };
    for (const session of ctx.sessions.list())
        adoptOrRetireSession(session);
    ctx.on('session/created', adoptOrRetireSession);
    ctx.on('agent/created', ({ agent }) => { greetingRetirement.agentCreated(agent); return undefined; });
    // 楼层 WAL 与每 turn 检索缓存：只碰 Tavern 模式会话，普通 dsh 助手不受影响。
    ctx.on('session/event', (session, event) => {
        if (!isTavernRuntimeSession(ctx, session))
            return;
        if (event.type === 'turn/start') {
            const { turn } = event.data;
            void state
                .enqueueSessionTask(session.id, () => onTurnStart(state, session.id, turn, session))
                .catch((error) => ctx.logger.warn(`dsh-tavern: beginFloor 失败：${String(error)}`));
        }
        else if (event.type === 'step/start') {
            const { step } = event.data;
            if (state.currentTurns.has(session.id))
                state.currentSteps.set(session.id, step);
        }
        else if (event.type === 'turn/end') {
            // 事件队列可能晚于下一轮开始才执行；必须携带这一刻的不可变日志快照。
            const events = session.snapshotEvents();
            const closedSession = { id: session.id, snapshotEvents: () => events };
            void state
                .enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, closedSession))
                .catch((error) => ctx.logger.warn(`dsh-tavern: commitFloor 失败：${String(error)}`));
        }
    });
    // 宿主认领后才把尚未入日志的消息交给本轮扫描；未来排队输入不能提前触发设定。
    registerPromptInputTracking(ctx, state);
    // 第一条真正发出时写入开场白，避免空白会话被写脏后无法换模式 / 无法新对话。
    ctx.on('agent/inbox/inserted', ({ agent }) => {
        const session = ctx.sessions.get(agent.id);
        if (!session || !isTavernRuntimeSession(ctx, session))
            return;
        void state
            .enqueueSessionTask(agent.id, () => ensureGreeting({ ctx, state }, agent.id))
            .catch((error) => ctx.logger.warn(`dsh-tavern: 写入开场白失败：${String(error)}`));
        reserveHelperMvuMaintenance(state, agent, error => ctx.logger.warn(`dsh-tavern: MVU 等待已结束，待处理任务与输入保留：${String(error)}`));
    });
}
