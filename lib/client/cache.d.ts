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
import type { Envelope, TavernRemote } from './types.js';
/** 会话绑定（key=sessionId）；assistant 节点 / 会话芯片 / 英雄区 / 操作条共享一次 RPC。 */
export declare function cachedSessionBinding(remote: TavernRemote, sessionId: string): Promise<Envelope<{
    binding: import("./types.js").SessionBinding | null;
    userName: string;
    canSwipeGreeting: boolean;
    conversationStarted: boolean;
}>>;
/** 角色详情（key=cardId）。 */
export declare function cachedCharacterDetail(remote: TavernRemote, cardId: string): Promise<Envelope<import("./types.js").CharacterDetail>>;
/** 头像 dataURL（key=cardId）。 */
export declare function cachedAvatar(remote: TavernRemote, cardId: string): Promise<Envelope<{
    dataUrl: string | null;
}>>;
/** setSessionBinding / clearSessionBinding 成功后调用（先于 reload / 广播）。 */
export declare function invalidateSessionBinding(sessionId: string): void;
/** 角色卡保存 / 删除后调用（详情与头像一起失效；删除时宿主侧绑定已清，会话绑定缓存靠 TTL 收敛）。 */
export declare function invalidateCharacter(cardId: string): void;
