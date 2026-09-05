import { assemblePrompt } from '../core/assemble.js';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { applyRegexRules } from '../core/regex.js';
import type { MacroContext } from '../core/types.js';
type SerializableMacros = Omit<MacroContext, 'random' | 'onUnknown'>;
export interface ComputeJobs {
    assemble: {
        input: Omit<Parameters<typeof assemblePrompt>[0], 'estimateTokens' | 'macroCtx'> & {
            macroCtx: SerializableMacros;
            seed: number;
        };
        output: ReturnType<typeof assemblePrompt>;
    };
    wi: {
        input: Omit<Parameters<typeof evaluateWorldInfo>[0], 'estimateTokens' | 'random'> & {
            seed: number;
        };
        output: ReturnType<typeof evaluateWorldInfo>;
    };
    render: {
        input: {
            text: string;
            rules: Parameters<typeof applyRegexRules>[1];
            macroCtx: SerializableMacros;
        };
        output: ReturnType<typeof applyRegexRules>;
    };
}
export {};
