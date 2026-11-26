import { type BigIntStats } from 'node:fs';
export declare const BACKUP_LIMITS: {
    entries: number;
    depth: number;
    fileBytes: number;
    totalBytes: number;
    manifestBytes: number;
    pathBytes: number;
};
export interface BackupIssueSummary {
    code: string;
    severity: 'info' | 'warning' | 'error';
    count: number;
}
export declare class BackupError extends Error {
    readonly code: string;
    readonly issues?: BackupIssueSummary[];
    constructor(code: string, issues?: readonly BackupIssueSummary[]);
}
export declare function fail(code: string, issues?: readonly BackupIssueSummary[]): never;
export declare function safeRelative(path: unknown): path is string;
export declare function checkedPath(root: string, path: string): string;
export interface DirectoryCheckOptions {
    /** 限制链接检查仅从该边界目录向下进行（允许宿主数据根之上的合法系统挂载/符号链接，如 macOS /var -> /private/var）。 */
    boundary?: string;
    /** 可选已验目录集合；传入可变 Set 时同时回填已验证目录以消除重复 lstat。 */
    verified?: Set<string> | ReadonlySet<string>;
}
/** 包括传入根的祖先（或指定 boundary 向下），避免中间的 junction 把显式目录解析到其它数据树。 */
export declare function assertDirectory(path: string, options?: ReadonlySet<string> | DirectoryCheckOptions): Promise<void>;
/** Windows 的 libuv lstat 对目录和文件统一合成 0o666（缺目录 +x 且全员可写）；归一化为可移植私有 POSIX 权限位。 */
export declare function portableMode(kind: 'file' | 'directory', rawMode: number, platform?: NodeJS.Platform): number;
export declare function ancestorChainAbove(root: string): Set<string>;
export declare function assertAbsent(path: string): Promise<void>;
export declare function assertSeparate(left: string, right: string): void;
export interface BackupEntry {
    path: string;
    kind: 'file' | 'directory';
    size: number;
    mode: number;
    sha256?: string;
    hardlinkGroup?: number;
}
export interface ScannedEntry extends BackupEntry {
    stamp: BigIntStats;
    expectedNlink: number;
}
/** 与宿主 app-boot 的共享 fallback、profile 私有 pnpm/投影目录保持同一精确布局。 */
export declare function isDependencyPath(path: string): boolean;
export declare function inventory(root: string, excludedDependencies?: string[]): Promise<ScannedEntry[]>;
/** 固定位置分块读取，完整检查前后文件身份；输出文件独占创建且同步后关闭。 */
export declare function transferFile(root: string, entry: BackupEntry, destination?: string, verifiedAboveRoot?: ReadonlySet<string>, options?: {
    expectedNlink?: number;
    deferChmod?: boolean;
}): Promise<string>;
export declare function boundedJson(path: string, maxBytes?: number, options?: ReadonlySet<string> | DirectoryCheckOptions): Promise<unknown>;
/** 会话迁移读原始字节：限额在读取前后都生效，并复核句柄与目录项仍为同一普通文件。 */
export declare function boundedBytes(path: string, maxBytes: number, options?: ReadonlySet<string> | DirectoryCheckOptions): Promise<Buffer>;
export declare function createDirectories(root: string, entries: BackupEntry[]): Promise<void>;
/** 失败草稿可能已经套用源目录的只读权限或内部硬链接；仅在自有、无外链草稿内恢复清理所需权限。 */
export declare function discardTemporary(root: string): Promise<void>;
