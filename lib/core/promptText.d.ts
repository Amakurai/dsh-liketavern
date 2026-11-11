/**
 * 提示词片段拼接。
 *
 * standing / turn / 记忆 / 变化层等片段统一用空行分隔，并丢弃只含空白的片段，
 * 避免多出连续空行。assemble 与 agent 共用这一份规则。
 */
/** 去掉仅含空白的片段后以空行（`\n\n`）连接；片段本身不裁剪。 */
export declare function joinPromptParts(parts: string[]): string;
