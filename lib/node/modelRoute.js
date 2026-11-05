/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。换模时宿主先向日志追加 model/selection，下一次请求才写
 * request/header；只看最近请求头会让换模后第一轮仍用旧模型。因此按宿主 modelSelection 投影同一
 * 口径取值：尚未被请求使用的最新选择优先，其次最近请求头，日志都没有时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import { Service, symbols, Context } from '@deepseek-ai/cordis';
import { AgentRegistry, AgentModel } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js';
if (typeof AgentModel?.prototype?.current === 'function') {
    const origCurrent = AgentModel.prototype.current;
    AgentModel.prototype.current = function () {
        const state = this.readState?.();
        if (state?.pending)
            return { ...state.pending };
        if (this.options?.provider && this.options?.model) {
            const hasOwnRequest = Boolean(this.session?.ownEvents?.()?.some((e) => e.type === 'request/header'));
            if (!hasOwnRequest) {
                return {
                    provider: this.options.provider,
                    model: this.options.model,
                    ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
                };
            }
        }
        return origCurrent.call(this);
    };
}
if (typeof SandboxPolicyService?.prototype?.overrideOf === 'function') {
    const origOverrideOf = SandboxPolicyService.prototype.overrideOf;
    SandboxPolicyService.prototype.overrideOf = function (session) {
        if (!this.sandboxModeProjectionHandle)
            return undefined;
        return origOverrideOf.call(this, session);
    };
}
if (typeof WorkingDirectoryService?.prototype?.get === 'function') {
    const origGet = WorkingDirectoryService.prototype.get;
    WorkingDirectoryService.prototype.get = function (session) {
        if (!this.workingDirectoryProjectionHandle) {
            return session?.header?.cwd ?? this.defaultDirectory;
        }
        return origGet.call(this, session);
    };
}
if (typeof WorkingDirectoryService?.prototype?.ensure === 'function') {
    const origEnsure = WorkingDirectoryService.prototype.ensure;
    WorkingDirectoryService.prototype.ensure = async function (agent, signal) {
        if (!this.workingDirectoryProjectionHandle && this.ctx?.sessionProjections) {
            try {
                await this[Service.init]?.();
            }
            catch { }
        }
        if (!this.workingDirectoryProjectionHandle) {
            return this.get(agent?.session);
        }
        return origEnsure.call(this, agent, signal);
    };
}
if (typeof ToolRuntime?.prototype?.selectExecutor === 'function') {
    const origSelectExecutor = ToolRuntime.prototype.selectExecutor;
    ToolRuntime.prototype.selectExecutor = function (scope) {
        try {
            return origSelectExecutor.call(this, scope);
        }
        catch (err) {
            if (err?.code === 'TOOL_EXECUTOR_UNAVAILABLE' || err?.name === 'ToolExecutorUnavailableError') {
                return new NativeToolExecutor(this.ctx);
            }
            throw err;
        }
    };
}
if (typeof ToolRuntime?.prototype?.modeFor !== 'function') {
    ;
    ToolRuntime.prototype.modeFor = function (scope) {
        try {
            const exec = this.selectExecutor(scope);
            if (exec?.constructor?.name === 'PtcExecutor')
                return 'ptc';
            if (exec?.constructor?.name === 'NativeToolExecutor')
                return 'native';
            return undefined;
        }
        catch {
            return undefined;
        }
    };
}
if (typeof ToolRuntime?.prototype?.execute === 'function') {
    const origExecute = ToolRuntime.prototype.execute;
    ToolRuntime.prototype.execute = async function (input) {
        const isSingle = input && !input.calls && (input.name !== undefined || input.callId !== undefined);
        if (isSingle) {
            const call = {
                id: input.callId ?? 'call-1',
                name: input.name,
                arguments: input.arguments,
            };
            const batchInput = {
                ...input,
                calls: [call],
            };
            const batchResult = await origExecute.call(this, batchInput);
            const first = batchResult?.results?.[0]?.result ?? batchResult?.results?.[0];
            return first ?? batchResult;
        }
        return origExecute.call(this, input);
    };
}
try {
    const EventsService = new Context().events?.constructor;
    if (typeof EventsService?.prototype?.waterfall === 'function') {
        const origWaterfall = EventsService.prototype.waterfall;
        EventsService.prototype.waterfall = function (...args) {
            const name = typeof args[0] === 'string' ? args[0] : typeof args[1] === 'string' ? args[1] : undefined;
            if (name === 'agent/pre-step') {
                const payload = typeof args[0] === 'object' && args[0] !== null ? args[0] : typeof args[1] === 'object' && args[1] !== null ? args[1] : undefined;
                if (payload && !payload.modelSelection && payload.agent) {
                    const route = sessionModelRoute(payload.agent);
                    payload.modelSelection = {
                        provider: route.provider ?? payload.agent.options?.provider ?? 'deepseek-official',
                        model: route.model ?? payload.agent.options?.model ?? 'deepseek-chat',
                        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
                    };
                }
            }
            return origWaterfall.apply(this, args);
        };
    }
}
catch { }
if (typeof AgentRegistry?.prototype?.setFactory === 'function') {
    const origSetFactory = AgentRegistry.prototype.setFactory;
    AgentRegistry.prototype.setFactory = function (factory) {
        if (this.factory !== undefined) {
            const target = factory?.[symbols.original] ?? factory;
            if (this.factory.target === target) {
                return () => { };
            }
        }
        return origSetFactory.call(this, factory);
    };
}
if (typeof AgentRegistry?.prototype?.requireFactory === 'function') {
    const origRequireFactory = AgentRegistry.prototype.requireFactory;
    AgentRegistry.prototype.requireFactory = function () {
        if (!this.factory && this.ctx?.agentLoop) {
            try {
                this.setFactory(this.ctx.agentLoop);
            }
            catch { }
        }
        return origRequireFactory.call(this);
    };
}
let patchedReactLoop = false;
if (typeof AgentLoop?.prototype?.initializeAgent === 'function') {
    const origInitializeAgent = AgentLoop.prototype.initializeAgent;
    AgentLoop.prototype.initializeAgent = async function (ownerCtx, options) {
        if (!this.modelProjectionHandle) {
            await this[Service.init]?.();
        }
        const agents = this.runtime?.ctx?.agents;
        if (agents && !agents.turnBoundaryProjectionHandle) {
            await agents[Service.init]?.();
        }
        const loopCtx = this.runtime?.ctx;
        if (loopCtx && !loopCtx.tools) {
            loopCtx.tools = {
                resolve: async () => ({
                    dispose: () => { },
                    view: () => new Map(),
                }),
                execute: async () => [],
            };
        }
        const result = await origInitializeAgent.call(this, ownerCtx, options);
        const machine = result?.agent ?? result?.[0];
        if (machine) {
            if (typeof machine.dispatch?.waterfall === 'function' && !machine.dispatch._tavernWrapped) {
                const origWaterfall = machine.dispatch.waterfall;
                machine.dispatch._tavernWrapped = true;
                machine.dispatch.waterfall = async function (name, payload, ...rest) {
                    const res = await origWaterfall.call(this, name, payload, ...rest);
                    if (name === 'agent/request' && res && machine._activeSelection) {
                        const sel = machine._activeSelection;
                        if (res.provider)
                            sel.provider = res.provider;
                        if (res.model)
                            sel.model = res.model;
                        if (res.reasoningEffort !== undefined) {
                            sel.reasoningEffort = res.reasoningEffort;
                        }
                        else {
                            delete sel.reasoningEffort;
                        }
                        if (typeof machine.model?.select === 'function') {
                            machine.model.select({
                                provider: res.provider,
                                model: res.model,
                                ...(res.reasoningEffort !== undefined ? { reasoningEffort: res.reasoningEffort } : {}),
                            });
                        }
                    }
                    return res;
                };
            }
            if (!patchedReactLoop) {
                patchedReactLoop = true;
                const proto = Object.getPrototypeOf(machine);
                if (typeof proto?.preStep === 'function') {
                    const origPreStep = proto.preStep;
                    proto.preStep = async function (target, position) {
                        if (!this.requestHeaderLogged && this.options?.provider && this.options?.model) {
                            const current = this.model?.current();
                            if (!current || current.provider !== this.options.provider || current.model !== this.options.model) {
                                this.model?.select({
                                    provider: this.options.provider,
                                    model: this.options.model,
                                    ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
                                });
                            }
                        }
                        if (this.model && this.model.current() === undefined) {
                            const route = sessionModelRoute(this);
                            const fallbackRoute = (route.provider && route.model)
                                ? {
                                    provider: route.provider,
                                    model: route.model,
                                    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
                                }
                                : {
                                    provider: this.options?.provider || 'deepseek-official',
                                    model: this.options?.model || 'deepseek-chat',
                                };
                            this.model.select(fallbackRoute);
                        }
                        const decision = await origPreStep.call(this, target, position);
                        if (decision?.selection) {
                            this._activeSelection = decision.selection;
                        }
                        return decision;
                    };
                }
            }
        }
        return result;
    };
}
if (typeof AgentRegistry?.prototype?.turnBoundaryOf === 'function') {
    const origTurnBoundaryOf = AgentRegistry.prototype.turnBoundaryOf;
    AgentRegistry.prototype.turnBoundaryOf = function (session) {
        if (this.turnBoundaryProjectionHandle) {
            return origTurnBoundaryOf.call(this, session);
        }
        let state = {
            openTurnStartSeq: null,
            lastStepStartSeq: null,
            lastStepBoundary: null,
            lastTurn: 0,
        };
        for (const event of session?.snapshotEvents?.() ?? []) {
            switch (event.type) {
                case 'turn/start':
                    state = { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn };
                    break;
                case 'turn/end':
                    state = { ...state, openTurnStartSeq: null };
                    break;
                case 'step/start':
                    state = { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } };
                    break;
                case 'step/end':
                    state = { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } };
                    break;
            }
        }
        return state;
    };
}
const present = (value) => typeof value === 'string' && value.trim() !== '';
/** 只接受成对的路由，不能拼出「新 provider + 旧 model」这类不存在的组合。 */
function pairOf(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const { provider, model } = value;
    if (!present(provider) || !present(model))
        return undefined;
    return {
        provider: provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : provider,
        model,
    };
}
/** 对齐宿主 applyModelSelectionProjection：请求用过同一路由后，待用选择即消耗。 */
function loggedRoute(session) {
    const events = session?.snapshotEvents?.();
    if (!events)
        return pairOf(session?.requestHeader?.()?.config);
    let lastUsed;
    let pending;
    for (const event of events) {
        const type = String(event.type);
        if (type === 'model/selection') {
            pending = pairOf(event.data) ?? pending;
        }
        else if (type === 'request/header') {
            const used = pairOf(event.data?.header?.config);
            if (!used)
                continue;
            lastUsed = used;
            if (pending && pending.provider === used.provider && pending.model === used.model)
                pending = undefined;
        }
    }
    // 早于快照折叠点的请求头不在事件里，但宿主仍能重建它。
    return pending ?? lastUsed ?? pairOf(session?.requestHeader?.()?.config);
}
export function sessionModelRoute(agent) {
    return loggedRoute(agent.session) ?? pairOf(agent.options) ?? {};
}
const patchedProjections = new WeakSet();
const patchedDefs = new WeakSet();
const installedRoots = new WeakSet();
function normalizeSelectionEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    return entry.provider === PRESET_ADAPTER_PROVIDER
        ? { ...entry, provider: PRESET_ADAPTER_SOURCE_PROVIDER }
        : entry;
}
function normalizeModelSelectionState(state) {
    if (!state || typeof state !== 'object')
        return state;
    const lastUsed = normalizeSelectionEntry(state.lastUsed);
    let pending = normalizeSelectionEntry(state.pending);
    if (pending && lastUsed && pending.provider === lastUsed.provider && pending.model === lastUsed.model
        && (state.lastUsed?.provider === PRESET_ADAPTER_PROVIDER || state.pending?.provider === PRESET_ADAPTER_PROVIDER)) {
        pending = null;
    }
    return lastUsed === state.lastUsed && pending === state.pending ? state : { lastUsed, pending };
}
function patchModelSelectionDef(def) {
    if (!def || typeof def !== 'object' || def.key !== 'modelSelection' || patchedDefs.has(def))
        return;
    patchedDefs.add(def);
    const origApply = def.apply;
    if (typeof origApply === 'function') {
        def.apply = (rawState, event) => {
            const state = normalizeModelSelectionState(rawState);
            if (event?.type === 'model/selection' && event.data?.provider === PRESET_ADAPTER_PROVIDER) {
                return origApply(state, { ...event, data: { ...event.data, provider: PRESET_ADAPTER_SOURCE_PROVIDER } });
            }
            if (event?.type === 'request/header' && event.data?.header?.config?.provider === PRESET_ADAPTER_PROVIDER) {
                const cfg = event.data.header.config;
                const normalizedEvent = {
                    ...event,
                    data: {
                        ...event.data,
                        header: {
                            ...event.data.header,
                            config: { ...cfg, provider: PRESET_ADAPTER_SOURCE_PROVIDER },
                        },
                    },
                };
                const next = origApply(state, normalizedEvent);
                if (next.pending && next.pending.provider === PRESET_ADAPTER_SOURCE_PROVIDER && next.pending.model === cfg.model) {
                    return { ...next, pending: null };
                }
                return next;
            }
            return origApply(state, event);
        };
    }
    const schema = def.stateSchema;
    if (schema && typeof schema === 'object' && !patchedDefs.has(schema)) {
        patchedDefs.add(schema);
        if (typeof schema.parse === 'function') {
            const origParse = schema.parse.bind(schema);
            schema.parse = (input) => normalizeModelSelectionState(origParse(input));
        }
        if (typeof schema.safeParse === 'function') {
            const origSafeParse = schema.safeParse.bind(schema);
            schema.safeParse = (input) => {
                const res = origSafeParse(input);
                return res.success ? { ...res, data: normalizeModelSelectionState(res.data) } : res;
            };
        }
    }
}
function ensureProjectionPatched(projections) {
    if (!projections || typeof projections !== 'object')
        return;
    const regMap = projections.registrations;
    const existing = regMap?.get('modelSelection');
    if (existing?.def)
        patchModelSelectionDef(existing.def);
    if (patchedProjections.has(projections))
        return;
    patchedProjections.add(projections);
    const origRegister = projections.register;
    if (typeof origRegister === 'function') {
        ;
        projections.register = function (def) {
            patchModelSelectionDef(def);
            const dispose = origRegister.call(this, def);
            const registered = regMap?.get('modelSelection');
            if (registered?.def)
                patchModelSelectionDef(registered.def);
            return dispose;
        };
    }
}
/**
 * 对齐宿主 modelSelection 投影与 SessionController.consumeSelection：
 * Tavern 将 deepseek-official 请求重写为内部布局通道 tavern-deepseek 后，request/header 记录
 * provider='tavern-deepseek'。在此将其映射回 deepseek-official 结算，避免 pending/picked 悬空导致跨轮/跨重启重复换模通知。
 */
export function installTavernModelSelectionCompat(ctx) {
    const root = (ctx.root ?? ctx);
    ensureProjectionPatched(root.get('sessionProjections'));
    if (installedRoots.has(root))
        return;
    installedRoots.add(root);
    root.on('session/event', (session, event) => {
        ensureProjectionPatched(root.get('sessionProjections'));
        if (event?.type !== 'request/header')
            return;
        const cfg = event.data?.header?.config;
        if (!cfg || cfg.provider !== PRESET_ADAPTER_PROVIDER)
            return;
        const controller = root.get('sessionController');
        const agents = root.get('agents');
        const agent = agents?.get?.(session.id);
        if (!agent || agent.session !== session || !controller?.agents)
            return;
        const consumed = controller.agents.consumeSelection?.(agent, PRESET_ADAPTER_SOURCE_PROVIDER, cfg.model, cfg.reasoningEffort);
        if (!consumed) {
            const sel = controller.agents.selections?.get(agent);
            const current = sel?.current;
            if (current
                && (current.provider === PRESET_ADAPTER_SOURCE_PROVIDER || current.provider === PRESET_ADAPTER_PROVIDER)
                && typeof current.model === 'string'
                && current.model === cfg.model) {
                sel?.consume?.(current.provider, current.model, current.reasoningEffort);
            }
        }
    });
}
