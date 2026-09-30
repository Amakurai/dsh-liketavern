import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js';
const present = (value) => typeof value === 'string' && value.trim() !== '';
/** 只接受成对的路由，不能拼出「新 provider + 旧 model」这类不存在的组合。 */
function pairOf(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const { provider, model } = value;
    return present(provider) && present(model) ? { provider, model } : undefined;
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
    const route = loggedRoute(agent.session) ?? pairOf(agent.options);
    if (!route)
        return {};
    return { provider: route.provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : route.provider, model: route.model };
}
