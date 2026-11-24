import { WorkspaceFs } from './workspaceFs.js';
export interface MemoryExpansionPlan {
    readonly fs: WorkspaceFs;
    readonly restore: Map<string, string>;
    readonly sourcesToUnarchive: Set<string>;
    readonly archivedTexts: Map<string, string>;
    readonly activePresent: Set<string>;
    readonly postorder: string[];
}
/** 只读扫描并验证受影响的记忆归并谱系；缺失或循环会在写入与持久化游标前拒绝。 */
export declare function planExpandAffectedMemories(root: string, paths: readonly string[]): Promise<MemoryExpansionPlan | null>;
/** 执行已规划好的记忆归并展开：全部来源恢复后才删除归档与父摘要。 */
export declare function applyExpandAffectedMemories(root: string, plan: MemoryExpansionPlan | null): Promise<void>;
export declare function expandAffectedMemories(root: string, paths: readonly string[]): Promise<void>;
