import { WorkspaceFs } from './workspaceFs.js';
export interface MemoryExpansionPlan {
    readonly fs: WorkspaceFs;
    readonly restore: Map<string, string>;
    readonly sourcesToUnarchive: Set<string>;
    readonly archivedTexts: Map<string, string>;
    readonly activePresent: Set<string>;
    readonly postorder: string[];
}
/** 批量回滚预检用的内存只读镜像：整批只扫描磁盘一次，并支持在内存中推进较新楼层的展开与回滚过渡。 */
export interface MemoryRollbackOverlay {
    readonly fs: WorkspaceFs;
    readonly active: Map<string, {
        id: string;
        text: string;
    }>;
    readonly archived: Map<string, {
        id: string;
        text: string;
    }>;
}
/** 一次性只读加载 memory/ 与 memory/archive/ 的全部有效 Markdown 条目。 */
export declare function loadMemoryRollbackOverlay(root: string): Promise<MemoryRollbackOverlay>;
/** 基于当前记忆镜像规划受影响摘要展开；缺失来源、损坏来源或任意长度环均在首次落盘前拒绝。 */
export declare function planMemoryExpansionFromOverlay(overlay: MemoryRollbackOverlay, paths: readonly string[]): MemoryExpansionPlan | null;
/** 在内存镜像上推进一次摘要展开，供多楼层批量预检继续验证更旧楼层。 */
export declare function simulateMemoryExpansionOnOverlay(overlay: MemoryRollbackOverlay, plan: MemoryExpansionPlan | null): void;
/** 在内存镜像上推进单个记忆文件的回滚目标（正文恢复或删除）。 */
export declare function applyMemoryFileToOverlay(overlay: MemoryRollbackOverlay, relPath: string, text: string | null): void;
/** 读取内存镜像中某个记忆文件的当前文本（用于推演 WAL rollbackTarget）。 */
export declare function readMemoryFileFromOverlay(overlay: MemoryRollbackOverlay, relPath: string): string | null;
/** 只读扫描并验证受影响的记忆归并谱系；缺失或循环会在写入与持久化游标前拒绝。 */
export declare function planExpandAffectedMemories(root: string, paths: readonly string[]): Promise<MemoryExpansionPlan | null>;
/** 执行已规划好的记忆归并展开：全部来源恢复后才删除归档与父摘要。 */
export declare function applyExpandAffectedMemories(root: string, plan: MemoryExpansionPlan | null): Promise<void>;
export declare function expandAffectedMemories(root: string, paths: readonly string[]): Promise<void>;
