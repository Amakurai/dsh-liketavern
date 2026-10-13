/** 隔离传输容纳历史、当前上下文和旧重放；重放持久化另受工作区文档的 64 MiB 边界约束。 */
export declare const TEMPLATE_INPUT_MAX_CHARS: number;
export declare const TEMPLATE_OUTPUT_MAX_CHARS: number;
export declare const TEMPLATE_REPLAY_MAX_CHARS: number;
/**
 * 精确计算 JSON.stringify 的 UTF-16 长度，遇限立即失败，不构造完整 JSON 或转义副本。
 * 输入来自纯数据边界；支持 Date，拒绝 BigInt/循环和自定义 toJSON，避免主线程执行外来代码。
 */
export declare function measureTemplateJson(value: unknown, limitChars?: number): number;
export interface TemplateExecutionBudget {
    inputChars: number;
    outputChars: number;
    workerMemoryMb: number;
    quickJsMemoryBytes: number;
    computingMs: number;
    sandboxMs: number;
}
/** 小输入保留原预算；长输入的复制、解析和重放获得线性余量，脚本不能自行延长截止时间。 */
export declare function templateExecutionBudget(inputChars: number, timeoutOverride?: number): TemplateExecutionBudget;
