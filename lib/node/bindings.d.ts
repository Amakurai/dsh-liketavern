import { type TavernPaths } from './paths.js';
import type { SessionBinding } from '../core/binding.js';
export type { SessionBinding, WalLineageEntry } from '../core/binding.js';
export declare function loadBinding(paths: TavernPaths, sessionId: string): Promise<SessionBinding | null>;
export declare function saveBinding(paths: TavernPaths, binding: SessionBinding): Promise<void>;
export declare function deleteBinding(paths: TavernPaths, sessionId: string): Promise<void>;
/** 删除角色卡时清掉仍指向该 cardId 的会话绑定，避免封面页继续显示文件夹 ID。 */
export declare function clearBindingsForCard(paths: TavernPaths, cardId: string): Promise<void>;
