/**
 * 宿主兼容守卫。
 * `package.json` 的 `engines.dsh` 已放开为任意版本，宿主加载器不会再因版本号拒绝本插件；
 * 代价是插件必须在宿主 API 漂移时自行降级：每个阶段独立失败，可选服务缺失即跳过，
 * 异常只记录为一条诊断，绝不抛回 Cordis 宿主。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 单次降级：阶段标识稳定可搜索，message 只含简短原因。 */
export interface HostDegradation {
  phase: string
  message: string
}

/** 只需日志能力的宿主形状；host 的 Context 与 client 的 ClientContext 都满足。 */
export interface GuardHost {
  logger?: {
    warn?(message: string): void
    error?(message: string): void
    info?(message: string): void
  }
}

const REPORTS = new WeakMap<object, HostDegradation[]>()
const MAX_REPORTS = 32

/** 把任意异常压成一行文本；不回显路径，避免降级日志泄露本机目录。 */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

function reportsOf(host: GuardHost): HostDegradation[] {
  const key = host as unknown as object
  let list = REPORTS.get(key)
  if (!list) {
    list = []
    REPORTS.set(key, list)
  }
  return list
}

/** 当前宿主上的降级记录（只读快照），供诊断与测试读取。 */
export function hostDegradations(host: GuardHost): readonly HostDegradation[] {
  return [...(REPORTS.get(host as unknown as object) ?? [])]
}

function record(host: GuardHost, phase: string, error: unknown): void {
  const list = reportsOf(host)
  if (list.length >= MAX_REPORTS) list.shift()
  list.push({ phase, message: errorMessage(error) })
  const text = `dsh-tavern: ${phase} 已跳过（宿主接口可能已变更）：${errorMessage(error)}`
  try {
    if (typeof host.logger?.warn === 'function') host.logger.warn(text)
    else console.warn(text)
  } catch {
    // 日志本身失败不应再制造新的失败。
  }
}

/** 同步阶段：失败只记录并返回 undefined，调用方继续推进其余功能。 */
export function guardPhase<T>(host: GuardHost, phase: string, run: () => T): T | undefined {
  try {
    return run()
  } catch (error) {
    record(host, phase, error)
    return undefined
  }
}

/** 异步阶段：同上，拒绝转为 undefined。 */
export async function guardPhaseAsync<T>(host: GuardHost, phase: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    record(host, phase, error)
    return undefined
  }
}

/**
 * 读取可选服务。
 * `ctx.get` 是反射读取，不受 inject 检查约束；宿主没有该服务时返回 undefined，
 * 让功能降级而不是让插件整体不加载。
 */
export function optionalService<T>(host: GuardHost, name: string): T | undefined {
  try {
    const get = (host as unknown as { get?: (key: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    return (get.call(host, name) as T | undefined) ?? undefined
  } catch {
    return undefined
  }
}

/** 方法级能力探测：宿主改名或移除方法时返回 false，调用方走兼容分支。 */
export function hasMethod(value: unknown, name: string): boolean {
  if (value === null || value === undefined) return false
  try {
    return typeof (value as Record<string, unknown>)[name] === 'function'
  } catch {
    return false
  }
}

/** 宿主 Context 上的便捷包装，避免每处都写 host 参数。 */
export function withHost(ctx: Context) {
  return {
    ctx,
    get<T>(name: string): T | undefined {
      return optionalService<T>(ctx, name)
    },
    guard<T>(phase: string, run: () => T): T | undefined {
      return guardPhase(ctx as unknown as GuardHost, phase, run)
    },
    guardAsync<T>(phase: string, run: () => Promise<T>): Promise<T | undefined> {
      return guardPhaseAsync(ctx as unknown as GuardHost, phase, run)
    },
    degradations(): readonly HostDegradation[] {
      return hostDegradations(ctx as unknown as GuardHost)
    },
  }
}
