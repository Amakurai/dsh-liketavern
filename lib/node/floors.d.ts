import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionBinding } from './bindings.js';
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
export declare function sessionPrefixEvents(source: Pick<Session, 'events'>, boundaryInclusive?: number): SessionEvent[];
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
/** seed 中最大的 turn/start；空前缀表示没有继承源会话楼层。 */
export declare function inheritedThroughTurn(seed: readonly SessionEvent[]): number | null;
/** 重新生成：回滚目标楼层并重跑。messageId 指定楼层（assistant 消息 id），缺省取最后一个已关闭 turn。进行中的 turn 拒绝。 */
export declare function regenerate({ ctx, state }: FloorDeps, sessionId: string, messageId?: string): Promise<{
    childSessionId: string;
}>;
/** 回退到指定楼层：保留该楼层（含）之前的全部内容，丢弃其后的楼层；不自动续跑。 */
export declare function rollbackToFloor({ ctx, state }: FloorDeps, sessionId: string, messageId: string): Promise<{
    childSessionId: string;
}>;
/** 读取指定楼层的首条用户消息（编辑对话框预填用）。 */
export declare function getFloorUserMessage({ ctx }: FloorDeps, sessionId: string, messageId: string): Promise<{
    turn: number;
    text: string;
}>;
/** 编辑指定楼层的用户消息：回退到该楼层前并以新文本重跑。 */
export declare function editUserMessage(deps: FloorDeps, sessionId: string, messageId: string, newText: string): Promise<{
    childSessionId: string;
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
}>;
