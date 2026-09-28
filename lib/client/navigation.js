export function openSessionView(ctx, id) {
    const ui = ctx.get('uiWorkspace');
    if (ui && typeof ui.openSession === 'function') {
        ui.openSession(id);
        return;
    }
    const legacy = ctx.sessions;
    if (typeof legacy.open === 'function') {
        legacy.open(id);
        return;
    }
    throw new Error('宿主没有可用的会话导航接口');
}
export function createSessionsPort(ctx) {
    const host = ctx.sessions;
    return {
        open: (id) => openSessionView(ctx, id),
        ...(typeof host.refresh === 'function' ? { refresh: () => host.refresh() } : {}),
        ...(typeof host.binding === 'function' ? { binding: ((id) => host.binding(id)) } : {}),
        list: host.list,
        ...(typeof host.scope === 'function' ? { scope: (id) => host.scope(id) } : {}),
        ...(typeof host.sessionOf === 'function' ? { sessionOf: (scope) => host.sessionOf(scope) } : {}),
    };
}
