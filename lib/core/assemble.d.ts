import { type MacroContext } from './macros.js';
import { type ChatMessage, type CharacterCard, type PromptPreset, type RegexRule, type WIEngineResult, type WorldDelta } from './types.js';
export interface AssembleInput {
    preset: PromptPreset;
    card: CharacterCard | null;
    /** 当前用户人设描述（空串 = 无）。 */
    personaDescription: string;
    /** 会话历史（新的在后），含当前用户输入。 */
    history: ChatMessage[];
    /** 世界书引擎结果（null = 无世界书）。 */
    wi: WIEngineResult | null;
    /** BM25 检索到的记忆正文（已排序截断）。 */
    memories: string[];
    /** 生效中的世界状态变化层（调用方过滤 revoked/expires）。 */
    worldDeltas: WorldDelta[];
    macroCtx: MacroContext;
    regexRules: RegexRule[];
    estimateTokens: (text: string) => number;
    /** 总预算：maxTokens = 上下文窗口；reserveForOutput = 为输出保留。 */
    budget: {
        maxTokens: number;
        reserveForOutput: number;
    };
}
export interface AssembleLogEntry {
    kind: 'unknown-marker' | 'unknown-macro' | 'dropped-marker-content' | 'dropped-script' | 'auto-marker' | 'regex-error' | 'trim';
    detail: string;
}
export interface AssembledPrompt {
    /** ST 语义全量序列（含历史与注入）。 */
    messages: ChatMessage[];
    /** 角色定义 + 预设骨架 + 常驻世界书；不含关键词世界书/记忆/脚本。 */
    standing: string;
    /** 本轮世界书命中、检索记忆、变化层、作者注释。 */
    turnContext: string;
    /** standing + turnContext（预览与旧调用方）。 */
    system: string;
    /** dsh 通道之外的历史（= 输入历史经正则与裁剪后的形态，供预览）。 */
    history: ChatMessage[];
    log: AssembleLogEntry[];
    stats: {
        tokensBefore: number;
        tokensAfter: number;
        trimmedSections: string[];
    };
}
/** mes_example 按 <START> 切块（对齐 SillyTavern）。 */
export declare function splitExampleMessages(mesExample: string): string[];
export declare function assemblePrompt(input: AssembleInput): AssembledPrompt;
/** 导出一个最小可用预设（ST 默认骨架 + 本插件 marker）。 */
export declare function defaultPreset(): PromptPreset;
