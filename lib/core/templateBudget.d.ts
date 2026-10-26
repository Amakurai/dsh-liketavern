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
/**
 * template：第三方 EJS 在 QuickJS 中解释执行，lodash/zod 类工作常比浏览器 V8 慢一个数量级以上，
 * 小输入也要容下整轮预加载、条件与渲染。display：output/render 展示正则只在 V8 中运行，
 * 保留短期限，灾难回溯能尽快释放槽位，不拖住整屏气泡。
 */
export type TemplateBudgetProfile = 'template' | 'display';
/** 小输入取档位基础预算；长输入的复制、解析和重放获得线性余量，脚本不能自行延长截止时间。 */
export declare function templateExecutionBudget(inputChars: number, timeoutOverride?: number, profile?: TemplateBudgetProfile): TemplateExecutionBudget;
