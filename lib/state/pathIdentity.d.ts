/** Windows 上转小写，其它平台原样返回。 */
export declare function caseIdentity(value: string): string;
/** 根目录身份：先 resolve 成绝对路径，再按平台折叠大小写。 */
export declare function rootIdentity(root: string): string;
export interface FileStatStamp {
    mtimeMs: number;
    size: number;
}
/** 文件 mtimeMs 与字节长度一致判定（同时为 null 也视为相同）。 */
export declare function sameFileStat(a: FileStatStamp | null, b: FileStatStamp | null): boolean;
