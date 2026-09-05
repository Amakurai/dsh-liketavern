/** 展示模板在隔离 worker 内格式化；真实 Showdown 仅在 QuickJS 中运行，产物以有序片段交给安全 iframe。 */
import { type TemplateDisplayPart } from '../core/templateDisplay.js';
import type { WorldInfoEntry, MacroContext, RegexRule } from '../core/types.js';
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
/** 已提交片段的展示正则仍在 worker 内运行；逐片段保留角色卡框和正文位置。 */
export declare function presentTemplateDisplay(parts: TemplateDisplayPart[], rules: RegexRule[], macroCtx: MacroContext): TemplateDisplayPart[];
