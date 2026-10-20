/**
 * 组装管线：绑定 + 工作区 + 预设 + 世界书/记忆/变化层 + 正则 → AssembledPrompt。
 *
 * 世界书引擎按「每 turn 只评估一次」使用（定时器以消息数为单位，多步 turn 内复用缓存），
 * 只有每轮首次评估（live 模式）才持久化新的定时状态——经 WorkspaceFs 写入，
 * 因而落入当前楼层 WAL，可随回退/swipe 回滚。
 * preview（预览提示词 / 代答）用空定时器评估，既不读也不写该缓存，见下方 cacheable。
 * 首次成功组装后冻结整轮计划；每步仍把同一份 standing/turn 安装到宿主组装结果，
 * 遗忘则按条用工具补读，而不是跳过组装。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm';
import { type AssembledPrompt } from '../core/assemble.js';
import type { ChatMessage, WorldDelta, WorldInfoEntry } from '../core/types.js';
import type { PromptLayout } from '../core/promptLayout.js';
import { type TemplateContext } from '../core/template.js';
import type { TemplateReplay } from '../core/templateReplay.js';
import type { TavernState } from './state.js';
export interface PipelineInput {
    state: TavernState;
    sessionId: string;
    /** 会话历史来源；preview 模式可传 null 并给 historyOverride。 */
    agent: Agent | null;
    /** 用于解析上下文窗口；缺失或解析失败回退 128K。 */
    llm?: LlmRuntime;
    mode: 'live' | 'preview';
    /** preview 且无 live agent 时的历史（纯文本）。 */
    historyOverride?: ChatMessage[];
    /**
     * ST 生成场景（injection_trigger 评估），缺省 'normal'。
     * 续写轮由 agent 面探测合成续写指令后传 'continue'；impersonate 传 'impersonate'。
     */
    generationType?: string;
}
export interface PipelineResult {
    /** 首次组装的布局偏好；旧持久计划缺省保留原位置，不读取升级后的当前设置。 */
    cacheFirstLayout?: boolean;
    /** 本轮冻结的模板输入；回复处理只使用这份资产与时钟快照。 */
    templateContext?: TemplateContext;
    templateReplay?: TemplateReplay;
    standingKey: string;
    sampling: import('../core/types.js').SamplingSettings;
    /** 角色定义 + 预设骨架（写入 system 段，绑定不变则字节级稳定）。 */
    standing: string;
    /** 本轮世界书/记忆/变化层（写入 runtime context，不进 system 前缀）。 */
    turnContext: string;
    /** standing + turnContext（预览用）。 */
    system: string;
    /** ST 语义全量序列（预览用）。 */
    messages: ChatMessage[];
    /** 已冻结的预设布局；真实历史由适配器按消息身份保留。 */
    layout?: PromptLayout;
    /** 入模历史（经正则与预算裁剪后）。 */
    history: ChatMessage[];
    assembled: AssembledPrompt;
    logLines: string[];
    /** 当前 {{user}} 展示名；改名后须打穿 standing 钉死。 */
    userName: string;
    personaDescription: string;
    personaLorebookId: string | null;
    wiBudget: {
        limit: number;
        used: number;
        overflowed: boolean;
    };
}
/** deriveMessages 拍平：只取 text 块拼成纯文本；空消息丢弃。 */
export declare function flattenMessages(messages: readonly Message[], charName: string, userName: string): ChatMessage[];
/** 聊天世界书损坏时的可见诊断文案（组装路径直接失败；展示/工具路径降级并回传标记）。 */
export declare const CHAT_BOOK_CORRUPT_MESSAGE = "\u804A\u5929\u4E16\u754C\u4E66\u635F\u574F\uFF0C\u672C\u6B21\u672A\u6CE8\u5165\uFF1Aassets/chat-lorebook.json\uFF1B\u8BF7\u5728\u9762\u677F\u4FEE\u590D\u6216\u5220\u9664\u540E\u91CD\u8BD5";
export interface BoundLoreEntries {
    entries: WorldInfoEntry[];
    deltas: WorldDelta[];
    /** 聊天世界书损坏且按 report 降级跳过；组装路径（throw）不会返回 true。 */
    chatBookCorrupt: boolean;
}
/**
 * 读取绑定世界书。
 * 聊天世界书损坏时：组装/模型输入路径必须显式失败（默认 'throw'，与 getChatLorebook 口径一致）；
 * 只读展示与工具路径传 'report'，跳过整本书但用 chatBookCorrupt 标记与「这本书本来就是空的」区分。
 */
export declare function loadBoundLoreEntries(state: TavernState, binding: NonNullable<Awaited<ReturnType<TavernState['loadBinding']>>>, options?: {
    onCorruptChatBook?: 'throw' | 'report';
}): Promise<BoundLoreEntries>;
/** 组装一次 Tavern 提示词。绑定缺失或角色不存在时返回 null。 */
export declare function runTavernPipeline(input: PipelineInput): Promise<PipelineResult | null>;
