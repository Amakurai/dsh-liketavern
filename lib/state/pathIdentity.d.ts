/** Windows 上转小写，其它平台原样返回。 */
export declare function caseIdentity(value: string): string;
/** 根目录身份：先 resolve 成绝对路径，再按平台折叠大小写。 */
export declare function rootIdentity(root: string): string;
