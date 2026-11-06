import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js';
const wrappedAgents = new WeakSet();
const patchedAgentProtos = new WeakSet();
const patchedModelProtos = new WeakSet();
const activeStepSelections = new WeakMap();
function patchAgentModelPrototype(model) {
    if (!model || typeof model !== 'object')
        return;
    const proto = Object.getPrototypeOf(model);
    if (!proto || typeof proto.current !== 'function' || patchedModelProtos.has(proto))
        return;
    patchedModelProtos.add(proto);
    const origCurrent = proto.current;
    proto.current = function () {
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
/**
 * 同步 DSH 0.2.2-rc.1 ReactLoopAgent 在单步 preStep -> prepareRequest 期间锁定的 selection：
 * Tavern 在 agent/request 中将 deepseek-official 重写为内部布局通道 tavern-deepseek 并合入预设 reasoningEffort；
 * 直接在实时 agent 实例及其原型上同步当步 selection，不静态依赖私有包导出，兼容 0.2.1-rc.5 与 0.2.2-rc.1。
 */
export function ensureAgentRequestSelectionSync(agent, stepSelection) {
    if (!agent || typeof agent !== 'object')
        return;
    const machine = agent;
    if (stepSelection && typeof stepSelection === 'object') {
        activeStepSelections.set(machine, stepSelection);
        machine._activeSelection = stepSelection;
    }
    patchAgentModelPrototype(machine.model);
    const proto = Object.getPrototypeOf(machine);
    if (proto && typeof proto.preStep === 'function' && !patchedAgentProtos.has(proto)) {
        patchedAgentProtos.add(proto);
        const origPreStep = proto.preStep;
        proto.preStep = async function (target, position) {
            patchAgentModelPrototype(this.model);
            if (!this.requestHeaderLogged && this.options?.provider && this.options?.model) {
                const current = this.model?.current?.();
                if (!current || current.provider !== this.options.provider || current.model !== this.options.model) {
                    this.model?.select?.({
                        provider: this.options.provider,
                        model: this.options.model,
                        ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
                    });
                }
            }
            if (this.model && typeof this.model.current === 'function' && this.model.current() === undefined) {
                const route = sessionModelRoute(this);
                const fallbackRoute = route.provider && route.model
                    ? {
                        provider: route.provider,
                        model: route.model,
                        ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
                    }
                    : {
                        provider: this.options?.provider || 'deepseek-official',
                        model: this.options?.model || 'deepseek-chat',
                    };
                this.model.select?.(fallbackRoute);
            }
            const decision = await origPreStep.call(this, target, position);
            if (decision?.selection && typeof decision.selection === 'object') {
                this._activeSelection = decision.selection;
                activeStepSelections.set(this, decision.selection);
            }
            return decision;
        };
    }
    if (!wrappedAgents.has(machine) && typeof machine.dispatch?.waterfall === 'function') {
        wrappedAgents.add(machine);
        const origWaterfall = machine.dispatch.waterfall;
        machine.dispatch.waterfall = async function (name, payload, ...rest) {
            if (name === 'agent/pre-step' && payload?.modelSelection && typeof payload.modelSelection === 'object') {
                activeStepSelections.set(machine, payload.modelSelection);
                machine._activeSelection = payload.modelSelection;
            }
            const res = await origWaterfall.call(this, name, payload, ...rest);
            if (name === 'agent/request' && res && typeof res === 'object') {
                const sel = (machine._activeSelection ?? activeStepSelections.get(machine));
                if (sel && typeof sel === 'object' && !Object.isFrozen(sel)) {
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
                }
                if (typeof machine.model?.select === 'function' && res.provider && res.model) {
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
    const existingAgents = root.get('agents')?.list?.() ?? [];
    for (const agent of existingAgents)
        ensureAgentRequestSelectionSync(agent);
    if (installedRoots.has(root))
        return;
    installedRoots.add(root);
    root.on('agent/created', (payload) => {
        ensureAgentRequestSelectionSync(payload?.agent ?? payload);
    });
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
