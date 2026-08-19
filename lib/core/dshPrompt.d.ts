/**
 * 写入 dsh systemPrompt 段/context 前的纯文本处理。
 * dsh 会对段文本再做一轮严格 {{variable}} 插值；ST 残留宏必须先中性化。
 */
export declare const UNBOUND_STANDING: string;
/** 稳定段纪律：绑定不变则钉死。工具时机与本轮步骤写在 turn playbook，避免每步打穿 KV。 */
export declare const BOUND_DISCIPLINE: string;
/**
 * 本轮 runtime context 头：随 step 变化，不得写入 standing。
 * 第一步鼓励「够用就演」；第二步「查/写完就收口」；第三步起强收口——
 * 多步拖沓时停止再检索/写入，立即落地扮演正文。
 */
export declare function formatTurnPlaybook(step: number): string;
/**
 * dsh 每步把 runtime context 追加成 user 消息，前缀固定为此句。
 * 不能当 {{lastusermessage}}，也不能拿去扫世界书。
 */
export declare function isRuntimeContextSnapshot(text: string): boolean;
/** 同轮工具写入后经 agent.inject 的确认；不当作用户台词，也不扫世界书。 */
export declare const TURN_WRITE_ACK_PREFIX = "\u3010Tavern \u540C\u8F6E\u5199\u5165\u3011";
export declare function isTurnWriteAck(text: string): boolean;
/** 组装/世界书扫描应跳过的合成 user 文本。 */
export declare function isSyntheticUserText(text: string): boolean;
/** 把残留 `{{…}}` 换成全角花括号，避免 dsh section 插值把 ST 宏当成变量抛错。 */
export declare function neutralizeDshMustache(text: string): string;
