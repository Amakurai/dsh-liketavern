/**
 * 写入 dsh systemPrompt 段/context 前的纯文本处理。
 * dsh 会对段文本再做一轮严格 {{variable}} 插值；ST 残留宏必须先中性化。
 */
export declare const UNBOUND_STANDING: string;
/** 稳定段纪律：绑定不变则钉死。工具时机写在固定的 turn playbook，步骤收口走 inject 通知，避免每步打穿 KV。 */
export declare const BOUND_DISCIPLINE: string;
/**
 * 本轮 runtime context 头：**内容固定，不随 step 变化**。宿主对快照按字节去重——
 * 文本不变则不再追加新消息，多步 turn 的后续步骤因此零快照开销（前缀缓存全保）。
 * 步骤收口压力改走【Tavern 步骤】inject 通知（node/tools.ts），不要在这里放任何
 * 每步/每轮易变的内容（步骤号、时钟、随机宏均属此类）。
 */
export declare const TURN_PLAYBOOK: string;
/** 多步收口通知（agent.inject，form: notice）；不当作用户台词，也不扫世界书。 */
export declare const TURN_STEP_NOTICE_PREFIX = "\u3010Tavern \u6B65\u9AA4\u3011";
export declare function isTurnStepNotice(text: string): boolean;
/**
 * 多步收口通知文本：第 2 步软收口「查/写完就落地」；第 3 步起强收口——
 * 停止再检索/写入，立即输出扮演正文。经 inject 进 next-step inbox（下一步开头可见），
 * 不落快照以免破坏宿主按字节去重。
 */
export declare function formatTurnStepNotice(step: number): string;
/**
 * dsh 每步把 runtime context 追加成 user 消息，前缀固定为此句。
 * 不能当 {{lastusermessage}}，也不能拿去扫世界书。
 */
export declare function isRuntimeContextSnapshot(text: string): boolean;
/** 同轮工具写入后经 agent.inject 的确认；不当作用户台词，也不扫世界书。 */
export declare const TURN_WRITE_ACK_PREFIX = "\u3010Tavern \u540C\u8F6E\u5199\u5165\u3011";
export declare function isTurnWriteAck(text: string): boolean;
/** 楼层续写指令（continueFloor followup 进日志）；不当作用户台词，也不扫世界书。 */
export declare const CONTINUE_INSTRUCTION_PREFIX = "\u3010Tavern \u7EED\u5199\u3011";
export declare function isContinueInstruction(text: string): boolean;
/** 组装/世界书扫描应跳过的合成 user 文本。 */
export declare function isSyntheticUserText(text: string): boolean;
/** 把残留 `{{…}}` 换成全角花括号，避免 dsh section 插值把 ST 宏当成变量抛错。 */
export declare function neutralizeDshMustache(text: string): string;
