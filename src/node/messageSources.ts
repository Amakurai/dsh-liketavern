/** Tavern 持久消息来源：使用宿主公开的可扩展来源表，不借用已移除的通用 plugin 来源。 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-tavern': { kind: 'dsh-tavern' } & ContextFormed
  }
}

/** 旧剧情中的 plugin 来源仍是合法持久数据，续写检查必须兼容，不能绕过未处理片段。 */
export function isTavernNotice(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const value = source as Record<string, unknown>
  return value.form === 'notice' && (value.kind === 'dsh-tavern'
    || value.kind === 'plugin' && value.plugin === 'dsh-tavern')
}
