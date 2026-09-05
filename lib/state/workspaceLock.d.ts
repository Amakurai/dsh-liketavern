export declare function withWorkspaceLock<T>(root: string, task: () => Promise<T>): Promise<T>;
