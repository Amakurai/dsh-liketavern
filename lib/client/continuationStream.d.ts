import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client';
export declare function useContinuationStream(source: SessionEventSource | undefined, turn: number | undefined, seq: number | undefined, text: string): {
    text: string;
    error?: undefined;
} | {
    text: string;
    error: string;
};
