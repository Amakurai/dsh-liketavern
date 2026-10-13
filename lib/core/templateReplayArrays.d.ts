/** 重放数组的严格前缀索引：按调用方提供的 JSON 指纹复用只增历史，不改动入参或跨键共享可变状态。 */
export interface TemplateReplayArrayPrefixMatch {
    index: number;
    length: number;
    suffix: unknown[];
}
export declare class TemplateReplayArrayPrefixes {
    private readonly prefixes;
    private readonly fingerprint;
    /** 指纹必须反映实际 JSON 字节，包括对象键顺序；不能按对象身份缓存可变入参。 */
    constructor(fingerprint: (value: unknown) => string);
    /** 检查点已包含旧入参，后续日志重新建立仅覆盖尾部的共享索引。 */
    clear(): void;
    remember(key: string, index: number, values: unknown[]): void;
    match(key: string, values: unknown[]): TemplateReplayArrayPrefixMatch | undefined;
}
