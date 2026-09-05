/** 绑定与角色详情：会话页内高频读，30s 兜底失效。 */
const META_TTL_MS = 30_000;
/** 头像 dataURL 体积最大、且客户端没有改头像的写路径，放宽到 60s。 */
const AVATAR_TTL_MS = 60_000;
/**
 * 读一条缓存：in-flight 共享 > TTL 内命中 > 重拉。只缓存成功信封——错误信封多为
 * 上下文性失败（未绑定/服务未就绪），下次应真打 remote；reject 同理不留痕迹。
 */
function read(map, key, ttlMs, load) {
    const hit = map.get(key);
    if (hit?.pending)
        return hit.pending;
    if (hit?.value && Date.now() - hit.at < ttlMs)
        return Promise.resolve(hit.value);
    const pending = load().then((r) => {
        if (r.ok) {
            // invalidate 可能在请求飞行期间发生；只有当前槽位仍属于本次请求时才允许回填。
            // 否则旧请求晚到会把新请求已经写入的值覆盖回去。
            if (map.get(key)?.pending !== pending)
                return r;
            // 顺手清扫同表过期项：进程内缓存没有淘汰事件，头像 dataURL 这类大值不能无限滞留。
            const now = Date.now();
            for (const [k, entry] of map) {
                if (!entry.pending && entry.value && now - entry.at >= ttlMs)
                    map.delete(k);
            }
            map.set(key, { at: now, value: r });
        }
        else if (map.get(key)?.pending === pending) {
            map.delete(key);
        }
        return r;
    }, (err) => {
        if (map.get(key)?.pending === pending)
            map.delete(key);
        throw err;
    });
    map.set(key, { at: Date.now(), pending });
    return pending;
}
const bindings = new Map();
const details = new Map();
const avatars = new Map();
/** 会话绑定（key=sessionId）；assistant 节点 / 会话芯片 / 英雄区 / 操作条共享一次 RPC。 */
export function cachedSessionBinding(remote, sessionId) {
    return read(bindings, sessionId, META_TTL_MS, () => remote.getSessionBinding({ sessionId }));
}
/** 角色详情（key=cardId）。 */
export function cachedCharacterDetail(remote, cardId) {
    return read(details, cardId, META_TTL_MS, () => remote.getCharacterDetail({ cardId }));
}
/** 头像 dataURL（key=cardId）。 */
export function cachedAvatar(remote, cardId) {
    return read(avatars, cardId, AVATAR_TTL_MS, () => remote.getAvatar({ cardId }));
}
/** setSessionBinding / clearSessionBinding 成功后调用（先于 reload / 广播）。 */
export function invalidateSessionBinding(sessionId) {
    bindings.delete(sessionId);
}
/** 角色卡保存 / 删除后调用（详情与头像一起失效；删除时宿主侧绑定已清，会话绑定缓存靠 TTL 收敛）。 */
export function invalidateCharacter(cardId) {
    details.delete(cardId);
    avatars.delete(cardId);
}
