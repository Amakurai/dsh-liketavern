/**
 * 客户端进程内元数据缓存：assistant 节点 / 气泡 / 会话芯片 / 操作条各自独立读
 * 「绑定 + 角色详情 + 头像」，N 条回复放大成 ~3N 个重复 RPC + N 次头像 dataURL 传输。
 * 本模块按 key 做值缓存 + in-flight Promise 去重：同 key 并发共享一次 RPC；
 * 命中即回，过期后首个请求重拉并回填。
 *
 * TTL 口径：它只约束「下一次读取」能复用旧值多久，不是会主动唤醒 useLoader 的
 * 轮询器。本端已知写路径在成功后显式 invalidate 并广播（必须先失效再 reload，
 * 否则仍会吃到旧缓存）；模型工具、其它页签等外部写入会在组件下一次重载时收敛。
 * 失败（reject 或错误信封）不缓存，下次调用立即重试。
 *
 * 已知让步：getSessionBinding 的结果带 canSwipeGreeting（取决于会话是否已有用户
 * 消息），首条用户消息发出后最长 TTL 秒内可能仍读到 true；服务端仍是最终闸门。
 */
import type { Envelope, TavernRemote } from './types.js';
/**
 * 同页角色资产变更广播。仅清 Map 不会重新触发已经挂载的 useLoader；气泡、开场预览
 * 与会话 chip 监听此事件后按 cardId 主动 reload，避免保存成功却继续显示旧名称/设定。
 */
export declare const CHARACTER_CHANGED_EVENT = "dsh-tavern:character-changed";
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
/** 本端确认角色写入成功后，先失效缓存再通知所有仍挂载的消费者。 */
export declare function notifyCharacterChanged(cardId: string): void;
