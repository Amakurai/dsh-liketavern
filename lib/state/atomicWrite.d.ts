/** 正常写入只持有临时文件几毫秒；超过该时长的一定是崩溃遗留，清理不需要与写入互斥。 */
export declare const ORPHAN_TEMP_MAX_AGE_MS: number;
/** 已发布角色/剧情目录不允许被草稿回收删除：它们不带点号前缀，与 `.importing-`/`.preparing-` 天然不冲突。 */
export declare const DRAFT_PREFIXES: readonly [".importing-", ".preparing-"];
export declare function atomicWrite(path: string, data: string | Uint8Array): Promise<void>;
export interface SweepOrphanTempsOptions {
    now?: number;
    maxAgeMs?: number;
    skipDir?: (relDir: string) => boolean;
    /** 只删除被扫目录本层、名字以这些前缀开头且超龄的目录（崩溃遗留的导入/分支草稿）。 */
    draftPrefixes?: readonly string[];
    /** false 时只处理被扫目录本层，不递归子树（草稿回收用）。 */
    recursive?: boolean;
}
/**
 * 递归删除 dir 下超龄的原子写临时文件，返回删除数。不跟随链接；skipDir 以正斜杠相对路径
 * 排除整棵子树（例如由各自剧情打开时清理的 stories/）。目录不存在视为无事可做。
 * `draftPrefixes` 额外回收被扫目录本层、按前缀命名且超龄的草稿目录：
 * 已发布的角色目录（cardId）与剧情目录（story-<uuid>/legacy-<hex>）不带这些前缀，绝不在删除范围内。
 */
export declare function sweepOrphanTemps(dir: string, options?: SweepOrphanTempsOptions): Promise<number>;
