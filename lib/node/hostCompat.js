const REPORTS = new WeakMap();
const MAX_REPORTS = 32;
/** 把任意异常压成一行文本；不回显路径，避免降级日志泄露本机目录。 */
export function errorMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
function reportsOf(host) {
    const key = host;
    let list = REPORTS.get(key);
    if (!list) {
        list = [];
        REPORTS.set(key, list);
    }
    return list;
}
/** 当前宿主上的降级记录（只读快照），供诊断与测试读取。 */
export function hostDegradations(host) {
    return [...(REPORTS.get(host) ?? [])];
}
function record(host, phase, error) {
    const list = reportsOf(host);
    if (list.length >= MAX_REPORTS)
        list.shift();
    list.push({ phase, message: errorMessage(error) });
    const text = `dsh-tavern: ${phase} 已跳过（宿主接口可能已变更）：${errorMessage(error)}`;
    try {
        if (typeof host.logger?.warn === 'function')
            host.logger.warn(text);
        else
            console.warn(text);
    }
    catch {
        // 日志本身失败不应再制造新的失败。
    }
}
/** 同步阶段：失败只记录并返回 undefined，调用方继续推进其余功能。 */
export function guardPhase(host, phase, run) {
    try {
        return run();
    }
    catch (error) {
        record(host, phase, error);
        return undefined;
    }
}
/** 异步阶段：同上，拒绝转为 undefined。 */
export async function guardPhaseAsync(host, phase, run) {
    try {
        return await run();
    }
    catch (error) {
        record(host, phase, error);
        return undefined;
    }
}
/**
 * 读取可选服务。
 * `ctx.get` 是反射读取，不受 inject 检查约束；宿主没有该服务时返回 undefined，
 * 让功能降级而不是让插件整体不加载。
 */
export function optionalService(host, name) {
    try {
        const get = host.get;
        if (typeof get !== 'function')
            return undefined;
        return get.call(host, name) ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** 方法级能力探测：宿主改名或移除方法时返回 false，调用方走兼容分支。 */
export function hasMethod(value, name) {
    if (value === null || value === undefined)
        return false;
    try {
        return typeof value[name] === 'function';
    }
    catch {
        return false;
    }
}
/** 宿主 Context 上的便捷包装，避免每处都写 host 参数。 */
export function withHost(ctx) {
    return {
        ctx,
        get(name) {
            return optionalService(ctx, name);
        },
        guard(phase, run) {
            return guardPhase(ctx, phase, run);
        },
        guardAsync(phase, run) {
            return guardPhaseAsync(ctx, phase, run);
        },
        degradations() {
            return hostDegradations(ctx);
        },
    };
}
