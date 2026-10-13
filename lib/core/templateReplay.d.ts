/** 模板运行的持久恢复契约：完整隔离堆检查点加真实操作尾部，保留词法闭包而不单独序列化函数源码。 */
import type { TemplateContext, TemplateScopes, TemplateMessageMetadata } from './template.js';
import type { TemplateReplayBootstrap } from './templateContinuation.js';
import type { TemplateStickyState } from './templateSticky.js';
import type { TemplateCheckpointVmImage } from './templateCheckpoint.js';
import { type TemplateReplayJsonShared } from './templateReplayShared.js';
/** 入参对共享表的引用：整数取整项，二元组取共享文本的前 length 个码元或数组的前 length 项。 */
export type TemplateReplayRef = number | [index: number, length: number];
/** 多次求值共用的只读入参：旧整项继续支持；变化的 JSON 按有序页复用，累积缓冲和历史保留前缀。 */
export type TemplateReplayShared = {
    value: unknown;
} | {
    text: string[];
} | {
    array: unknown[];
} | TemplateReplayJsonShared;
/** 来源正则的可序列化消息参数；basic 批次没有回调，generate 保持逐来源交错。 */
export interface TemplateReplayRegexMeta {
    role: string;
    worldinfo: boolean;
    depth: number;
}
export interface TemplateReplayRegexSource {
    key: string;
    text: string;
    start: number;
}
export interface TemplateReplayRegexSources {
    parts: TemplateReplayRegexSource[];
    meta: TemplateReplayRegexMeta;
}
export type TemplateReplayInstruction = {
    kind: 'render';
    text: string;
    data: Record<string, unknown>;
    source?: string;
    refs?: Record<string, TemplateReplayRef>;
} | {
    kind: 'regexSources';
    stage: 'basic' | 'generate' | 'message' | 'after';
    meta: TemplateReplayRegexMeta;
    namespace: string;
    data: Record<string, unknown>;
    refs?: Record<string, TemplateReplayRef>;
} | {
    kind: 'regexSourcesBatch';
    namespace: string;
    data: Record<string, unknown>;
    refs?: Record<string, TemplateReplayRef>;
} | {
    kind: 'regex';
    text: string;
    stage: 'generate' | 'message' | 'after';
    meta: {
        role: string;
        worldinfo: boolean;
        depth: number;
    };
} | {
    kind: 'variables';
} | {
    kind: 'outlets';
    text: string;
} | {
    kind: 'deferOutlets';
    value: boolean;
} | {
    kind: 'phase';
    context: TemplateContext;
    refreshPreload: boolean;
} | {
    kind: 'phaseData';
    data: Record<string, unknown>;
    refs?: Record<string, TemplateReplayRef>;
    refreshPreload: boolean;
} | {
    kind: 'message';
    metadata: TemplateMessageMetadata | null;
} | {
    kind: 'format';
    text: string;
} | {
    kind: 'messageVariables';
} | {
    kind: 'sticky';
    action: 'begin' | 'finish' | 'restore';
    state?: TemplateStickyState;
};
export type TemplateReplayOperation = TemplateReplayInstruction & {
    hash: string;
};
export type TemplateReplayDataInstruction = Extract<TemplateReplayInstruction, {
    data: Record<string, unknown>;
}>;
/** 完整隔离堆覆盖此前操作；上下文元数据继续供归属与消息可见性校验，不能代替堆中的词法环境。 */
export interface TemplateReplayCheckpoint {
    version: 1;
    runtimeHash: string;
    /** 宿主与已保存 VM 的命令/数据协议；缺省为旧检查点，须通过受信运行时登记解析。 */
    runtimeAbi?: string;
    image: TemplateCheckpointVmImage;
    context: TemplateContext;
    outputInputChars: number;
    resourceChars: number;
}
export interface TemplateReplay {
    version: 2;
    /** 缺省表示旧 Showdown；可读取备份，但活动日志必须在旧版本完成或回滚，禁止静默迁移闭包。 */
    formatterVersion?: 2;
    context: TemplateContext;
    operations: TemplateReplayOperation[];
    /** 来源及阶段的共享入参只保存一次；缺省表示全部内联，旧日志照常重放。 */
    shared?: TemplateReplayShared[];
    variables: TemplateScopes;
    messageVariablesHash: string;
    bootstrap?: TemplateReplayBootstrap;
    /** 固定运行时的持久检查点；operations/shared 只保存检查点之后的尾部。 */
    checkpoint?: TemplateReplayCheckpoint;
}
export declare const TEMPLATE_REPLAY_LIMIT: number;
/** 低于该长度的入参直接内联；引用和占位本身也占字节。 */
export declare const TEMPLATE_REPLAY_SHARE_MIN = 256;
/** 单轮历史与仍存活闭包均占用资源；执行预算由冻结输入决定，不截断活动闭包。 */
export declare const TEMPLATE_REPLAY_LIMIT_HINT = "\u51BB\u7ED3\u5386\u53F2\u6216\u4ECD\u5B58\u6D3B\u7684\u6A21\u677F\u95ED\u5305\u8D85\u8FC7\u5B89\u5168\u8D44\u6E90\u5BB9\u91CF\uFF0C\u8BF7\u538B\u7F29\u5386\u53F2\uFF0C\u6216\u4ECE\u8F83\u65E9\u697C\u5C42\u56DE\u9000/\u521B\u5EFA\u5206\u652F\u540E\u7EE7\u7EED";
export declare function measureTemplateReplay(value: unknown): number;
/**
 * 压缩减少存储字节，不减少重新执行次数。按引用的逻辑入参累计授予恢复预算，
 * 每个共享项只计量一次；前缀使用完整项大小作保守上界，不展开历史或创建重复 JSON。
 */
export declare function measureTemplateReplayWork(replay: TemplateReplay): number;
/** 外显哈希不覆盖闭包中的隐式格式化捕获，旧引擎的活动日志必须先在旧版本完成或回滚。 */
export declare function assertTemplateReplayFormatter(replay: Pick<TemplateReplay, 'formatterVersion'>): void;
export declare function templateReplayGenerationContext(replay: TemplateReplay): TemplateContext;
/** 最近任意阶段用于提交态核验；指定 generate 时用于冻结资产与生成归属，不能混用两个含义。 */
export declare function templateReplayLatestContext(replay: TemplateReplay, phase?: TemplateContext['phase']): TemplateContext;
/** 共享表来自存储边界：每项只能是单一形状，文本分段必须是字符串。 */
export declare function parseTemplateReplayShared(value: unknown): TemplateReplayShared[];
/** 直接正则指令不经过 EJS；记录、读取和重放共用来源形状及单消息边界。 */
export declare function parseTemplateReplayRegexParts(value: unknown, checked?: WeakSet<object>): TemplateReplayRegexSource[];
export declare function parseTemplateReplayRegexBatch(value: unknown, checked?: WeakSet<object>): TemplateReplayRegexSources[];
/**
 * 校验全部引用后返回展开函数。占位保留原键顺序，展开结果与记录时传给模板的入参逐字节一致；
 * 展开只在重放时逐条进行，日志本身不保存重复内容。
 */
export declare function templateReplayData(replay: Pick<TemplateReplay, 'operations' | 'shared'>): (operation: TemplateReplayDataInstruction) => Record<string, unknown>;
