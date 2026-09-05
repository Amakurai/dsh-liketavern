import type { AssembleInput, AssembledPrompt } from '../core/assemble.js';
import { type MacroContext } from '../core/macros.js';
import type { WorldInfoEntry } from '../core/types.js';
import type { TemplateSandbox } from './templateSandbox.js';
/** core 保留最后一条历史与稳定通道；隔离模板扩张后仍超预算时明确失败，不能靠占位成本绕过。 */
export declare function validateTemplateGenerationBudget(assembled: AssembledPrompt, budget: number): void;
/** 正则回调也使用同一轮来源缓存，主动激活重组不得重复执行变量写入。 */
export declare function createTemplateGeneration(sandbox: TemplateSandbox, entries: WorldInfoEntry[], macroCtx: MacroContext, regexCache: Map<string, string>): Pick<AssembleInput, 'renderTemplate' | 'processTemplateSequence'>;
