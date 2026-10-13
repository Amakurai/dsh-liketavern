export interface TemplateCheckpointMemory {
    segmentEnd: number;
    /** 最后活块之后只保留至少一个分配器页；所有 live 地址保持不变。 */
    memoryBytes: number;
    /** 按地址排序的 little-endian u32；分页副本先清零，再应用这些分配器元数据补丁。 */
    patches: ReadonlyArray<readonly [offset: number, value: number]>;
    freeBytes: number;
    freeChunks: number;
    zeroRanges: () => Generator<readonly [number, number]>;
}
export declare function templateCheckpointMemory(bytes: Uint8Array): TemplateCheckpointMemory | undefined;
