import type { ComputeJobs } from './computeWorker.js';
/** 只报告缓存数量，不暴露剧情内容；也供隔离与故障回归确认是否走过冷恢复。 */
export declare function isolatedWorkerStats(): {
    workersStarted: number;
    cacheHits: number;
    idle: number;
    active: number;
};
/** 可显式释放空闲计算资源；正在运行的任务仍由各自期限管理。 */
export declare function disposeIdleComputeWorkers(): Promise<void>;
export declare function isolated<K extends keyof ComputeJobs>(kind: K, input: ComputeJobs[K]['input'], timeoutMs?: number): Promise<ComputeJobs[K]['output']>;
