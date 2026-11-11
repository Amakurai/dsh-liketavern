import type { WalRecord } from '../core/types.js';
/** records.jsonl 单行形状（floor 由所在目录承载，行内不重复）。after/编码字段兼容旧记录。 */
export type RecordLine = Omit<WalRecord, 'floor'>;
/** 回滚恢复游标；pending 的前后镜像始终为标准 base64，null 表示文件不存在。 */
export interface RollbackProgress {
    hash: string;
    next: number;
    restored: string[];
    preserved: string[];
    pending?: {
        path: string;
        from: string | null;
        to: string | null;
    };
}
/** 独立楼层清单中的一项：楼层身份由原始 id 与开始时间共同决定。 */
export interface WalCoverageFloor {
    floor: string;
    startedAt: string;
}
/** 独立楼层清单（state/wal-coverage.json）的大小上限；运行时读写与诊断读取共用。 */
export declare const MAX_WAL_COVERAGE_BYTES: number;
/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export declare const WAL_BINARY_MARK = "binary-base64:";
/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
export declare const ROLLED_BACK_MARK = ".rolled-back-";
/** 目录名是否为回滚副本；活跃楼层名中段的同名子串不算。 */
export declare function isRolledBackDir(name: string): boolean;
/** 副本目录去掉后缀得到原楼层目录名；活跃目录原样返回。 */
export declare function baseFloorDir(name: string): string;
/** 楼层 id → 目录名：非法字符替换为 '_'（同字符冲突由调用方保证不出现）。 */
export declare function sanitizeFloor(floor: string): string;
/** Buffer 的 base64 解码会忽略坏字符和截断；必须往返一致才允许用作恢复镜像。 */
export declare function isBase64(value: unknown): value is string;
/** Windows 上大小写别名是同一个正文文件；仅用于比较，不能改写已有日志或恢复游标的 hash。 */
export declare function recordPathIdentity(path: string): string;
/** 记录路径必须是工作区内的规范相对路径（正斜杠、无盘符与 `.`/`..`/空段），且不能指向 WAL 自身。 */
export declare function isSafeWalPath(value: unknown): value is string;
/** meta.json 的最低形状：楼层 id 非空、开始时间可解析、committed 为布尔值。 */
export declare function isFloorMetaShape(value: unknown): value is {
    floor: string;
    startedAt: string;
    committed: boolean;
} & Record<string, unknown>;
/** 记录行不被接受的原因，按运行时的检查顺序给出第一个。 */
export type RecordLineIssue = 'shape' | 'seq' | 'path' | 'encoding';
/**
 * 校验已解析的一行记录。所有写入协议都从 1 连续编号；只验证递增会把丢失首条或中间行的日志误认完整，
 * 回滚后残留被漏记的事实，却已撤销其它楼层并标记成功。空白行不占序号，由调用方跳过。
 * 返回 null 表示该行可用。
 */
export declare function recordLineIssue(value: unknown, expectedSeq: number): RecordLineIssue | null;
/** 快照统一为实际字节的 base64；旧版省略 utf8 标签或使用 before 前缀也必须得到相同身份。 */
export declare function snapshotBytes(rec: RecordLine, side: 'before' | 'after'): string | null;
/** 从同一记录与撤销前正文推导恢复目标；执行与恢复游标预检共用，禁止游标自行提供新正文。 */
export declare function rollbackTarget(rec: RecordLine, current: string | null): {
    restore: true;
    value: string | null;
} | {
    restore: false;
};
/** 恢复游标不被接受的原因：整体形状、完成路径与进度、pending 形状、pending 目标。 */
export type RollbackProgressIssue = 'cursor' | 'paths' | 'pending' | 'target';
/**
 * 校验已解析的恢复游标。hash 为调用方按当前记录集合算出的身份，records 必须已逐行校验通过。
 * 完成数组必须恰好覆盖 next 之后已处理的记录；只比总数会让错路径/重复路径跳过真实修改。
 * pending 目标必须由原记录与来源正文重新推导，不能由游标自行提供。
 */
export declare function checkRollbackProgress(value: unknown, records: readonly RecordLine[], hash: string): {
    ok: true;
    progress: RollbackProgress;
} | {
    ok: false;
    reason: RollbackProgressIssue;
};
/**
 * 独立楼层清单的形状：版本、字段白名单、楼层名长度、开始时间可解析、同名楼层不重复。
 * 返回清单中的楼层数组；任何一项不合规返回 null。
 */
export declare function parseWalCoverage(value: unknown): WalCoverageFloor[] | null;
/**
 * 工作区恢复标记的解析结果：floors 只保留形状合法的楼层名，valid 表示整份标记完全符合写入格式
 * （版本、楼层与净化目录名一一对应、可选路径字段类型）。非对象一律 valid: false。
 */
export declare function parseRecoveryMarker(value: unknown): {
    floors: string[];
    bodyRoot?: string;
    valid: boolean;
};
