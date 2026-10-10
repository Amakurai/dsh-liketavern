export interface WriteLedger {
    /** 显式作废的次数；变化时读的一方清空全部缓存。 */
    epoch: number;
    /** 单调递增的写入序号。 */
    counter: number;
    /** 文件身份 → 最近一次写入的序号。 */
    readonly files: Map<string, number>;
    /** 目录身份 → 其直接子文件最近一次写入的序号。 */
    readonly dirs: Map<string, number>;
}
/** 相对路径的身份：正斜杠、去掉空段与 `.`；Windows 上文件名不分大小写。 */
export declare function ledgerKey(relPath: string): string;
/** 读的一方打开登记；此后这个根目录下的写入才会被记录。 */
export declare function openLedger(root: string): WriteLedger;
/**
 * 记一次写入或删除。必须在落盘之后调用：先登记的话，读的一方可能在落盘前读到旧内容却记成已是最新。
 * 没有读者打开过的根目录直接忽略。
 */
export declare function noteWrite(root: string, relPath: string): void;
/** 给定序号之后，这个文件是否又被本进程写过。 */
export declare function writtenSince(ledger: WriteLedger, relPath: string, revision: number): boolean;
/** 给定序号之后，这个目录的直接子文件是否又被本进程写过。 */
export declare function dirWrittenSince(ledger: WriteLedger, relDir: string, revision: number): boolean;
