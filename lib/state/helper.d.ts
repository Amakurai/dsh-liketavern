/** 剧情级酒馆助手状态：完整验证后 CAS 更新，每次写入经过当前楼层 WAL，支持分支和重启。 */
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
export declare function loadHelperState(fs: WorkspaceFs): Promise<HelperState>;
export declare function loadHelperScopes(fs: WorkspaceFs): Promise<HelperScopes>;
/** 同文件保存变量与 extra，整批在一次原子正文替换中生效。 */
export declare function saveHelperState(fs: WorkspaceFs, state: HelperState): Promise<void>;
export declare function applyHelperChanges(scopes: HelperScopes, changes: HelperVariableChange[]): HelperScopes;
export declare function commitHelperChanges(fs: WorkspaceFs, changes: HelperVariableChange[]): Promise<HelperScopes>;
