/**
 * 分支兄弟索引的纯逻辑（无 I/O）：同一父会话 + 同一楼层 fork 出的分支互为兄弟，
 * 供 ST 式 ‹ n/m › 切换（UI 在 actions.tsx，存储在 state/siblings.ts，编排在 node/floors.ts）。
 *
 * 同一 turn 的记录连成无向边（parent—child），查询 = 含当前会话的连通分量。
 * 嵌套同层 fork（在分支里再 fork 同一楼层）因此自然并入同一组：
 * A→B（t3）、B→C（t3）得 {A,B,C}。位次按创建先后：组的根（无入边记录的一方）在前，
 * 其余按 createdAt 升序。索引是导航元数据而非剧情状态，不进 WAL、不随回退撤销。
 */
export interface SiblingFork {
    parentSessionId: string;
    turn: number;
    childSessionId: string;
    createdAt: string;
}
export interface SiblingSwipe {
    /** 当前会话在兄弟序列中的位次（0 起）。 */
    index: number;
    total: number;
    /** 兄弟会话 id（含自身），按创建先后排序。 */
    siblings: string[];
}
/** 从不可信 JSON 归一化索引记录；坏记录跳过。 */
export declare function normalizeSiblingForks(raw: unknown): SiblingFork[];
/** 追加一条 fork 记录；childSessionId 已存在则原样返回（幂等，重试不重复登记）。 */
export declare function recordSiblingFork(forks: readonly SiblingFork[], entry: SiblingFork): SiblingFork[];
/** 剪掉悬空记录（父或子会话已不存在）；changed = 是否有记录被剪掉。 */
export declare function pruneSiblingForks(forks: readonly SiblingFork[], exists: (sessionId: string) => boolean): {
    forks: SiblingFork[];
    changed: boolean;
};
/**
 * 查询会话在指定楼层的兄弟序列；该楼层无任何（存活的）分支记录时返回 null。
 * exists 过滤已删除的会话：成员被删则从组里剔除，位次重新计算。
 */
export declare function siblingSwipe(forks: readonly SiblingFork[], sessionId: string, turn: number, exists?: (sessionId: string) => boolean): SiblingSwipe | null;
