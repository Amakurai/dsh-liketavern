/**
 * 客户端进程内元数据缓存：assistant 节点 / 气泡 / 会话芯片 / 操作条各自独立读
 * 「绑定 + 角色详情 + 头像」，N 条回复放大成 ~3N 个重复 RPC + N 次头像 dataURL 传输。
 * 本模块按 key 做值缓存 + in-flight Promise 去重：同 key 并发共享一次 RPC；
 * 命中即回，过期后首个请求重拉并回填。
 *
 * TTL 口径：客户端拿不到可靠的变更事件（面板编辑、模型工具写入、其他浏览器页签
 * 都绕开本模块直写宿主），TTL 是「最迟多久看到新值」的兜底上限，不是精确失效点。
 * 本端已知的写路径在成功后显式调 invalidate*（必须先于 useLoader.reload() 与
 * BINDING_CHANGED_EVENT 广播，否则 reload 会吃到旧缓存）；其余写路径靠 TTL 收敛。
 * 失败（reject 或错误信封）不缓存，下次调用立即重试。
 *
 * 已知让步：getSessionBinding 的结果带 canSwipeGreeting（取决于会话是否已有用户
 * 消息），首条用户消息发出后最长 TTL 秒内可能仍读到 true；服务端仍是最终闸门。
 */
import type { Envelope, TavernRemote } from './types.js'

/** 绑定与角色详情：会话页内高频读，30s 兜底失效。 */
const META_TTL_MS = 30_000
/** 头像 dataURL 体积最大、且客户端没有改头像的写路径，放宽到 60s。 */
const AVATAR_TTL_MS = 60_000

/** remote 方法的裸业务结果类型（信封内 value；与 service 实现同源，不另手写形状）。 */
type ResultOf<M extends keyof TavernRemote> = Awaited<ReturnType<TavernRemote[M]>> extends Envelope<infer T> ? T : never

interface CacheEntry<T> {
  at: number
  value?: Envelope<T>
  pending?: Promise<Envelope<T>>
}

/**
 * 读一条缓存：in-flight 共享 > TTL 内命中 > 重拉。只缓存成功信封——错误信封多为
 * 上下文性失败（未绑定/服务未就绪），下次应真打 remote；reject 同理不留痕迹。
 */
function read<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, load: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
  const hit = map.get(key)
  if (hit?.pending) return hit.pending
  if (hit?.value && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value)
  const pending = load().then(
    (r) => {
      if (r.ok) {
        // 顺手清扫同表过期项：进程内缓存没有淘汰事件，头像 dataURL 这类大值不能无限滞留。
        const now = Date.now()
        for (const [k, entry] of map) {
          if (!entry.pending && entry.value && now - entry.at >= ttlMs) map.delete(k)
        }
        map.set(key, { at: now, value: r })
      } else if (map.get(key)?.pending === pending) {
        map.delete(key)
      }
      return r
    },
    (err) => {
      if (map.get(key)?.pending === pending) map.delete(key)
      throw err
    },
  )
  map.set(key, { at: Date.now(), pending })
  return pending
}

const bindings = new Map<string, CacheEntry<ResultOf<'getSessionBinding'>>>()
const details = new Map<string, CacheEntry<ResultOf<'getCharacterDetail'>>>()
const avatars = new Map<string, CacheEntry<ResultOf<'getAvatar'>>>()

/** 会话绑定（key=sessionId）；assistant 节点 / 会话芯片 / 英雄区 / 操作条共享一次 RPC。 */
export function cachedSessionBinding(remote: TavernRemote, sessionId: string) {
  return read(bindings, sessionId, META_TTL_MS, () => remote.getSessionBinding({ sessionId }))
}

/** 角色详情（key=cardId）。 */
export function cachedCharacterDetail(remote: TavernRemote, cardId: string) {
  return read(details, cardId, META_TTL_MS, () => remote.getCharacterDetail({ cardId }))
}

/** 头像 dataURL（key=cardId）。 */
export function cachedAvatar(remote: TavernRemote, cardId: string) {
  return read(avatars, cardId, AVATAR_TTL_MS, () => remote.getAvatar({ cardId }))
}

/** setSessionBinding / clearSessionBinding 成功后调用（先于 reload / 广播）。 */
export function invalidateSessionBinding(sessionId: string): void {
  bindings.delete(sessionId)
}

/** 角色卡保存 / 删除后调用（详情与头像一起失效；删除时宿主侧绑定已清，会话绑定缓存靠 TTL 收敛）。 */
export function invalidateCharacter(cardId: string): void {
  details.delete(cardId)
  avatars.delete(cardId)
}
