/** 同一个 QuickJS 环境跨轮推进，旧闭包仍共享词法变量；当前资产、历史、时钟与变量每轮重新冻结。 */
import type { TemplateSandbox } from './templateSandbox.js';
import type { TemplateContext } from '../core/template.js';
import type { TemplateContinuation } from '../core/templateContinuation.js';
export declare function prepareContinuedTemplate(Sandbox: typeof TemplateSandbox, context: TemplateContext, value?: TemplateContinuation): Promise<TemplateSandbox>;
export declare function exportTemplateContinuation(sandbox: TemplateSandbox, context: TemplateContext, includeReplay?: boolean): TemplateContinuation;
export declare const TEMPLATE_CONTINUATION: string;
