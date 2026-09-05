import { type TemplateContinuation } from '../core/templateContinuation.js';
import type { TemplateContext } from '../core/template.js';
import { type TemplateStickyState } from '../core/templateSticky.js';
import type { TemplateState } from './template.js';
export declare function templatePreloadRevision(context: TemplateContext): string;
export declare function templateStickyHasClosures(state: TemplateStickyState): boolean;
export declare function parseTemplateContinuation(value: unknown): TemplateContinuation;
/** 仅在当前剧情内解析引用；不会因为回执缺失而重新执行某个旧生成阶段。 */
export declare function resolveTemplateContinuation(stored: TemplateState): TemplateContinuation | undefined;
/** 关闭 prepared 回执前保留仍活跃的共享词法环境；不存在回调时释放日志，计数与过期状态继续保留。 */
export declare function closeTemplateGenerationState(stored: TemplateState, status: 'completed' | 'terminated'): void;
