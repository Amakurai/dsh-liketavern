/** 捕获宿主原生分支请求的确切来源，在宿主创建子会话之前持久化插件侧来源凭据。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { isTavernPresetId } from '../core/tavernMode.js'
import { guardPhase } from './hostCompat.js'
import { deleteHostForkIdentity, writeHostForkIdentity } from './hostForkIdentity.js'
import type { TavernPaths } from './paths.js'
import { forkedSessionParents } from './sessionArchiveSnapshot.js'
import { isTavernRuntimeSession } from './tavernSession.js'
import { SessionId } from '@deepseek-ai/dsh-session'

interface HostMethods {
  fork(request: unknown): unknown
}

interface AgentMethods {
  create(options: unknown): unknown
}

interface ForkCapture {
  parentId: string
  atSeq: number | undefined
  active: boolean
  used: boolean
}

/** ctx.get() 返回 traceable Proxy；恢复宿主方法时必须落到其底层 Service 实例，plain object 原样返回。 */
function unwrapService<T extends object>(service: T): T {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original]
  return (original && typeof original === 'object' ? original : service) as T
}

/** 只包装当前服务实例；并发分支各用独立异步上下文，来源仅记录在插件状态中。 */
export function captureHostForkRequests(controller: HostMethods, agents: AgentMethods, sourceIsTavern: (id: string) => boolean,
  saveIdentity: (childId: string, parentId: string, prefix: readonly unknown[]) => Promise<void>,
  deleteIdentity?: (childId: string) => Promise<void>): () => void {
  const context = new AsyncLocalStorage<ForkCapture>()
  // 包装和恢复都直接操作底层 Service 实例；traceable Proxy 每次读取都是新包装，引用比较恒不等。
  const serviceController = unwrapService(controller), serviceAgents = unwrapService(agents)
  const originalFork = serviceController.fork, originalCreate = serviceAgents.create
  const create = function (this: unknown, options: unknown): unknown {
    const capture = context.getStore()
    if (!capture?.active || capture.used || !options || typeof options !== 'object' || Array.isArray(options)) {
      return Reflect.apply(originalCreate, this, [options])
    }
    const input = options as Record<string, unknown>
    const meta = input.meta
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return Reflect.apply(originalCreate, this, [options])
    const fields = meta as Record<string, unknown>
    const count = input.inheritedEventCount
    const preset = typeof fields.agentPreset === 'string' ? fields.agentPreset : undefined
    if (fields.isSeeded !== true || !Array.isArray(input.seed) || !Number.isSafeInteger(count) || (count as number) <= 0
      || (count as number) > input.seed.length || typeof input.sessionId !== 'string' || !input.sessionId
      || (capture.atSeq !== undefined && count !== capture.atSeq + 1)
      || !(preset === undefined ? sourceIsTavern(capture.parentId) : isTavernPresetId(preset))) {
      return Reflect.apply(originalCreate, this, [options])
    }
    if (fields.parentSession !== undefined && fields.parentSession !== capture.parentId) {
      throw new Error('宿主分支请求与子会话的来源身份不一致')
    }
    capture.used = true
    // 旧宿主已持久化正确父身份；保留它自己的创建时序，不增加额外写入。
    if (fields.parentSession === capture.parentId) return Reflect.apply(originalCreate, this, [options])
    const childId = input.sessionId, prefix = input.seed.slice(0, count as number)
    return saveIdentity(childId, capture.parentId, prefix).then(async () => {
      forkedSessionParents.set(childId, SessionId(capture.parentId))
      try {
        return await Reflect.apply(originalCreate, this, [options])
      } catch (error) {
        // 宿主创建事务失败时清理本次写入的来源记录；deleteIdentity 失败不能掩盖原始创建错误。
        forkedSessionParents.delete(childId)
        await deleteIdentity?.(childId).catch(() => {})
        throw error
      }
    })
  }
  const fork = function (this: unknown, request: unknown): unknown {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return Reflect.apply(originalFork, this, [request])
    const input = request as Record<string, unknown>
    if (typeof input.sessionId !== 'string' || !input.sessionId) return Reflect.apply(originalFork, this, [request])
    const atSeq = typeof input.atSeq === 'number' && Number.isSafeInteger(input.atSeq) && input.atSeq >= 0 ? input.atSeq : undefined
    const capture: ForkCapture = { parentId: input.sessionId, atSeq, active: true, used: false }
    return context.run(capture, async () => {
      try { return await Reflect.apply(originalFork, this, [request]) }
      finally { capture.active = false }
    })
  }
  try {
    serviceAgents.create = create
    serviceController.fork = fork
  } catch (error) {
    if (serviceAgents.create === create) serviceAgents.create = originalCreate
    if (serviceController.fork === fork) serviceController.fork = originalFork
    throw error
  }
  return () => {
    if (serviceAgents.create === create) serviceAgents.create = originalCreate
    if (serviceController.fork === fork) serviceController.fork = originalFork
    context.disable()
  }
}

/** sessionController 可晚于插件出现或替换；注入子作用域负责安装与卸载。 */
export function installHostForkCapture(ctx: Context, paths: TavernPaths): void {
  void ctx.inject(['sessionController', 'agents'], scope => {
    guardPhase(scope, '宿主分支身份追踪', () => {
      const controller = scope.get('sessionController') as HostMethods | undefined
      const agents = scope.get('agents') as AgentMethods | undefined
      if (typeof controller?.fork !== 'function' || typeof agents?.create !== 'function') {
        throw new Error('缺少宿主分支或会话创建接口，无法确认来源的分支将被拒绝')
      }
      scope.effect(() => captureHostForkRequests(controller, agents, id => {
        try {
          const sessions = scope.get('sessions') as Pick<Context['sessions'], 'get'> | undefined
          const session = sessions?.get(id as Parameters<Context['sessions']['get']>[0])
          return session ? isTavernRuntimeSession(scope, session) : false
        } catch { return false }
      }, (childId, parentId, prefix) => writeHostForkIdentity(paths, childId, parentId, prefix),
      childId => deleteHostForkIdentity(paths, childId)), 'dsh-tavern host fork capture')
    })
  })
}
