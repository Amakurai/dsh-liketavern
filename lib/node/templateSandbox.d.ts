import type { TemplateReplayBootstrap } from '../core/templateContinuation.js';
import { type TemplateStickyState } from '../core/templateSticky.js';
import type { TemplateRegexSource } from './templateRegexSources.js';
import { type TemplateMessageVariables } from '../core/templateMessageVariables.js';
import { type TemplateReplay, type TemplateReplayRegexSources } from '../core/templateReplay.js';
import { type TemplateContext, type TemplateScopes, type TemplateRegexDescriptor, type TemplateMessageMetadata } from '../core/template.js';
export declare class TemplateSandbox {
    private readonly renderedSources;
    private readonly vm;
    private readonly owner;
    private readonly runtimeIdentity;
    private deadline;
    /** 本次渲染中宿主是否实际要求 QuickJS 中断；错误文字可能在中断后的清理期间变化。 */
    private deadlineInterrupted;
    private resourceChars;
    private outputInputChars;
    private computationStarted;
    private initialContext;
    private generationContext;
    private currentContext;
    private checkpoint?;
    private checkpointEligible;
    private bootstrap?;
    private recording;
    private operations;
    private operationChars;
    private shared;
    private sharedJson?;
    /** 入参键 → 当前只增文本；累积缓冲每次只追加新增后缀。 */
    private readonly sharedTexts;
    private readonly sharedArrays;
    private readonly prefixArrayKeys;
    private readonly structuredArrayKeys;
    /** 阶段 → 是否完全没有临时正则；任何非只读求值都会清空。 */
    private readonly regexStageEmpty;
    /** 每次可能运行 VM 代码的求值都会递增；@@if 末态快照仅在其后没有任何求值时作为下一条条件的起点。 */
    private vmEpoch;
    private conditionSnapshot?;
    private constructor();
    /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
    static prepare(onPhase?: (phase: 'loading' | 'computing') => void): Promise<void>;
    private static normalizeContext;
    static create(input: TemplateContext, record?: boolean, bootstrap?: TemplateReplayBootstrap, resourceChars?: number): Promise<TemplateSandbox>;
    /** 重建同轮已执行的代码和词法环境；所有输入仍由 QuickJS 求值，每步校验确定性结果。 */
    static restore(replay: TemplateReplay, context: TemplateContext): Promise<TemplateSandbox>;
    static rebuild(replay: TemplateReplay): Promise<TemplateSandbox>;
    /** 只装载本插件固定 ABI 的完整隔离堆，不执行存档携带的宿主代码，也不重新运行检查点之前的脚本。 */
    private static fromCheckpoint;
    private hash;
    private record;
    /**
     * 每个来源求值都会带上整份模拟序列和累积缓冲；逐条内联会让日志按「来源数 × 历史」增长。
     * 大型入参移入共享表，原位置留占位以保持键顺序，重放时展开成同样的字节。
     */
    private shareData;
    private shareValue;
    private shareText;
    private shareArray;
    /** 续接已有日志时恢复去重索引，后续轮次的相同入参继续复用旧项。 */
    private adoptShared;
    replay(): TemplateReplay;
    private captureCheckpoint;
    /** readonly 仅用于不改变沙箱状态的固定查询；其余求值都可能运行第三方代码并改动规则表。 */
    private evaluate;
    /** 纯 JSON 作为 QuickJS 字符串值传输，固定源码不再重复解析转义后的大历史。 */
    private evaluateInput;
    /** 同 evaluateInput，但把完成值句柄留给调用方（渲染状态必须由宿主持有，不能经全局中转）。 */
    private evaluateHandle;
    /** 只读取闭包状态；不经过模板可命名的全局，也不调用任何模板可补丁的函数。 */
    private readRenderState;
    /** 只记录实际发出的中断，不把单纯超过墙钟期限等同于中断。 */
    private interruptIfExpired;
    /** 保留真实错误；若执行时确实触发过中断，同时报告该事实，不猜测两者的因果关系。 */
    private renderFailure;
    /** 冻结宿主命令入口；对已冻结属性幂等，旧堆里的可写实现会被一并收紧。 */
    private hardenProtocol;
    /**
     * 宿主侧直接读取内部状态并在主线程比较：不再经过模板可命名的 __conditionState，
     * 也不使用 VM 内可被补丁的 JSON.stringify。vm.dump 走 JSON 语义会调用对象的 toJSON，
     * 模板可借此让快照恒定；因此 dump 后用新求值的纯语法检查遍历同一状态，带 toJSON 的状态直接拒绝。
     */
    private conditionState;
    /** 状态里的对象节点必须没有 toJSON（含原型链）或非 JSON 值，dump 的键集合才是真实的可枚举属性。 */
    private assertPlainState;
    private growResources;
    /** 受信装载结束后收紧到第三方计算预算；后续阶段（resume/继续轮）重置同一预算。 */
    private beginComputation;
    /** 精确日志命中后开始新的隔离任务；只重置执行预算，保留已验证日志所对应的词法环境。 */
    restartBudget(resourceChars: number): void;
    /** 冷暖恢复都执行相同末态校验；变量 schema 与帧同步可运行脚本，不能把这些查询当成无副作用跳过。 */
    verifyReplayState(replay: TemplateReplay): void;
    private preload;
    resume(context: TemplateContext, refreshPreload?: boolean): void;
    /** 先判定旧闭包是否全部到期；可释放日志时不能让用于清理的两条记录撞上旧预算。 */
    advanceGeneration(context: TemplateContext, refreshPreload: boolean): TemplateStickyState;
    stickyState(): TemplateStickyState;
    sticky(action: 'begin' | 'finish' | 'restore', state?: TemplateStickyState): TemplateStickyState;
    render(text: string, data?: Record<string, unknown>, source?: string): string;
    /** 重组同轮计划时只重放已求值的来源，避免 activewi 引起脚本重复写变量。 */
    renderSource(text: string, source: string, data?: Record<string, unknown>): string;
    activationRequests(): Array<{
        key: string;
        force: boolean;
    }>;
    /**
     * 这条消息在该阶段是否有临时正则。没有规则时变换恒等且不执行任何第三方代码，
     * 调用方直接沿用原文：不进入 EJS，也不留下随消息数增长的重放记录。只读查询本身不入日志。
     */
    private hasRegexStage;
    private hasRegexRules;
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
    /** basic 全包在任何消息来源求值之前完成，且只允许文本替换；一次调用保持原先逐消息的来源映射。 */
    transformBasicRegexSources(items: TemplateReplayRegexSources[], cacheNamespace: string): TemplateRegexSource[][];
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
