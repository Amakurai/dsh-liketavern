/**
 * 写入 dsh systemPrompt 段/context 前的纯文本处理。
 * dsh 会对段文本再做一轮严格 {{variable}} 插值；ST 残留宏必须先中性化。
 */
export declare const UNBOUND_STANDING: string;
/**
 * 稳定段纪律：绑定不变则钉死。工具时机写在固定的 turn playbook，步骤收口走 inject 通知，避免每步打穿 KV。
 * 文案以「角色本人」开场而不是「你正在进行角色扮演 / 你是助手」，减少与宿主身份、工具框架互相拉扯：
 * 这段是请求里最后一段固定设定，语气会直接决定模型把自己当角色还是当执行器。
 */
export declare const BOUND_DISCIPLINE: string;
/**
 * 本轮 runtime context 头：**内容固定，不随 step 变化**。宿主对快照按字节去重——
 * 文本不变则不再追加新消息，多步 turn 的后续步骤因此零快照开销（前缀缓存全保）。
 * 步骤收口压力改走【Tavern 步骤】inject 通知（node/tools.ts），不要在这里放任何
 * 每步变化的内容。历史后指令的轮次标记由 pipeline 写入冻结计划，确保跨轮刷新且同轮去重。
 */
/** 本轮尾块标题；两条通道共用，让模型把其后的内容识别为系统材料而非用户台词。 */
export declare function turnTailHeader(turn: number): string;
/**
 * 同一份内容在压缩：原来的 11 条详细规程里有大量「程序、返回值、重试」措辞，会把模型推回执行器人格；
 * 保留协议要点（无损 JSON、批量、检查 ok、同轮写入不重做），删掉重复的解释性段落。
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
export declare function isRuntimeContextMessage(message: {
    source?: {
        kind?: string;
    };
}): boolean;
/** 同轮工具写入后经 agent.inject 的确认；不当作用户台词，也不扫世界书。 */
export declare const TURN_WRITE_ACK_PREFIX = "\u3010Tavern \u540C\u8F6E\u5199\u5165\u3011";
export declare function isTurnWriteAck(text: string): boolean;
/**
 * 只服务注入它那一轮后续步骤的插件通知：步骤收口与同轮写入确认。二者只在工具执行时
 * 注入 next-step，因此新一轮首步认领到的都是被停止或失败轮次遗留的旧通知。续写指令、
 * 记忆压缩同为 dsh-tavern notice，却是唤醒新一轮的输入，不属于此类。
 */
export declare function isTurnScopedNotice(message: {
    source?: {
        kind?: string;
    };
    content: readonly {
        type: string;
        text?: string;
    }[];
}): boolean;
/** 楼层续写指令（continueFloor followup 进日志）；不当作用户台词，也不扫世界书。 */
export declare const CONTINUE_INSTRUCTION_PREFIX = "\u3010Tavern \u7EED\u5199\u3011";
export declare function isContinueInstruction(text: string): boolean;
/** 组装/世界书扫描应跳过的合成 user 文本。 */
export declare function isSyntheticUserText(text: string): boolean;
/** 把残留 `{{…}}` 换成全角花括号，避免 dsh section 插值把 ST 宏当成变量抛错。 */
export declare function neutralizeDshMustache(text: string): string;
/** 宿主身份段原文（`harness:identity`）。投影副本可选择移除，避免与角色身份正面竞争。 */
export declare const HARNESS_IDENTITY_TEXT = "You are an AI agent powered by DeepSeek Harness.";
/**
 * 从请求副本的 system 文本里删掉宿主身份句。
 * 只做精确句匹配，连同宿主段间分隔符 `\n\n` 一起删；其它字节一律不动，宿主改文案时自动变成 no-op。
 */
export declare function stripHarnessIdentity(text: string): string;
/**
 * 工作区指令（AGENTS.md / CLAUDE.md 基线）由宿主以 user 消息注入，不在 system 段里。
 * Tavern 扮演会话里它每轮都与角色设定竞争，默认在投影副本中剔除，可在设置里关掉。
 */
export declare function isWorkspaceInstructionMessage(message: {
    role?: string;
    source?: {
        kind?: string;
    };
}): boolean;
/** 宿主或插件注入的非玩家台词 user 消息（含 runtime-context、AGENTS.md 指令、换模提示、压缩检查点与布局载体）。 */
export declare function isHostInjectedUserMessage(message: {
    role?: string;
    source?: {
        kind?: string;
    };
}): boolean;
