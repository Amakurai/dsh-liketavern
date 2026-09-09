/** 设置中的变量备份校验与整批恢复计划；只处理有界 JSON，沿用剧情变量的 CAS 和单批原子提交限制。 */
import { type HelperScopes, type HelperVariableChange } from './helperRuntime.js';
export declare function parseHelperVariableBackup(text: string, currentMessageId?: number): HelperScopes;
export declare function helperVariableRestoreChanges(before: HelperScopes, next: HelperScopes): HelperVariableChange[];
