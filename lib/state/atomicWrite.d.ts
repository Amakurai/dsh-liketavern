/** 正常写入只持有临时文件几毫秒；超过该时长的一定是崩溃遗留，清理不需要与写入互斥。 */
export declare const ORPHAN_TEMP_MAX_AGE_MS: number;
export declare function atomicWrite(path: string, data: string | Uint8Array): Promise<void>;
/**
 * 递归删除 dir 下超龄的原子写临时文件，返回删除数。不跟随链接；skipDir 以正斜杠相对路径
 * 排除整棵子树（例如由各自剧情打开时清理的 stories/）。目录不存在视为无事可做。
 */
export declare function sweepOrphanTemps(dir: string, options?: {
    now?: number;
    maxAgeMs?: number;
    skipDir?: (relDir: string) => boolean;
}): Promise<number>;
