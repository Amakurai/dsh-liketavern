/** 展示模板在隔离 worker 内格式化；Markdown 引擎仅在 QuickJS 中运行，产物以有序片段交给安全 iframe。 */
import { type TemplateDisplayPart } from '../core/templateDisplay.js';
import type { WorldInfoEntry, MacroContext, RegexRule } from '../core/types.js';
import { type RegexApplyResult } from '../core/regex.js';
import type { DisplayRegexDiagnostics } from '../remote.js';
import type { TemplateSandbox } from './templateSandbox.js';
export declare const TEMPLATE_DISPLAY: string;
export declare function renderTemplateDisplay(text: string, entries: WorldInfoEntry[], sandbox: TemplateSandbox, meta: {
    role: string;
    worldinfo: boolean;
    depth: number;
}, decorate: boolean): {
    text: string;
    parts: TemplateDisplayPart[];
};
/** 普通正文的 worker 结果在服务边界使用同一套有界诊断，不重新执行任何展示规则。 */
export declare function collectDisplayRegexDiagnostics(errors: RegexApplyResult['errors'], rules: readonly RegexRule[]): DisplayRegexDiagnostics | undefined;
/** 已提交片段的展示正则仍在 worker 内运行；逐片段保留位置并返回可读的失败原因。 */
export declare function presentTemplateDisplayResult(parts: TemplateDisplayPart[], rules: RegexRule[], macroCtx: MacroContext): {
    parts: TemplateDisplayPart[];
    regexDiagnostics?: DisplayRegexDiagnostics;
};
/** 保留旧的纯片段投影 API；主展示链使用结果版本，把错误一并带回界面。 */
export declare function presentTemplateDisplay(parts: TemplateDisplayPart[], rules: RegexRule[], macroCtx: MacroContext): TemplateDisplayPart[];
