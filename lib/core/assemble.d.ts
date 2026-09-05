import { type MacroContext } from './macros.js';
import { type ChatMessage, type ChatRole, type CharacterCard, type PromptPreset, type RegexRule, type WIEngineResult, type WorldDelta } from './types.js';
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
    /** 会话作者注释（进 turn，不进 standing）。 */
    authorNote?: string;
    /** 角色笔记 journal.md（进 turn；调用方已按预算裁过）。 */
    journalText?: string;
    /** node worker 提供隔离模板执行器；core 本身不执行 JavaScript。 */
    renderTemplate?: (text: string, source: string, context: MacroContext) => string;
    /** worker 按完整模拟序列顺序求值；在实际正文预算裁剪前执行，core 不运行第三方代码。 */
    processTemplateSequence?: (messages: TemplateSequenceMessage[]) => {
        turnContext?: string[];
        log?: AssembleLogEntry[];
    };
    /** 临时模板正则只处理插件内容与历史模拟副本；回调由 node 的隔离器提供。 */
    transformPrompt?: (text: string, meta: {
        role: ChatRole;
        worldinfo: boolean;
        depth: number;
    }) => string;
    macroCtx: MacroContext;
    regexRules: RegexRule[];
    /**
     * ST 生成场景（injection_trigger 评估）：normal / continue / impersonate / …。
     * live 轮由 agent 面按 pendingInputs 判定（续写指令 → continue）；impersonate 走 preview。
     * 场景改变序列内容，已并入 standing 钉死指纹与钉位（standingPin.ts，粒度 = 会话 × 场景）。
     */
    generationType?: string;
    estimateTokens: (text: string) => number;
    /** 总预算：maxTokens = 上下文窗口；reserveForOutput = 为输出保留。 */
    budget: {
        maxTokens: number;
        reserveForOutput: number;
    };
}
export interface AssembleLogEntry {
    kind: 'unknown-marker' | 'unknown-macro' | 'dropped-marker-content' | 'dropped-script' | 'auto-marker' | 'regex-error' | 'trim' | 'template-placement';
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
/** 可变引用仅在本次纯函数组装内使用；历史本体的改变只进入 ST 模拟副本。 */
export interface TemplateSequenceMessage {
    message: ChatMessage;
    worldinfo: boolean;
    depth: number;
    history: boolean;
    /** 历史模拟副本保留正文处理结果；GENERATE 位置注入只加入完整 messages 序列。 */
    historyContent?: string;
    /** worker 还原的原始正文，用于区分来源占位替换与实际模板/正则修改。 */
    originalContent?: string;
}
/** mes_example 按 <START> 切块（对齐 SillyTavern）。 */
export declare function splitExampleMessages(mesExample: string): string[];
/**
 * 变化层条目本轮是否进快照渲染：无 keys = 常驻事实；有 keys = 本轮被 WI 引擎命中才注入。
 * 本函数由 assemble（渲染过滤）与 pipeline（进快照预算裁剪）共用，两处判定不得漂移。
 */
export declare function isDeltaRenderedInTurn(delta: WorldDelta, activatedDeltaIds: ReadonlySet<string>): boolean;
export declare function assemblePrompt(input: AssembleInput): AssembledPrompt;
/** 导出一个最小可用预设（ST 默认骨架 + 本插件 marker）。 */
export declare function defaultPreset(): PromptPreset;
