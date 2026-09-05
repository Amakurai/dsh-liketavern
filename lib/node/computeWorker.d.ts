import { assemblePrompt } from '../core/assemble.js';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { applyRegexRules } from '../core/regex.js';
import type { MacroContext } from '../core/types.js';
import type { TemplateContext, TemplateScopes, TemplateRegexDescriptor } from '../core/template.js';
import type { TemplateReplay } from '../core/templateReplay.js';
import type { TemplateMessageVariables } from '../core/templateMessageVariables.js';
import type { TemplateDisplayPart } from '../core/templateDisplay.js';
import type { TemplateContinuation } from '../core/templateContinuation.js';
type SerializableMacros = Omit<MacroContext, 'random' | 'onUnknown'>;
export interface ComputeJobs {
    assemble: {
        input: Omit<Parameters<typeof assemblePrompt>[0], 'estimateTokens' | 'macroCtx' | 'renderTemplate' | 'transformPrompt'> & {
            macroCtx: SerializableMacros;
            seed: number;
            templates?: TemplateContext;
            templateContinuation?: TemplateContinuation;
            wiEvaluation?: ComputeJobs['wi']['input'];
        };
        output: ReturnType<typeof assemblePrompt> & {
            templateVariables?: TemplateScopes;
            templateMessageVariables?: TemplateMessageVariables;
            templateRegexRules?: TemplateRegexDescriptor[];
            templateHasMessageRegex?: boolean;
            templateReplay?: TemplateReplay;
            templateContinuation?: TemplateContinuation;
            evaluatedWi?: ReturnType<typeof evaluateWorldInfo>;
            deltaDropped?: number;
        };
    };
    wi: {
        input: Omit<Parameters<typeof evaluateWorldInfo>[0], 'estimateTokens' | 'random'> & {
            seed: number;
            templates?: TemplateContext;
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
    template: {
        input: {
            texts: string[];
            context: TemplateContext;
            decorateOutput?: boolean;
            replay?: TemplateReplay;
            templateContinuation?: TemplateContinuation;
        };
        output: {
            texts: string[];
            parts: TemplateDisplayPart[][];
            variables: TemplateScopes;
            messageVariables: TemplateMessageVariables;
            templateContinuation?: TemplateContinuation;
        };
    };
    display: {
        input: {
            parts: TemplateDisplayPart[];
            rules: Parameters<typeof applyRegexRules>[1];
            macroCtx: SerializableMacros;
        };
        output: {
            parts: TemplateDisplayPart[];
        };
    };
}
export {};
