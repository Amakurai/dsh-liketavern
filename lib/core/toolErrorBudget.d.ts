export interface BoundedToolError {
    ok: false;
    error: string;
    errorTruncated?: boolean;
    tokensUsed?: number;
}
export declare function boundedToolError(error: string): BoundedToolError;
