/**
 * 检查点宿主通信契约与受信版本登记；实现指纹保存旧堆语义，ABI 决定当前宿主是否能继续调用它。
 * v1 固定上下文/消息身份输入、阶段切换、异步 render 收口、变量/sticky/正则/出口/格式化输出的现有形状。
 * helper 或 vendor 的兼容更新无需改 ABI；改变上述命令契约须新增适配器与 ABI，不能重跑新 bootstrap 覆盖旧闭包。
 * 这里仅做元数据兼容判定，不认证存档，也不放宽独立的 WASM、句柄、内存或 worker 安全边界。
 */
export declare const TEMPLATE_RUNTIME_ABI: "dsh-tavern-template-runtime/v1";
export type TemplateRuntimeAbi = typeof TEMPLATE_RUNTIME_ABI;
export interface TemplateRuntimeIdentity {
    readonly runtimeHash: string;
    readonly runtimeAbi: TemplateRuntimeAbi;
}
export interface TemplateRuntimeCheckpointIdentity {
    readonly runtimeHash: string;
    readonly runtimeAbi?: string;
}
/** 已核对 v1 命令契约的旧运行时；后续发布须保留仍受支持的指纹，不能信任存档自报的 ABI。 */
export declare const TEMPLATE_LEGACY_RUNTIME_ABIS: Readonly<Record<string, TemplateRuntimeAbi>>;
/** 仅登记确实需要禁止恢复的运行时；撤销优先于 current 和 legacy，不用虚构版本占位。 */
export declare const TEMPLATE_REVOKED_RUNTIME_HASHES: readonly string[];
/**
 * currentHash 必须由本地受信 bootstrap/vendor 计算，不能取自存档。
 * additionalRevokedRuntimeHashes 只增加拒绝项，供受信调用方收紧策略；无法登记新的兼容版本或解除内置撤销。
 */
export declare function resolveTemplateRuntimeIdentity(checkpoint: TemplateRuntimeCheckpointIdentity, currentHash: string, additionalRevokedRuntimeHashes?: readonly string[]): TemplateRuntimeIdentity;
