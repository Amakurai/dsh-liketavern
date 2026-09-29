/** 持久消息来源的纯判定：兼容当前与旧剧情中的 Tavern notice，供宿主和只读展示共用。 */
export function isTavernNotice(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const value = source as Record<string, unknown>
  return value.form === 'notice' && (value.kind === 'dsh-tavern'
    || value.kind === 'plugin' && value.plugin === 'dsh-tavern')
}
