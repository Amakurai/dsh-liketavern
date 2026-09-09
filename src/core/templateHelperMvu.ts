/** 模板的 MVU 只读投影：只选当前剧情可见的稳定消息身份，不制造另一份可写变量存储。 */
import { helperJson, helperRecord, type HelperScopes } from './helperRuntime.js'
import { validateTemplateJson, type TemplateVariables } from './template.js'
import type { TemplateMessageIdentity } from './templateMessageVariables.js'

export interface TemplateHelperMvu {
  version: 1
  snapshots: Record<string, TemplateVariables>
  /** 当前剧情最近有效状态，独立于宿主给模型裁剪的历史；历史 withMsg 仍只查 snapshots。 */
  current?: TemplateVariables
}
export function parseTemplateHelperMvu(value: unknown, identities: readonly TemplateMessageIdentity[]): TemplateHelperMvu {
  const parsed = helperJson(value)
  validateTemplateJson(parsed)
  if (!helperRecord(parsed) || parsed.version !== 1 || !helperRecord(parsed.snapshots)
    || parsed.current !== undefined && !helperRecord(parsed.current)
    || Object.keys(parsed).some(key => !['version', 'snapshots', 'current'].includes(key))) throw new Error('模板 MVU 只读快照无效')
  const visible = new Set(identities.map(item => item.messageId))
  for (const [id, stat] of Object.entries(parsed.snapshots)) {
    if (!visible.has(id) || !helperRecord(stat)) throw new Error('模板 MVU 包含不可见消息或无效 stat_data')
  }
  return parsed as unknown as TemplateHelperMvu
}
export function projectTemplateHelperMvu(scopes: HelperScopes, identities: readonly TemplateMessageIdentity[], current?: TemplateVariables): TemplateHelperMvu | undefined {
  const snapshots: Record<string, unknown> = {}
  for (const { messageId } of identities) {
    const data = scopes[JSON.stringify(['message', messageId])]
    if (data && helperRecord(data.stat_data)) {
      snapshots[messageId] = data.stat_data
    }
  }
  return Object.keys(snapshots).length || current !== undefined ? parseTemplateHelperMvu({ version: 1, snapshots, ...(current !== undefined ? {current} : {}) }, identities) : undefined
}
export function latestTemplateHelperMvu(value: TemplateHelperMvu | undefined, identities: readonly TemplateMessageIdentity[]): TemplateVariables | undefined {
  if(value?.current !== undefined) return value.current
  for (let index = identities.length - 1; index >= 0; index--) {
    const stat = value?.snapshots[identities[index]!.messageId]
    if (stat !== undefined) return stat
  }
  return undefined
}
