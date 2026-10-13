/** 固定 QuickJS 引擎的持久堆映像契约；主线程仅检查有界头部，解压及实际恢复始终留在隔离 worker。 */
export declare const TEMPLATE_CHECKPOINT_ENGINE: "quickjs-emscripten@0.32.0/release-sync";
export declare const TEMPLATE_CHECKPOINT_WASM_HASH = "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";
export declare const TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES: number;
/** 现有 QuickJS 活跃分配上限为 512 MiB，另留 256 MiB 给 WASM 静态区、分配器和增长余量。 */
export declare const TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES: number;
export declare const TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES: number;
export declare const TEMPLATE_CHECKPOINT_PAGE_BYTES = 65536;
export declare const TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES: number;
export interface TemplateCheckpointVmHandles {
    runtime: number;
    context: number;
    uint32: number;
    global: number;
    undefined: number;
    null: number;
    false: number;
    true: number;
}
export interface TemplateCheckpointVmImage {
    version: 1 | 2;
    engine: typeof TEMPLATE_CHECKPOINT_ENGINE;
    wasmHash: string;
    memoryBytes: number;
    memoryHash: string;
    /** 每个固定 64 KiB WASM 页独立 gzip/base64；v2 用 null 表示全零页，旧 v1 仍只接受字符串。 */
    payload: Array<string | null>;
    handles: TemplateCheckpointVmHandles;
}
export declare function parseTemplateCheckpointVmImage(value: unknown): TemplateCheckpointVmImage;
