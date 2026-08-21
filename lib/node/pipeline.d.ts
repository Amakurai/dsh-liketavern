/**
 * 组装管线：绑定 + 工作区 + 预设 + 世界书/记忆/变化层 + 正则 → AssembledPrompt。
 *
 * 世界书引擎按「每 turn 只评估一次」使用（定时器以消息数为单位，多步 turn 内复用缓存），
 * 只有每轮首次评估（live 模式）才持久化新的定时状态——经 WorkspaceFs 写入，
 * 因而落入当前楼层 WAL，可随回退/swipe 回滚。
 * 每步仍重新组装 standing/turn：长上下文下靠最新 runtime context 快照重放本轮世界书/记忆，
 * 遗忘则按条用工具补读，而不是跳过组装。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm';
import { type AssembledPrompt } from '../core/assemble.js';
import type { ChatMessage, WorldDelta, WorldInfoEntry } from '../core/types.js';
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
    /** 角色定义 + 预设骨架（写入 system 段，绑定不变则字节级稳定）。 */
    standing: string;
    /** 本轮世界书/记忆/变化层（写入 runtime context，不进 system 前缀）。 */
    turnContext: string;
    /** standing + turnContext（预览用）。 */
    system: string;
    /** ST 语义全量序列（预览用）。 */
    messages: ChatMessage[];
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
export declare function loadBoundLoreEntries(state: TavernState, binding: NonNullable<Awaited<ReturnType<TavernState['loadBinding']>>>): Promise<{
    entries: WorldInfoEntry[];
    deltas: WorldDelta[];
}>;
/** 组装一次 Tavern 提示词。绑定缺失或角色不存在时返回 null。 */
export declare function runTavernPipeline(input: PipelineInput): Promise<PipelineResult | null>;
