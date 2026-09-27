/**
 * 开场白日志判定：assistant/message 不翻转 dsh 的 blank（只看 turn/start）。
 * 空白会话一旦被写入开场白，英雄区（含模式选择）会因可见内容消失，
 * 「新对话」却仍复用该会话，表现为永远卡在 Tavern。
 */
export interface GreetingLogEvent {
    type: string;
    data?: unknown;
}
/** ensureGreeting / swipeGreeting 写入的开场白来源标记。 */
export declare const TAVERN_GREETING_SOURCE: {
    readonly provider: "dsh-tavern";
    readonly model: "greeting";
};
export declare function isTavernGreetingEvent(event: GreetingLogEvent): boolean;
/** 仍算 blank（无 turn/start）但已经有本插件开场白，会被「新对话」复用且藏掉英雄区。 */
export declare function isGreetingOnlyBlank(events: readonly GreetingLogEvent[]): boolean;
export declare function sessionHasUserMessage(events: readonly GreetingLogEvent[]): boolean;
/**
 * 开场白变体列表（greetingIndex 的唯一下标口径，服务端、英雄区、chip 与卡面桥必须共用）。
 * 对齐 ST getFirstMessage：first_mes 为空而有备选开场白时，第一条备选即开场白，空 first_mes 不占位；
 * 否则空 first_mes 会让会话既没有开场白楼层、也无从 swipe 到备选。
 */
export declare function cardGreetingVariants(firstMes: string, alternateGreetings: readonly string[]): string[];
/**
 * 绑定下标 → 实际展示的变体下标。编辑角色卡删掉备选开场白后旧会话仍可能带着越界下标：
 * 一律回退 0（不夹到末尾），正文、翻页计数、卡面 swipe_id 与 MVU 初始化必须共用这一口径。
 */
export declare function activeGreetingIndex(index: number, count: number): number;
/**
 * 按绑定下标取开场白。空串 / 纯空白不算有开场白（不偷偷改用别的变体，以免和 swipe 下标错位）。
 * 下标越界时回退到变体 0。
 */
export declare function pickGreetingText(variants: readonly string[], index: number): string | undefined;
export interface GreetingFloorState {
    /** 这条 assistant 消息是本插件写入的开场白（会话里第一条 assistant/message）。 */
    isGreeting: boolean;
    /** 对话已开始（有 user/message）之后不能再 swipe。 */
    started: boolean;
    swipe: {
        index: number;
        total: number;
    } | null;
}
/**
 * 开场白楼层判定：只有「第一条 assistant 消息且来源是本插件 greeting」才算开场白。
 * 对话开始后仍识别为开场白（好让 UI 藏掉重新生成/编辑），但 swipe 为 null。
 */
export declare function greetingFloorState(events: readonly GreetingLogEvent[], messageId: string, greetingIndex: number, variantCount: number): GreetingFloorState;
