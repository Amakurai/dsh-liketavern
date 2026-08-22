/**
 * 写入 dsh systemPrompt 段/context 前的纯文本处理。
 * dsh 会对段文本再做一轮严格 {{variable}} 插值；ST 残留宏必须先中性化。
 */
export const UNBOUND_STANDING = [
    'Tavern 模式已开启，但当前会话尚未绑定角色卡。',
    '请以普通助手身份简短回应；不要调用 tavern_* 工具。',
    '用户需要在对话页选择角色卡后，才能开始角色扮演。',
].join('\n');
/** 稳定段纪律：绑定不变则钉死。工具时机写在固定的 turn playbook，步骤收口走 inject 通知，避免每步打穿 KV。 */
export const BOUND_DISCIPLINE = [
    '你正在进行角色扮演。下面是本会话稳定的角色定义与提示词骨架。',
    '本轮触发的世界书、检索记忆与世界状态在 runtime context 中，会覆盖更早的同名快照；不要把未出现的条目当成事实。',
    '默认直接以角色身份回复。只在缺设定、或要把本轮已确定的事实写入长期记忆/世界状态时，才使用 tavern_* 工具。',
    '只在本轮最后一步输出扮演正文；中间步骤不要对用户说话。记忆只记事实、关键事件与关系/状态变化，禁止流水账。',
    '工具写入的检索层从下一轮更新；同轮会收到写入确认。写完后仍须在本轮输出扮演正文。',
].join('\n');
/**
 * 本轮 runtime context 头：**内容固定，不随 step 变化**。宿主对快照按字节去重——
 * 文本不变则不再追加新消息，多步 turn 的后续步骤因此零快照开销（前缀缓存全保）。
 * 步骤收口压力改走【Tavern 步骤】inject 通知（node/tools.ts），不要在这里放任何
 * 每步/每轮易变的内容（步骤号、时钟、随机宏均属此类）。
 */
export const TURN_PLAYBOOK = [
    '【本轮】runtime context 已含触发的世界书、检索记忆与世界状态；同轮后续步骤不重复追加，上方快照即为本轮最新。',
    '够用就直接以角色身份回复，不要为了再确认而调用工具。',
    '缺设定再用 tavern_lore_read（先目录，再 uid/关键词取条）/ tavern_memory_search / tavern_asset_read。',
    '长对话若设定被冲掉，按条补读，不要整本倾倒。',
    '本轮确定发生的事实才写入记忆或世界状态；写入从下一轮才注入检索层，同轮会收到写入确认。',
    '中间步骤不要对用户说话；需要收口时会收到【Tavern 步骤】通知，照做即可。',
].join('\n');
/** 多步收口通知（agent.inject，form: notice）；不当作用户台词，也不扫世界书。 */
export const TURN_STEP_NOTICE_PREFIX = '【Tavern 步骤】';
export function isTurnStepNotice(text) {
    return text.startsWith(TURN_STEP_NOTICE_PREFIX);
}
/**
 * 多步收口通知文本：第 2 步软收口「查/写完就落地」；第 3 步起强收口——
 * 停止再检索/写入，立即输出扮演正文。经 inject 进 next-step inbox（下一步开头可见），
 * 不落快照以免破坏宿主按字节去重。
 */
export function formatTurnStepNotice(step) {
    const n = Number.isFinite(step) && step > 1 ? Math.floor(step) : 2;
    if (n === 2) {
        return `${TURN_STEP_NOTICE_PREFIX}本轮第 2 步：若已取得设定或已写入记忆/世界状态，现在输出扮演正文，不要等待下一轮注入；仍缺关键设定或长上下文遗忘时，用工具按条补读；不要对用户解释工具过程。`;
    }
    return `${TURN_STEP_NOTICE_PREFIX}本轮第 ${n} 步：本轮已进行 ${n} 步，停止再检索或写入，把已知信息视为足够，现在必须输出扮演正文；只有完全缺少让回复成立的关键设定时，才允许再用工具按条补读一次。`;
}
/**
 * dsh 每步把 runtime context 追加成 user 消息，前缀固定为此句。
 * 不能当 {{lastusermessage}}，也不能拿去扫世界书。
 */
export function isRuntimeContextSnapshot(text) {
    return text.startsWith('Current runtime context.') || text.startsWith('Current runtime context:');
}
/** 同轮工具写入后经 agent.inject 的确认；不当作用户台词，也不扫世界书。 */
export const TURN_WRITE_ACK_PREFIX = '【Tavern 同轮写入】';
export function isTurnWriteAck(text) {
    return text.startsWith(TURN_WRITE_ACK_PREFIX);
}
/** 楼层续写指令（continueFloor followup 进日志）；不当作用户台词，也不扫世界书。 */
export const CONTINUE_INSTRUCTION_PREFIX = '【Tavern 续写】';
export function isContinueInstruction(text) {
    return text.startsWith(CONTINUE_INSTRUCTION_PREFIX);
}
/** 组装/世界书扫描应跳过的合成 user 文本。 */
export function isSyntheticUserText(text) {
    return isRuntimeContextSnapshot(text) || isTurnWriteAck(text) || isContinueInstruction(text) || isTurnStepNotice(text);
}
/** 把残留 `{{…}}` 换成全角花括号，避免 dsh section 插值把 ST 宏当成变量抛错。 */
export function neutralizeDshMustache(text) {
    if (!text.includes('{{') && !text.includes('}}'))
        return text;
    return text.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝');
}
