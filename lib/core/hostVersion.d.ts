export declare function safeHostRange(value: unknown): string;
/** 与较新宿主一致：显式 engines.dsh 优先；旧清单没有该字段时读取 DSH peer。 */
export declare function manifestHostRange(manifest: Record<string, unknown>): string;
export declare function hostVersionSatisfies(version: string, range: string): boolean;
