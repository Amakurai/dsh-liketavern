import { type TavernPaths } from './paths.js';
import type { SessionBinding } from '../core/binding.js';
export type { SessionBinding, WalLineageEntry } from '../core/binding.js';
/**
 * 会话绑定的严格解析：必填字段缺失或类型错误即抛错，未知字段丢弃（对齐 RPC schema 的 strip 行为）。
 * service.setSessionBinding 与本文件的 load/save 共用这一个校验点；
 * interactiveCards（会话级交互卡开关，boolean | null）原样透传——客户端依它做渲染决策。
 */
export declare function parseSessionBinding(input: unknown): SessionBinding;
export declare function loadBinding(paths: TavernPaths, sessionId: string): Promise<SessionBinding | null>;
export declare function saveBinding(paths: TavernPaths, binding: SessionBinding): Promise<void>;
export declare function deleteBinding(paths: TavernPaths, sessionId: string): Promise<void>;
/** 删除角色卡时清掉仍指向该 cardId 的会话绑定，避免封面页继续显示文件夹 ID。 */
export declare function clearBindingsForCard(paths: TavernPaths, cardId: string): Promise<void>;
