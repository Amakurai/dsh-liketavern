/**
 * 事务层（WAL）：楼层级写入快照与回滚。
 * agent 每回合（楼层）对工作区的所有写入，先经 record() 快照原内容；
 * 「重新生成/回退楼层」时按记录逆序回放，把工作区精确恢复到该回合开始前。
 *
 * 磁盘布局（rootDir 为工作区的 state/wal/ 目录）：
 *   <root>/<floor>/meta.json      楼层事务元数据（committed/时间戳）
 *   <root>/<floor>/records.jsonl  写入前快照，每行 {"seq":n,"path":"...","before":"...|null"}
 * 回滚后楼层目录改名为 <floor>.rolled-back-<timestamp>，保留供调试（UI 不展示）。
 */
/** listFloors() 返回元素。 */
export interface WalFloorInfo {
    floor: string;
    committed: boolean;
    startedAt: string;
    rolledBack: boolean;
}
/** rollbackAfter() 返回形状。 */
export interface RollbackAfterResult {
    /** 实际恢复/删除的路径（各楼层 rollbackFloor 返回的合并）。 */
    restored: string[];
    /** 已不存在（含已回滚）而被跳过的楼层。 */
    skipped: string[];
}
/** records.jsonl 中二进制 before 快照的前缀（WorkspaceFs.writeBytes 写入，回滚时 base64 解码）。 */
export declare const WAL_BINARY_MARK = "binary-base64:";
export declare class Wal {
    private readonly rootDir;
    /** 实例内 promise 队列：所有公共方法串行化，保证并发安全。 */
    private queue;
    /**
     * 楼层目录名 → 记录状态（paths 用于同层同路径去重，seq 为已用最大序号）。
     * 全部公共方法按 floor 参数化、状态按楼层目录分键：多个未提交楼层可以并存
     * （同一张卡的并发会话各开各的 `sessionId#tN`），本类没有单态「当前楼层」。
     */
    private readonly states;
    /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
    constructor(rootDir: string);
    /** 开始一个楼层事务；对已存在且未 commit 的同名单元报错（防止跨会话串层）。 */
    beginFloor(floor: string): Promise<void>;
    /** 在即将写入 path 前记录快照；同层同路径只留首次快照，重复调用忽略。path 统一为正斜杠相对路径。 */
    record(floor: string, path: string, before: string | null): Promise<void>;
    /** 提交楼层：meta.committed=true 并记录 committedAt。 */
    commitFloor(floor: string): Promise<void>;
    /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
    rollbackFloor(floor: string, workspaceRoot: string): Promise<string[]>;
    /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
    rollbackAfter(floors: string[], workspaceRoot: string): Promise<RollbackAfterResult>;
    /** 列出全部楼层（含已回滚，rolledBack: true），按 startedAt 升序。 */
    listFloors(): Promise<WalFloorInfo[]>;
    /** 删除已回滚且早于 keepRolledBackDays（默认 7）的楼层目录，返回删除数。 */
    prune(options: {
        keepRolledBackDays?: number;
    }): Promise<number>;
    private enqueue;
    private readMeta;
    private writeMeta;
    private readRecords;
    /** 读取楼层记录状态（惰性加载，进程重启后首次访问时从磁盘重建）。 */
    private loadState;
    private hasRolledBackDir;
    private doBeginFloor;
    private doRecord;
    private doCommitFloor;
    private doRollbackFloor;
    private doRollbackAfter;
    private doListFloors;
    private doPrune;
}
