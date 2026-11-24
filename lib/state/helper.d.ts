import { type HelperScopes, type HelperVariableChange } from '../core/helperRuntime.js';
import { type HelperSwipeSet } from '../core/helperSwipes.js';
import { type HelperMvuState } from '../core/helperMvu.js';
import type { WorkspaceFs } from './workspaceFs.js';
export declare const HELPER_STATE_PATH = "state/helper.json";
export interface HelperState {
    scopes: HelperScopes;
    extras: Record<string, Record<string, unknown>>;
    swipes?: Record<string, HelperSwipeSet>;
    mvu?: HelperMvuState;
}
export declare function evictHelperStateCache(root: string, options?: {
    prefix?: boolean;
}): void;
export declare function loadHelperState(fs: WorkspaceFs): Promise<HelperState>;
export declare function loadHelperScopes(fs: WorkspaceFs): Promise<HelperScopes>;
export interface SerializedHelperState {
    raw: string;
    byteLength: number;
    normalized: HelperState;
}
/** 验证并序列化酒馆助手状态（含 4 MiB 上限）；调用方可在开启或重开 WAL 楼层前预检，避免超限留下未提交楼层。 */
export declare function serializeHelperState(state: HelperState): SerializedHelperState;
/** 同文件保存变量与 extra，整批在一次原子正文替换中生效。 */
export declare function saveHelperState(fs: WorkspaceFs, state: HelperState): Promise<void>;
export declare function applyHelperChanges(scopes: HelperScopes, changes: HelperVariableChange[]): HelperScopes;
export declare function commitHelperChanges(fs: WorkspaceFs, changes: HelperVariableChange[]): Promise<HelperScopes>;
