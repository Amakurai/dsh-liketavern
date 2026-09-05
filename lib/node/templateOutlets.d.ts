/** 延迟命名注入：QuickJS 内收集后展开，worker 最后统一处理提示词通道并重新核对体积。 */
import type { AssembledPrompt } from '../core/assemble.js';
/** 仅识别固定文本前缀；宿主不得执行用户正则或注入正文。 */
export declare function containsTemplateOutlet(text: string): boolean;
/** 置于 TEMPLATE_HELPERS 后；只在同一 QuickJS 上下文读取命名列表，不再次执行 EJS 或后处理回调。 */
export declare const TEMPLATE_OUTLETS: string;
/** 调用者必须在所有来源和定位注入已收敛后调用；预算检查通过前不得导出或提交模板变量。 */
export declare function finalizeTemplateOutlets<T extends AssembledPrompt>(assembled: T, sandbox: {
    resolveOutlets(text: string): string;
}, budget: number): T;
