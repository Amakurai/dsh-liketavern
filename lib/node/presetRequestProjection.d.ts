import type { Context } from '@deepseek-ai/cordis';
import { type GenerateOptions, type LlmResolvedModelInfo, type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { type Session } from '@deepseek-ai/dsh-session';
import { type PromptLayout } from '../core/promptLayout.js';
export declare const PRESET_PLAN_MESSAGE_TEXT = "\u3010Tavern \u63D0\u793A\u8BCD\u5E03\u5C40\u5FEB\u7167\u3011";
export interface PresetRequestPlan {
    version: 1;
    sessionId: string;
    turn: number;
    layout: PromptLayout;
    /** 宿主 tavern:standing 的完整已冻结文本，包含 BOUND_DISCIPLINE。 */
    standingText: string;
    /** 宿主 tavern:turn 的完整已冻结文本，包含 TURN_PLAYBOOK。 */
    contextText: string;
    /**
     * 缓存优先：本轮动态的历史前条目与全部深度注入改放到本轮输入之后，system 角色改由 user 承载。
     * 它们在 ST 位置上每轮变化或随历史增长移动，会让其后的整段历史失去前缀缓存。
     * 随计划冻结，同轮各步骤一致；旧计划缺省按原位置投影。
     */
    cacheFirst?: boolean;
    /** 请求副本清理开关，随计划冻结；同轮中途改设置不改变后续步骤，旧计划缺省不清理。 */
    cleanup?: PresetRequestCleanup;
}
export type PresetProjectionDiagnostic = {
    kind: 'compaction-clamp';
    messageId: string;
    summaryMessageId: string;
} | {
    kind: 'leading-system-only';
} | {
    kind: 'messages-system-layout';
} | {
    kind: 'request-cleanup';
    hideHarnessIdentity: boolean;
    droppedWorkspaceInstructions: number;
} | {
    kind: 'text-budget';
    beforeTextTokens: number;
    afterTextTokens: number;
    contextWindow?: number;
    reservedOutputTokens: number;
    availableTextTokens?: number;
    exceedsAvailable: boolean;
};
type ProjectionModel = Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'context' | 'defaultMaxTokens'>;
/** 请求副本清理：只影响这次发信，不改宿主历史、段注册与 Session 日志。 */
export interface PresetRequestCleanup {
    /** 从宿主 system 里删掉 `You are an AI agent powered by DeepSeek Harness.`，让预设独占扮演框架。 */
    hideHarnessIdentity?: boolean;
    /** 剔除宿主注入的工作区指令（AGENTS.md 基线）user 消息；Tavern 会话里它与角色设定竞争。 */
    dropWorkspaceInstructions?: boolean;
}
export interface PresetProjectionOptions {
    onDiagnostic?: (diagnostic: PresetProjectionDiagnostic) => void;
    /** 未提供时只生成逻辑布局；真实适配器必须提供本次 prepareCall 冻结的模型能力。 */
    model?: ProjectionModel;
    /** DeepSeek Messages 只允许 user/tool 之后、assistant 之前或请求末尾更新 system。 */
    messagesApi?: boolean;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'tavern-prompt-plan': {
            kind: 'tavern-prompt-plan';
            plan: PresetRequestPlan;
        };
    }
}
/** 交给 pre-step 的正常接收批次；本函数不写日志、不自行注入或创建模型调用。 */
export declare function createPresetPlanMessage(plan: PresetRequestPlan): UserMessage;
/** 在宿主已接收的最后一条用户消息附加非正文元数据；不改身份、角色、来源 kind 或任何内容块。 */
export declare function attachPresetPlanMessage(message: UserMessage, plan: PresetRequestPlan): UserMessage;
/** 接收批次及已持久化日志共用的轮次判定；存在但损坏的元数据仍明确失败。 */
export declare function hasPresetPlanMessage(message: Message, sessionId: string, turn: number): boolean;
/** 适配器边界的唯一变换：返回新请求，原请求和 Session 永远不被修改。 */
export declare function projectPresetRequest(options: Readonly<GenerateOptions>, session: Session, projection?: PresetProjectionOptions): GenerateOptions;
/** 从当前 SessionStore 读取当前轮日志；注册适配器无需捕获角色资产或可变预设状态。 */
export declare function createPresetRequestProjector(ctx: Pick<Context, 'sessions'>, projection?: Omit<PresetProjectionOptions, 'model'>): {
    project(options: Readonly<GenerateOptions>, model: ProjectionModel): GenerateOptions;
};
export {};
