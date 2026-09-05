import type { ComputeJobs } from './computeWorker.js';
export declare function isolated<K extends keyof ComputeJobs>(kind: K, input: ComputeJobs[K]['input'], timeoutMs?: number): Promise<ComputeJobs[K]['output']>;
