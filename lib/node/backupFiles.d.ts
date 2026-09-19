import { type Stats } from 'node:fs';
export declare const BACKUP_LIMITS: {
    entries: number;
    depth: number;
    fileBytes: number;
    totalBytes: number;
    manifestBytes: number;
    pathBytes: number;
};
export declare class BackupError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function fail(code: string): never;
export declare function errorCode(error: unknown): string | undefined;
export declare function safeRelative(path: unknown): path is string;
export declare function checkedPath(root: string, path: string): string;
/** 包括传入根的祖先，避免中间的 junction 把显式目录解析到其它数据树。 */
export declare function assertDirectory(path: string): Promise<void>;
export declare function assertAbsent(path: string): Promise<void>;
export declare function assertSeparate(left: string, right: string): void;
export interface BackupEntry {
    path: string;
    kind: 'file' | 'directory';
    size: number;
    mode: number;
    sha256?: string;
}
export interface ScannedEntry extends BackupEntry {
    stamp: Stats;
}
/** 与宿主 app-boot 的共享 fallback、profile 私有 pnpm/投影目录保持同一精确布局。 */
export declare function isDependencyPath(path: string): boolean;
export declare function inventory(root: string, excludedDependencies?: string[]): Promise<ScannedEntry[]>;
/** 固定位置分块读取，完整检查前后文件身份；输出文件独占创建且同步后关闭。 */
export declare function transferFile(root: string, entry: BackupEntry, destination?: string): Promise<string>;
export declare function boundedJson(path: string, maxBytes?: number): Promise<unknown>;
export declare function createDirectories(root: string, entries: BackupEntry[]): Promise<void>;
/** 失败草稿可能已经套用源目录的只读权限；仅在自有、无链接草稿内恢复清理所需权限。 */
export declare function discardTemporary(root: string): Promise<void>;
