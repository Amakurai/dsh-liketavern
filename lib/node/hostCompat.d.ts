/**
 * 宿主兼容守卫。
 * `package.json` 的 `engines.dsh` 已放开为任意版本，宿主加载器不会再因版本号拒绝本插件；
 * 代价是插件必须在宿主 API 漂移时自行降级：每个阶段独立失败，可选服务缺失即跳过，
 * 异常只记录为一条诊断，绝不抛回 Cordis 宿主。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 单次降级：阶段标识稳定可搜索，message 只含简短原因。 */
export interface HostDegradation {
    phase: string;
    message: string;
}
/** 只需日志能力的宿主形状；host 的 Context 与 client 的 ClientContext 都满足。 */
export interface GuardHost {
    logger?: {
        warn?(message: string): void;
        error?(message: string): void;
        info?(message: string): void;
    };
}
/** 把任意异常压成一行文本；不回显路径，避免降级日志泄露本机目录。 */
export declare function errorMessage(error: unknown): string;
/** 当前宿主上的降级记录（只读快照），供诊断与测试读取。 */
export declare function hostDegradations(host: GuardHost): readonly HostDegradation[];
/** 同步阶段：失败只记录并返回 undefined，调用方继续推进其余功能。 */
export declare function guardPhase<T>(host: GuardHost, phase: string, run: () => T): T | undefined;
/** 异步阶段：同上，拒绝转为 undefined。 */
export declare function guardPhaseAsync<T>(host: GuardHost, phase: string, run: () => Promise<T>): Promise<T | undefined>;
/**
 * 读取可选服务。
 * `ctx.get` 是反射读取，不受 inject 检查约束；宿主没有该服务时返回 undefined，
 * 让功能降级而不是让插件整体不加载。
 */
export declare function optionalService<T>(host: GuardHost, name: string): T | undefined;
/** 方法级能力探测：宿主改名或移除方法时返回 false，调用方走兼容分支。 */
export declare function hasMethod(value: unknown, name: string): boolean;
/** 宿主 Context 上的便捷包装，避免每处都写 host 参数。 */
export declare function withHost(ctx: Context): {
    ctx: Context;
    get<T>(name: string): T | undefined;
    guard<T>(phase: string, run: () => T): T | undefined;
    guardAsync<T>(phase: string, run: () => Promise<T>): Promise<T | undefined>;
    degradations(): readonly HostDegradation[];
};
