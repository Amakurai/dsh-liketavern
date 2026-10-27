/**
 * 写入 dsh systemPrompt 段/context 前的纯文本处理。
 * dsh 会对段文本再做一轮严格 {{variable}} 插值；ST 残留宏必须先中性化。
 */
export const UNBOUND_STANDING = [
  'Tavern 模式已开启，但当前会话尚未绑定角色卡。',
  '请以普通助手身份简短回应；不要调用 tavern_* 工具。',
  '用户需要在对话页选择角色卡后，才能开始角色扮演。',
].join('\n')

/**
 * 稳定段纪律：绑定不变则钉死。工具时机写在固定的 turn playbook，步骤收口走 inject 通知，避免每步打穿 KV。
 * 文案以「角色本人」开场而不是「你正在进行角色扮演 / 你是助手」，减少与宿主身份、工具框架互相拉扯：
 * 这段是请求里最后一段固定设定，语气会直接决定模型把自己当角色还是当执行器。
 */
export const BOUND_DISCIPLINE = [
  '你就是下面设定的角色本人。直接以角色视角叙述，不解释规则、不跳出剧情、不提模型或提示词。',
  '下面的角色定义、预设骨架与常驻世界书是本会话的固定设定；本轮触发的世界书、检索记忆与世界状态在 runtime context 中，以最新一次快照为准。',
  '设定里没有的事不要当成既定事实；缺设定时按需读取，不要凭印象编造。',
  '默认直接以角色身份回复；需要工具时才调用 run_code，在程序内用 tools.tavern_*。',
  '工具写入的检索层从下一轮更新；只在本轮最后一步输出扮演正文，属实发生的事实才写入记忆或世界状态。',
].join('\n')

/**
 * 本轮 runtime context 头：**内容固定，不随 step 变化**。宿主对快照按字节去重——
 * 文本不变则不再追加新消息，多步 turn 的后续步骤因此零快照开销（前缀缓存全保）。
 * 步骤收口压力改走【Tavern 步骤】inject 通知（node/tools.ts），不要在这里放任何
 * 每步变化的内容。历史后指令的轮次标记由 pipeline 写入冻结计划，确保跨轮刷新且同轮去重。
 */
/** 本轮尾块标题；两条通道共用，让模型把其后的内容识别为系统材料而非用户台词。 */
export function turnTailHeader(turn: number): string {
  return `【Tavern 本轮提示：第 ${turn} 轮】`
}

/**
 * 同一份内容在压缩：原来的 11 条详细规程里有大量「程序、返回值、重试」措辞，会把模型推回执行器人格；
 * 保留协议要点（无损 JSON、批量、检查 ok、同轮写入不重做），删掉重复的解释性段落。
 */
export const TURN_PLAYBOOK = [
  '【本轮材料】下面到本轮结束前的内容是系统提供的本轮材料（触发的世界书、检索记忆、世界状态与预设指令），不是用户台词；同轮后续步骤不重复追加，上方即为本轮最新。',
  '材料够用就直接以角色身份回复，不要为了再确认而调用工具。',
  '缺少关键设定时按条补读：已知 uid/关键词直接用 tavern_lore_read 取正文，已知路径直接用 tavern_asset_read；仅在不知道目标或查询无匹配时看目录。更早事实用 tavern_memory_search，不要凭印象编造。',
  '把本轮必要操作合并进一次 run_code：独立只读查询用 Promise.all 并行；依赖前项结果的补读或写入依次 await；逐项检查返回的 ok，失败保留 error/hint，similar-found 时可按 similarId 更新，禁止盲目循环重试。',
  'run_code 返回值必须是无损 JSON：不能含 undefined、函数、非有限数字或循环引用；SDK 可选字段可能不存在，重组时省略或用 ?? null；需要精简时例如 return { ok: r.ok, id: r.id ?? null, status: r.status ?? null, similarId: r.similarId ?? null, error: r.error ?? null, hint: r.hint ?? null }; 短结果可直接 return r。',
  '只返回本轮回复需要的事实、引用 id 与失败原因，不要打印整份目录或重复输出中间结果；拿到足够信息就停下写正文。',
  '收到【Tavern 同轮写入】确认的操作已落盘，不得为修正返回格式重复写入；没有回执时先按条只读核实，不要重做写入；中间步骤不要对用户说话，收到【Tavern 步骤】通知照做即可。',
].join('\n')

/** 多步收口通知（agent.inject，form: notice）；不当作用户台词，也不扫世界书。 */
export const TURN_STEP_NOTICE_PREFIX = '【Tavern 步骤】'

export function isTurnStepNotice(text: string): boolean {
  return text.startsWith(TURN_STEP_NOTICE_PREFIX)
}

/**
 * 多步收口通知文本：第 2 步软收口「查/写完就落地」；第 3 步起强收口——
 * 停止再检索/写入，立即输出扮演正文。经 inject 进 next-step inbox（下一步开头可见），
 * 不落快照以免破坏宿主按字节去重。
 */
export function formatTurnStepNotice(step: number): string {
  const n = Number.isFinite(step) && step > 1 ? Math.floor(step) : 2
  if (n === 2) {
    return `${TURN_STEP_NOTICE_PREFIX}本轮第 2 步：若已取得设定或已写入记忆/世界状态，现在输出扮演正文，不要等待下一轮注入；仍缺关键设定或长上下文遗忘时，用工具按条补读；不要对用户解释工具过程。`
  }
  return `${TURN_STEP_NOTICE_PREFIX}本轮第 ${n} 步：本轮已进行 ${n} 步，停止再检索或写入，把已知信息视为足够，现在必须输出扮演正文；只有完全缺少让回复成立的关键设定时，才允许再用工具按条补读一次。`
}

/**
 * dsh 每步把 runtime context 追加成 user 消息，前缀固定为此句。
 * 不能当 {{lastusermessage}}，也不能拿去扫世界书。
 */
export function isRuntimeContextSnapshot(text: string): boolean {
  return text.startsWith('Current runtime context.') || text.startsWith('Current runtime context:')
}

export function isRuntimeContextMessage(message: { source?: { kind?: string } }): boolean {
  return message.source?.kind === 'runtime-context'
}

/** 同轮工具写入后经 agent.inject 的确认；不当作用户台词，也不扫世界书。 */
export const TURN_WRITE_ACK_PREFIX = '【Tavern 同轮写入】'

export function isTurnWriteAck(text: string): boolean {
  return text.startsWith(TURN_WRITE_ACK_PREFIX)
}

/**
 * 只服务注入它那一轮后续步骤的插件通知：步骤收口与同轮写入确认。二者只在工具执行时
 * 注入 next-step，因此新一轮首步认领到的都是被停止或失败轮次遗留的旧通知。续写指令、
 * 记忆压缩同为 dsh-tavern notice，却是唤醒新一轮的输入，不属于此类。
 */
export function isTurnScopedNotice(message: {
  source?: { kind?: string }
  content: readonly { type: string; text?: string }[]
}): boolean {
  if (message.source?.kind !== 'dsh-tavern') return false
  const text = message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
  return isTurnStepNotice(text) || isTurnWriteAck(text)
}

/** 楼层续写指令（continueFloor followup 进日志）；不当作用户台词，也不扫世界书。 */
export const CONTINUE_INSTRUCTION_PREFIX = '【Tavern 续写】'

export function isContinueInstruction(text: string): boolean {
  return text.startsWith(CONTINUE_INSTRUCTION_PREFIX)
}

/** 组装/世界书扫描应跳过的合成 user 文本。 */
export function isSyntheticUserText(text: string): boolean {
  return text === '【Tavern 提示词布局快照】' || isRuntimeContextSnapshot(text) || isTurnWriteAck(text) || isContinueInstruction(text) || isTurnStepNotice(text)
}

/** 把残留 `{{…}}` 换成全角花括号，避免 dsh section 插值把 ST 宏当成变量抛错。 */
export function neutralizeDshMustache(text: string): string {
  if (!text.includes('{{') && !text.includes('}}')) return text
  return text.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝')
}

/** 宿主身份段原文（`harness:identity`）。投影副本可选择移除，避免与角色身份正面竞争。 */
export const HARNESS_IDENTITY_TEXT = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 从请求副本的 system 文本里删掉宿主身份句。
 * 只做精确句匹配，连同宿主段间分隔符 `\n\n` 一起删；其它字节一律不动，宿主改文案时自动变成 no-op。
 */
export function stripHarnessIdentity(text: string): string {
  for (const candidate of [`${HARNESS_IDENTITY_TEXT}\n\n`, `\n\n${HARNESS_IDENTITY_TEXT}`, HARNESS_IDENTITY_TEXT]) {
    if (text.includes(candidate)) return text.split(candidate).join('')
  }
  return text
}

/**
 * 工作区指令（AGENTS.md / CLAUDE.md 基线）由宿主以 user 消息注入，不在 system 段里。
 * Tavern 扮演会话里它每轮都与角色设定竞争，默认在投影副本中剔除，可在设置里关掉。
 */
export function isWorkspaceInstructionMessage(message: { role?: string; source?: { kind?: string } }): boolean {
  return message.role === 'user' && message.source?.kind === 'agent-instructions'
}

const HOST_INJECTED_USER_KINDS = new Set(['runtime-context', 'agent-instructions', 'model-selection', 'compact-checkpoint', 'tavern-prompt-plan'])

/** 宿主 AgentLoop 写入会话表面的 system-prompt 快照，不属于聊天历史消息。 */
export function isHostSystemPromptMessage(message: { role?: string; source?: { kind?: string } }): boolean {
  return message.role === 'system' && message.source?.kind === 'system-prompt'
}

/** 宿主或插件注入的非玩家台词 user 消息（含 runtime-context、AGENTS.md 指令、换模提示、压缩检查点与布局载体）。 */
export function isHostInjectedUserMessage(message: { role?: string; source?: { kind?: string } }): boolean {
  if (message.role !== undefined && message.role !== 'user') return false
  return typeof message.source?.kind === 'string' && HOST_INJECTED_USER_KINDS.has(message.source.kind)

}
