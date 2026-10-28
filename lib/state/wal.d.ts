/**
 * 事务层（WAL）：楼层级写入快照与回滚。
 * agent 每次写入先经 recordChange() 持久化前后镜像，再原子替换正文。
 * 回退逆序撤销本层修改，保留后续手动编辑；世界状态按条目合并撤销。
 * record()/recordAfter() 仅保留旧调用兼容，新写入不得使用后补快照协议。
 *
 * 磁盘布局（rootDir 为工作区的 state/wal/ 目录）：
 *   <root>/<floor>/meta.json      楼层事务元数据（committed/时间戳）
 *   <root>/<floor>/records.jsonl  每次修改的 before/after 及其显式编码
 * 回滚后楼层目录改名为 <floor>.rolled-back-<timestamp>，保留供调试（UI 不展示）。
 */
import type { WalRecord } from '../core/types.js';
/** records.jsonl 单行形状（floor 由所在目录承载，行内不重复）。after/编码字段兼容旧记录。 */
type RecordLine = Omit<WalRecord, 'floor'>;
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
/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export declare const WAL_BINARY_MARK = "binary-base64:";
/**
 * 楼层目录中表明楼层已开始的文件。建目录后、写 meta 前崩溃会留下这些文件都不存在的目录：
 * 记录只在元数据存在后追加，回滚也先写游标再改正文，这种目录不可能关联任何正文修改，
 * 按未开始处理；缺元数据但有记录或回滚游标仍是损坏，照常拒绝。doctor 共用同一判定。
 */
export declare const WAL_FLOOR_MARKERS: readonly ["meta.json", "records.jsonl", "rollback-progress.json"];
/** 独立于 WAL 目录保存已知楼层，删除日志不能被误认为剧情从未写入。 */
export declare const WAL_COVERAGE_PATH = "state/wal-coverage.json";
/** 从同一记录与撤销前正文推导恢复目标；执行与恢复游标预检共用，禁止游标自行提供新正文。 */
export declare function rollbackTarget(rec: RecordLine, current: string | null): {
    restore: true;
    value: string | null;
} | {
    restore: false;
};
export declare class Wal {
    private readonly rootDir;
    private readonly logFs;
    private readonly hasCoverage;
    /** 最近一次确认已登记的楼层身份。 */
    private covered;
    /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
    constructor(rootDir: string);
    private readCoverage;
    private writeCoverage;
    private writeCoverageFloors;
    private recordCoverage;
    /**
     * 开层前核对已登记楼层的日志目录仍在（回滚副本同样算数），被清理后不能继续开新层。
     * 普通新层只比目录名；重用已登记 id 时只核对该身份的回滚完成证明，不能用新开始时间洗掉丢日志的证据。
     * 其它楼层的元数据与开始时间完整检查仍留给列举、回退与分支。
     */
    private assertCoveredFloorDirs;
    private assertLogPath;
    /** 开始新的楼层事务；已有楼层必须显式 reopen 或先回滚，不能覆盖原始镜像。 */
    beginFloor(floor: string): Promise<void>;
    /** 在即将写入 path 前记录快照；同层同路径只留首次快照，重复调用忽略。path 统一为正斜杠相对路径。 */
    record(floor: string, path: string, before: string | null, beforeEncoding?: 'utf8' | 'base64'): Promise<void>;
    /** 写入完成后补记 after 快照，用于回滚前识别楼层外的人工修改。 */
    recordAfter(floor: string, path: string, after: string | null, afterEncoding?: 'utf8' | 'base64'): Promise<void>;
    /** 每次修改独立记录 before/after，必须在正文原子替换之前持久化。 */
    recordChange(floor: string, path: string, before: string | null, after: string | null, beforeEncoding: 'utf8' | 'base64', afterEncoding: 'utf8' | 'base64'): Promise<void>;
    /**
     * 一批修改一次追加，序号按入参顺序连续；全部记录持久化后调用方才能替换其中任何正文。
     * 追加要重读并原子重写整份日志，逐条记录的代价随同层记录数平方增长。
     */
    recordChanges(floor: string, changes: ReadonlyArray<{
        path: string;
        before: string | null;
        after: string | null;
        beforeEncoding: 'utf8' | 'base64';
        afterEncoding: 'utf8' | 'base64';
    }>): Promise<void>;
    /** 提交楼层：meta.committed=true 并记录 committedAt。 */
    commitFloor(floor: string): Promise<void>;
    /** 已完成楼层追加受控事务前重新标记未收口；保留全部快照和时间，先验证整层，不能用旧 committed 掩盖新写入失败。 */
    reopenFloor(floor: string): Promise<void>;
    /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
    rollbackFloor(floor: string, workspaceRoot: string): Promise<string[]>;
    /**
     * 只读推算指定正文在完整撤销本层后的最终字节，用于回收根不再需要的生成恢复正文。
     * 调用方须持有工作区锁，使传入的当前正文与日志一致；按正式回滚相同规则保留楼层外修订。
     * 这里只处理给定路径，不执行模板块保留、记忆展开或索引重建，不能代替实际回滚。
     */
    rollbackSnapshot(floor: string, path: string, current: Uint8Array | null): Promise<Uint8Array | null>;
    /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
    rollbackAfter(floors: string[], workspaceRoot: string): Promise<RollbackAfterResult>;
    /** 列出全部楼层（含已回滚，rolledBack: true），按 startedAt 升序。 */
    listFloors(): Promise<WalFloorInfo[]>;
    /** 只读检查可用楼层：元数据、序号、路径与快照必须有效；回滚中的旧 committed 不能作为完成证明。 */
    validateFloor(floor: string): Promise<WalFloorInfo>;
    /** 删除已回滚且早于 keepRolledBackDays（默认 7）的楼层目录，返回删除数。 */
    prune(options: {
        keepRolledBackDays?: number;
    }): Promise<number>;
    private enqueue;
    private readMeta;
    private writeMeta;
    /** 目录存在不代表楼层可写；元数据必须完整且属于请求的原始楼层，不能只比净化后的目录名。 */
    private readFloorMeta;
    /** 恢复游标绑定原始记录集合；中断后只能继续回滚，追加或提交会使游标失效或误报已完成。 */
    private assertNotRecovering;
    /** 工作区级恢复标记的绝对路径；非标准日志根（无 state/wal 布局）退回日志目录内。 */
    private recoveryMarkerPath;
    /** 读恢复标记中的楼层清单及形状有效性；缺失返回 null，损坏返回 valid: false 以便对账重写或删除。 */
    private readRecoveryMarker;
    /**
     * 标记同时记下日志目录与各层净化后的目录名，WorkspaceFs 据此只凭标记即可判断游标是否仍在，
     * 失效标记（回滚已归档、未注销）不会挡住正文写入。非标准日志根时正文工作区另写一份副本，
     * 否则 WorkspaceFs（只看 <root>/state/wal-recovery.json）看不到屏障。
     */
    private writeRecoveryFloors;
    /** 回滚开始前登记本层：先写标记再写恢复游标，任何游标存在期间工作区都有写屏障。 */
    private markRecovering;
    /** 回滚完成后注销本层；没有其它恢复中楼层时删除标记。顺手丢掉已随归档消失的陈旧条目。 */
    private clearRecovering;
    /** 标记里仍“活着”的恢复楼层：活动目录存在且游标还在；已改名归档/被删除的条目算失效。 */
    private activeRecoveryFloors;
    /**
     * 清理崩溃窗口留下的失效标记条目（回滚已改名归档、但还没来得及注销标记）。
     * 只保留活动目录里仍有游标的楼层；没有剩余时删除标记文件。
     */
    private reconcileRecoveryMarker;
    /**
     * 普通写入只查标记文件（一次 stat），标记存在时顺带清掉失效条目再判断。
     * `scanCursors` 供开层/分支快照等低频入口使用，兜底识别旧版本崩溃遗留、还没有标记文件的恢复游标；
     * 已改名归档的回滚副本不算恢复中（它的游标只是完成回滚后的历史记录，`ROLLED_BACK_MARK` 目录一律跳过）。
     */
    private assertWorkspaceReady;
    /** 供分支快照等外部入口复用：有未完成恢复（或旧版遗留游标）时明确拒绝，并清理失效标记。 */
    assertWorkspaceWritable(): Promise<void>;
    /** 列出当前处于回滚恢复中的楼层（标记清单 + 磁盘游标），供面板/诊断决定是否提示重置。 */
    recoveringFloors(): Promise<string[]>;
    /**
     * 受控重置：删除本层恢复游标并注销标记，让冲突/损坏的恢复不再是永久死锁。
     * 下一次回滚会从当前磁盘状态重新回放（已还原的正文按既有「保留人工修订」语义处理），
     * 因此这不是“跳过回滚”，调用方仍必须重新执行回滚才能撤销本层。
     */
    resetRollbackCursor(floor: string): Promise<void>;
    private readRecords;
    /** 预检与执行共用同一套只读校验，任何坏游标都必须在修改批次中首个文件前被发现。 */
    private readRollbackProgress;
    /** 每次从当前日志读取序号和去重路径；其它实例追加及替换后报错都不能复用旧缓存。 */
    private loadState;
    private hasRolledBackDir;
    private doBeginFloor;
    private doRecord;
    private doRecordAfter;
    private doCommitFloor;
    private doRollbackFloor;
    /** 整批先校验；不能在撤销较新楼层后才发现较旧日志损坏。 */
    private preflightRollback;
    private doRollbackAfter;
    private doListFloors;
    private doPrune;
}
export {};
