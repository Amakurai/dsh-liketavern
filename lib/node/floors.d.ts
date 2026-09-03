import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session';
import { type SiblingSwipe } from '../core/siblings.js';
import { type SessionBinding, type WalLineageEntry } from './bindings.js';
import type { TavernState } from './state.js';
export interface FloorDeps {
    ctx: Context;
    state: TavernState;
}
export declare class FloorError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * 子会话的模型路由：官方 session.fork 会传入 agentOptions + 安装 model selection。
 * 本插件在 create 后立刻 followup，来不及等 UI 再装 selection，必须在 create 时写上
 * provider/model，否则 system-prompt 插值 `{{model}}` 会抛「has no value」。
 *
 * 优先会话最新 request/header（用户中途换模也跟得上），其次父 agent.options，
 * 再次最近一条非开场白 assistant 的 source。
 */
export declare function forkAgentOptions(parent: Pick<Agent, 'options'> | undefined, source: Session): AgentOptions;
/** 切到 boundaryInclusive（含）为止的前缀；-1 / 空日志得到空数组（重跑第一层时 turn/start 在 seq 0）。 */
export declare function sessionPrefixEvents(events: readonly SessionEvent[], boundaryInclusive?: number): SessionEvent[];
/**
 * 楼层定位：messageId（assistant 消息 id）优先，其次直接按 turn 号。
 * 被中断的 assistant 消息不进宿主的 assistant-actions slot（非 finalized），
 * 中断楼层的操作条由 chat.node 渲染侧按 turn 号定位补挂。
 */
export declare function resolveFloorTurn(events: readonly SessionEvent[], messageId?: string, turn?: number): number | null;
/**
 * 取指定会话 turn >= fromTurn 的 WAL 楼层。
 *
 * WalManager.rollbackAfter 会在内部按数组逆序回放，因此这里必须按 turn 数字升序传入；
 * 不能先 reverse，也不能使用字符串排序（t10 会排在 t2 前面）。
 */
export declare function floorNamesForRollback(floors: readonly string[], sessionId: string, fromTurn: number, throughTurn?: number): string[];
/**
 * 当前会话与 fork 祖先中属于本分支的 WAL 楼层，按 turn 升序交给 rollbackAfter。
 * 同 turn 时祖先在前、当前会话在后，逆放时仍是较新的分支写入先撤销。
 */
export declare function floorNamesForLineageRollback(floors: readonly string[], binding: Pick<SessionBinding, 'walLineage'>, sessionId: string, fromTurn: number): string[];
/** 回退边界属于哪个会话；walLineage 按根祖先 → 直接父会话排列。 */
export declare function timerOwnerAtTurn(binding: Pick<SessionBinding, 'walLineage'>, currentSessionId: string, boundaryTurn: number): string;
/**
 * 子会话的 WAL 世系：在祖先条目后追加源会话边界。
 * 保留的祖先条目必须 clamp 到新 seed 实际继承的边界——回退 fork 只继承 throughTurn
 * 之前的楼层，不 clamp 会让 timerOwnerAtTurn 用陈旧边界命中未继承的祖先定时器。
 * throughTurn === null（空 seed，未继承任何楼层）时祖先内容同样未继承，整条世系丢弃。
 */
export declare function childWalLineage(binding: Pick<SessionBinding, 'walLineage'>, sourceId: string, throughTurn: number | null): WalLineageEntry[];
/** seed 中最大的 turn/start；空前缀表示没有继承源会话楼层。 */
export declare function inheritedThroughTurn(seed: readonly SessionEvent[]): number | null;
/** 分支操作结果：子会话 id + 建议标题（客户端经 sessions.rename 落到会话列表）。 */
export interface ForkResult {
    childSessionId: string;
    /** 分支会话的可读标题，如「角色名 · 从第 3 层重生成」。 */
    title: string;
}
/** 重新生成：回滚目标楼层并重跑。messageId（assistant 消息 id）或 floorTurn 指定楼层，都缺省取最后一个已关闭 turn。进行中的 turn 拒绝。 */
export declare function regenerate({ ctx, state }: FloorDeps, sessionId: string, messageId?: string, floorTurn?: number): Promise<ForkResult>;
/** 回退到指定楼层：保留该楼层（含）之前的全部内容，丢弃其后的楼层；不自动续跑。messageId 与 floorTurn 至少给其一。 */
export declare function rollbackToFloor({ ctx, state }: FloorDeps, sessionId: string, messageId?: string, floorTurn?: number): Promise<ForkResult>;
/** 读取指定楼层的首条用户消息（编辑对话框预填用）。 */
export declare function getFloorUserMessage({ ctx }: FloorDeps, sessionId: string, messageId: string): Promise<{
    turn: number;
    text: string;
}>;
/** 编辑指定楼层的用户消息：回退到该楼层前并以新文本重跑。 */
export declare function editUserMessage(deps: FloorDeps, sessionId: string, messageId: string, newText: string): Promise<ForkResult>;
/**
 * 把 seed 里指定 assistant 消息的正文替换为编辑后文本（新消息 id，保留原模型 source）。
 * 事件本体深冻，这里浅拷一层换 data.message；找不到返回 null。
 */
export declare function withEditedAssistantMessage(events: readonly SessionEvent[], messageId: string, newText: string): SessionEvent[] | null;
/** 读取指定楼层 assistant 消息的正文（编辑对话框预填用）。 */
export declare function getFloorAssistantMessage({ ctx }: FloorDeps, sessionId: string, messageId: string): Promise<{
    turn: number;
    text: string;
}>;
/**
 * 编辑指定楼层的 assistant 正文：fork 到该楼层结束（seed 内替换该条消息），
 * 回滚其后楼层，不自动续跑——编辑 AI 台词后通常由用户自己接话。
 */
export declare function editAssistantMessage(deps: FloorDeps, sessionId: string, messageId: string, newText: string): Promise<ForkResult>;
/**
 * 楼层继续：最后一条 assistant 回复被截断（或用户认为不完整）时，不产生新的用户台词，
 * 直接以一条合成指令（CONTINUE_INSTRUCTION_PREFIX，isSyntheticUserText 过滤）驱动画前会话续写。
 * 续写不改历史，因此不 fork、不回滚 WAL；续写轮自身是正常 turn（楼层 WAL 照常 beginFloor）。
 * 只允许续最后一个已关闭 turn 的楼层，避免在历史中间续出分叉语义。
 */
export declare function continueFloor({ ctx, state }: FloorDeps, sessionId: string, messageId: string): Promise<{
    continued: boolean;
}>;
/** 角色的全部开场白变体（0 = first_mes）。 */
export declare function greetingVariants(state: TavernState, cardId: string): Promise<string[]>;
/**
 * 把「只有开场白、从未 turn/start」的会话标成已开聊，这样「新对话」不会再复用它。
 * dsh 的 blank 只看 turn/start；assistant/message 不够。不要在 inbox/inserted 热路径调用：
 * agent loop 马上会自己 append turn/start，抢号会把当轮打崩。
 */
export declare function retireGreetingOnlyBlankSession(session: Session, ctx?: Context): boolean;
/** 开场白楼层的 swipe / 是否问候楼层；其它 assistant 消息 isGreeting = false。 */
export declare function getGreetingSwipe({ ctx, state }: FloorDeps, sessionId: string, messageId: string): Promise<{
    swipe: {
        index: number;
        total: number;
    } | null;
    isGreeting: boolean;
    started: boolean;
}>;
/**
 * 同一楼层分支会话的兄弟导航（ST 式 ‹ n/m ›）：读取 siblings.json 索引，
 * 按存在性过滤已删除/悬空的分支（live 会话直接算数；离线的以绑定文件是否还在为准——
 * dsh 不向插件暴露历史会话目录，绑定文件是插件侧最可靠的存在性信号；删卡/解绑会清绑定）。
 * 剪枝有变化就顺手落盘。非 Tavern / 未绑定 / 无兄弟记录一律软返回 swipe=null。
 */
export declare function getFloorSiblings({ ctx, state }: FloorDeps, sessionId: string, messageId?: string, floorTurn?: number): Promise<{
    swipe: (SiblingSwipe & {
        turn: number;
    }) | null;
}>;
/**
 * 选卡进入对话：把开场白写进一轮完整 turn（start/step/message/end），
 * 聊天区才能露出封面，工具栏才会挂在这条开场白下面。「新对话」也不会再复用。
 * inbox 热路径仍走 ensureGreeting，避免和 agent loop 抢 turn 号。
 */
export declare function enterGreetingConversation({ ctx, state }: FloorDeps, sessionId: string): Promise<boolean>;
/**
 * 确保会话有开场白：会话尚无任何 assistant 消息时，把当前 greetingIndex 对应的
 * 开场白作为 turn 0 的 assistant 消息追加进日志。已有则返回 false。
 */
export declare function ensureGreeting({ ctx, state }: FloorDeps, sessionId: string): Promise<boolean>;
/**
 * 开场白 swipe：用指定变体编成 seed 后 fork。不要 create 空会话再 enterGreetingConversation——
 * 那会和刚启动的 agent loop 抢 append，打开子会话历史会 Failed to fetch。
 * 会话已有后续楼层时拒绝（swipe 只适用于开场白还是最后一条消息的场景）。
 */
export declare function swipeGreeting({ ctx, state }: FloorDeps, sessionId: string, index: number): Promise<{
    childSessionId: string;
    index: number;
    title: string;
}>;
