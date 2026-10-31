export declare const DRAFT_RECOVERY_SCOPE_LIMIT = 16;
export interface DraftRecoveryRecord {
    serialized?: string;
    unavailable?: boolean;
    error?: string;
}
export declare class DraftRecoveryChannel {
    readonly holders: Set<object>;
    readonly weak: WeakRef<this>;
    generation: number;
    pending: DraftRecoveryRecord | undefined;
}
export declare class DraftRecoveryTooLargeError extends Error {
}
/** 在加载编辑器前预留槽位；已持有未确认记录的分区即使预算满了也能重开修复。 */
export declare function acquireDraftRecovery(remote: object, key: string, holder: object): DraftRecoveryChannel | null;
export declare function releaseDraftRecovery(remote: object, key: string, channel: DraftRecoveryChannel, holder: object): void;
export declare function stageDraftRecovery(channel: DraftRecoveryChannel, serialized: string): DraftRecoveryRecord;
export declare function failDraftRecovery(channel: DraftRecoveryChannel, record: DraftRecoveryRecord, message: string): void;
/** 超限或无法编码时只保留上一份有界快照并明确标记失败，不能将旧内容伪装为最新恢复。 */
export declare function unavailableDraftRecovery(channel: DraftRecoveryChannel, message: string, fallback?: string): void;
export declare function confirmDraftRecovery(remote: object, key: string, channel: DraftRecoveryChannel, record: DraftRecoveryRecord): void;
/** 确认只作用于仍在显示的失败标记；别的编辑器提交了更新快照时，旧确认不能清掉它。 */
export declare function restorePreviousDraftRecovery(remote: object, key: string, channel: DraftRecoveryChannel, record: DraftRecoveryRecord): void;
