import type { MacroContext } from './types.js';
/** 可能在任意一轮命中的来源；正文保持引用，不复制世界书资产。 */
export interface MacroDependencySource {
    text: string;
    turnLocal: boolean;
}
export declare function createMacroDependencyTracker(initial: MacroContext, potentialSources?: readonly MacroDependencySource[]): {
    isDynamic(text: string, context: MacroContext): boolean;
    record(text: string, context: MacroContext, turnLocal: boolean): void;
};
