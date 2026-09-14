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
/**
 * 扫描持久化会话中对角色的引用。永久删除必须 fail-closed：任意 `.json` 无法解析、
 * 不符合绑定 schema 或文件身份与 sessionId 不一致，都记为无法安全归属的损坏绑定。
 * 若部分损坏对象仍明确携带目标 cardId，同时记入 sessionIds，供 host 诊断；
 * 对外 RemoteError details 只传计数，不传这些文件名或会话身份。
 */
export interface BindingReferenceScan {
    sessionIds: string[];
    corruptFiles: string[];
}
export declare function listBindingReferencesForCard(paths: TavernPaths, cardId: string): Promise<BindingReferenceScan>;
