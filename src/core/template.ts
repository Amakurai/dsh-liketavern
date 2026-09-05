/** 模板跨隔离边界的数据契约；只接受有界 JSON，禁止原型路径与不可序列化状态。 */
import type { ChatMessage, ChatRole, WorldInfoEntry } from './types.js'
import type { TemplateMessageIdentity, TemplateMessageVariables } from './templateMessageVariables.js'

export type TemplateValue = null | boolean | number | string | TemplateValue[] | { [key: string]: TemplateValue }
export type TemplateVariables = Record<string, TemplateValue>
export interface TemplateScopes {
  global: TemplateVariables
  local: TemplateVariables
  message: TemplateVariables
}
/** ST 文本索引与宿主事件序号分开传递；swipe 只表示当前剧情内的版本，不跨兄弟剧情读取。 */
export interface TemplateMessageMetadata {
  index: number
  role: ChatRole
  name?: string
  swipeId: number
  hostMessageId?: number
}
export interface TemplateContext {
  variables: TemplateScopes
  char: string
  user: string
  card: Record<string, unknown>
  entries: WorldInfoEntry[]
  presets: Array<{ identifier: string; name: string; content: string }>
  history: ChatMessage[]
  historyIdentities?: TemplateMessageIdentity[]
  messageVariables?: TemplateMessageVariables
  now: number
  seed: number
  phase: 'generate' | 'render'
  sessionId?: string
  cardId?: string
  generationType?: string
  /** 当前宿主实际选择的模型标识，与本轮计划一起冻结；独立预览没有模型时为空。 */
  model?: string
  charAvatar?: string
  userAvatar?: string
  /** 正常回复逐条处理的文本消息元数据，顺序与 template 任务的 texts 对应。 */
  renderMessages?: TemplateMessageMetadata[]
  /** 生成阶段注册、供本轮正常回复使用的字符串替换规则；不提升为跨剧情全局规则。 */
  regexRules?: TemplateRegexDescriptor[]
  hasMessageRegex?: boolean
}
export interface TemplateRegexDescriptor {
  source: string
  flags: string
  replacement: string
  options: Record<string, string | number | boolean | null>
}
export const emptyTemplateScopes = (): TemplateScopes => ({ global: {}, local: {}, message: {} })
export const hasEjs = (text: string): boolean => text.includes('<%')

export function validateTemplateJson(value: unknown, depth = 0): asserts value is TemplateValue {
  if (depth > 48) throw new Error('模板变量嵌套超过 48 层')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || !value) throw new Error('模板变量必须是 JSON 值')
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('模板变量含禁止的原型路径')
    validateTemplateJson(item, depth + 1)
  }
}

export function parseTemplateScopes(value: unknown): TemplateScopes {
  validateTemplateJson(value)
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('模板变量状态损坏')
  for (const scope of ['global', 'local', 'message']) {
    const item = value[scope]
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`模板变量作用域损坏：${scope}`)
  }
  if (JSON.stringify(value).length > 1024 * 1024) throw new Error('模板变量超过 1 MiB 上限')
  return value as unknown as TemplateScopes
}
