export declare class HelperDisplayError extends Error {
    readonly code: 'busy' | 'stale' | 'timeout';
    constructor(code: 'busy' | 'stale' | 'timeout');
}
export interface HelperDisplayRequest {
    storyId: string;
    historyRevision: string;
    ids: number[] | null;
}
export interface HelperDisplayLease {
    check(): void;
    commit(): void;
    cancel(): void;
    after?(): Promise<void>;
    current?(): boolean;
}
type Driver = (request: HelperDisplayRequest, signal: AbortSignal) => Promise<HelperDisplayLease | null>;
export declare function waitHelperDisplay<T>(pending: Promise<T>, signal: AbortSignal): Promise<T>;
export declare function registerHelperDisplay(sessionId: string, driver: Driver): () => void;
export declare function prepareHelperDisplay(sessionId: string, request: HelperDisplayRequest): Promise<HelperDisplayLease>;
export {};
