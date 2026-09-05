import type { AssembledPrompt } from '../core/assemble.js';
import type { MacroContext, WorldInfoEntry } from '../core/types.js';
import type { TemplateSandbox } from './templateSandbox.js';
export declare function applyTemplatePlacements(assembled: AssembledPrompt, entries: WorldInfoEntry[], sandbox: TemplateSandbox, macroCtx: MacroContext, budget: number): AssembledPrompt;
