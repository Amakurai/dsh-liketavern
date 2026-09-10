import type { TemplateReplayBootstrap } from '../core/templateContinuation.js';
import { type TemplateStickyState } from '../core/templateSticky.js';
import type { TemplateRegexSource } from './templateRegexSources.js';
import { type TemplateMessageVariables } from '../core/templateMessageVariables.js';
import { type TemplateReplay } from '../core/templateReplay.js';
import { type TemplateContext, type TemplateScopes, type TemplateRegexDescriptor, type TemplateMessageMetadata } from '../core/template.js';
export declare class TemplateSandbox {
    private readonly renderedSources;
    private readonly vm;
    private deadline;
    private initialContext;
    private bootstrap?;
    private recording;
    private operations;
    private operationChars;
    private constructor();
    /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
    static prepare(onPhase?: (phase: 'loading' | 'computing') => void): Promise<void>;
    private static normalizeContext;
    static create(input: TemplateContext, record?: boolean, bootstrap?: TemplateReplayBootstrap): Promise<TemplateSandbox>;
    /** 重建同轮已执行的代码和词法环境；所有输入仍由 QuickJS 求值，每步校验确定性结果。 */
    static restore(replay: TemplateReplay, context: TemplateContext): Promise<TemplateSandbox>;
    static rebuild(replay: TemplateReplay): Promise<TemplateSandbox>;
    private hash;
    private record;
    replay(): TemplateReplay;
    private evaluate;
    /** 受信装载结束后收紧到第三方计算预算；后续阶段（resume/继续轮）重置同一预算。 */
    private beginComputation;
    private preload;
    resume(context: TemplateContext, refreshPreload?: boolean): void;
    stickyState(): TemplateStickyState;
    sticky(action: 'begin' | 'finish' | 'restore', state?: TemplateStickyState): TemplateStickyState;
    render(text: string, data?: Record<string, unknown>, source?: string): string;
    /** 重组同轮计划时只重放已求值的来源，避免 activewi 引起脚本重复写变量。 */
    renderSource(text: string, source: string, data?: Record<string, unknown>): string;
    activationRequests(): Array<{
        key: string;
        force: boolean;
    }>;
    transformRegex(text: string, stage: 'generate' | 'message' | 'after', meta: {
        role: string;
        worldinfo: boolean;
        depth: number;
    }): string;
    transformRegexSources(parts: TemplateRegexSource[], stage: 'basic' | 'generate' | 'message' | 'after', meta: {
        role: string;
        worldinfo: boolean;
        depth: number;
    }, cacheNamespace: string): TemplateRegexSource[];
    regexDescriptors(): TemplateRegexDescriptor[];
    hasMessageRegex(): boolean;
    formatMessage(text: string): string;
    setMessageContext(metadata: TemplateMessageMetadata | null): {
        role: string;
        worldinfo: boolean;
        depth: number;
    };
    setOutletsDeferred(value: boolean): void;
    resolveOutlets(text: string): string;
    variables(): TemplateScopes;
    messageVariables(): TemplateMessageVariables;
    /** 条件在 WI 预算和分组前求值；拒绝写变量，避免预选阶段产生未提交或重复副作用。 */
    condition(expression: string): boolean;
    dispose(): void;
}
