import type { HelperSnapshot } from './helperRuntime.js';
export interface HelperMvuJob {
    id: string;
    kind: 'initialize' | 'update';
    seq: number;
    identity: string;
    text: string;
    turn: number;
    floor: string;
}
export interface HelperMvuReceipt {
    id: string;
    identity: string;
    kind: 'initialize' | 'update';
    digest: string;
    valueDigest: string;
    floor: string;
}
export interface HelperMvuState {
    version: 1;
    initialized: boolean;
    pending: HelperMvuJob[];
    completed: HelperMvuReceipt[];
    lastIdentity?: string;
}
export interface HelperMvuInitialSource {
    name: string;
    role?: 'global' | 'character';
    entries: {
        uid: string;
        comment: string;
        content: string;
    }[];
}
export interface HelperMvuWork {
    storyId: string;
    enabled: boolean;
    status: 'idle' | 'pending' | 'waiting';
    job?: HelperMvuJob;
    token?: string;
    base?: Record<string, unknown>;
    initialSources?: HelperMvuInitialSource[];
    greeting?: string;
    swipeId?: number;
    awaitingTurnEnd?: boolean;
    snapshot?: HelperSnapshot;
    applyText?: boolean;
    completed?: {
        id: string;
        digest: string;
    }[];
}
export declare function parseHelperMvuState(value: unknown): HelperMvuState;
/** 最终消息表必须保留 stat_data；临时内部指针不能进入正文/WAL，其他可序列化扩展数据仍由原变量表契约验证。 */
export declare function helperMvuData(value: unknown): Record<string, unknown>;
