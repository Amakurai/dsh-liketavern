/**
 * SillyTavern 预设（Prompt Manager）JSON ⇄ PromptPreset。
 *
 * ST 预设形态：{prompts: [...], prompt_order: [{character_id, order: [{identifier, enabled}]}]}。
 * `prompts` 是条目库；真正的栈与开关在 prompt_order 里。Chat Completion 用 dummy
 * character_id 100001（openai.js）；PromptManager 构造默认曾是 100000，社区预设常同时带着
 * 一份只含内建槽位的 100000 骨架——导入必须优先 100001，不能取数组第一项。
 * 未列入所选 order 的库条目关闭并附在栈末，记一条摘要（不逐条 warning）。
 * 无 prompt_order 时全部启用。relative 条目的 order 取自栈序；in-chat 仍用 injection_order。
 * `forbid_overrides` / `extension` / `injection_trigger` 归一化进 PresetEntry
 * （forbidOverrides / extension / injectionTrigger），导出时带回；
 * 运行时语义见 assemble（forbid_overrides 拒绝卡级覆盖、injection_trigger 按生成场景过滤）。
 * `extensions.regex_scripts` 原样挂到 PromptPreset.regexScripts（编译在 rulesFor）。
 *
 * 导入硬上限与世界书（lorebook.ts）同口径：条目数 / 单条正文 / identifier 长度超限，
 * 或 content 字段类型非法，一律在归一化时抛中文错误拒绝导入——统一拒绝口径，不做静默截断。
 */
import { MAX_WI_KEY_CHARS } from '../core/worldbook.js'
import type { CardRegexScript, ChatRole, PresetEntry, PromptPreset } from '../core/types.js'
import { MAX_LOREBOOK_CONTENT_CHARS, MAX_LOREBOOK_ENTRIES } from './lorebook.js'
import { pickRegexScripts } from './card.js'

export interface ParseStPresetResult {
  preset: PromptPreset
  warnings: string[]
}

/** 导出时 prompt_order 的 character_id（对齐 SillyTavern Chat Completion dummy）。 */
const EXPORT_CHARACTER_ID = 100001

/** 选取 prompt_order 时的优先 dummy id：100001（现行）→ 100000（旧默认）。 */
const PREFERRED_CHARACTER_IDS = [EXPORT_CHARACTER_ID, 100000]

interface OrderItem {
  identifier: string
  enabled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function toNum(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0' || s === '') return false
  }
  if (value === null || value === undefined) return fallback
  return Boolean(value)
}

/** role 以条目自身 role 为准；缺省时 system_prompt=true 才回落 system。 */
function toRole(raw: Record<string, unknown>): ChatRole {
  if (raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system') return raw.role
  if (toBool(raw.system_prompt, false)) return 'system'
  return 'system'
}

/** prompt_order 的 folder 摊平：嵌套层级设硬上限（恶意深嵌套会撑爆调用栈），超限拒绝导入。 */
const MAX_PROMPT_ORDER_DEPTH = 16

function flattenOrderItems(items: unknown[], depth = 0): OrderItem[] {
  if (depth > MAX_PROMPT_ORDER_DEPTH) {
    throw new Error(`prompt_order 嵌套层级超过上限（${MAX_PROMPT_ORDER_DEPTH}），拒绝导入`)
  }
  const out: OrderItem[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const identifier = toStr(item.identifier)
    if (identifier !== '') out.push({ identifier, enabled: toBool(item.enabled, true) })
    if (Array.isArray(item.items)) out.push(...flattenOrderItems(item.items, depth + 1))
  }
  return out
}

/**
 * 选出应对齐 ST Prompt Manager 的那份 order。
 * 有 prompt_order 但解析不出任何项 → 空数组（全关）；字段缺失 → null（全开）。
 */
function pickPromptOrder(promptOrder: unknown): OrderItem[] | null {
  if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null
  const blocks: { id: number; items: OrderItem[] }[] = []
  for (const block of promptOrder) {
    if (!isRecord(block) || !Array.isArray(block.order)) continue
    const items = flattenOrderItems(block.order)
    if (items.length === 0) continue
    blocks.push({ id: toNum(block.character_id, Number.NaN), items })
  }
  if (blocks.length === 0) return []
  for (const id of PREFERRED_CHARACTER_IDS) {
    const hit = blocks.find((b) => b.id === id)
    if (hit) return hit.items
  }
  return blocks.reduce((best, cur) => (cur.items.length > best.items.length ? cur : best)).items
}

function collectPromptEmbeddedRegex(rawPrompts: unknown[]): CardRegexScript[] {
  const out: CardRegexScript[] = []
  for (const raw of rawPrompts) {
    if (!isRecord(raw)) continue
    const content = toStr(raw.content).trim()
    if (!content.startsWith('{') || !content.includes('RegexBinding')) continue
    try {
      const parsed = JSON.parse(content) as { RegexBinding?: { regexes?: unknown } }
      const regexes = parsed.RegexBinding?.regexes
      if (!Array.isArray(regexes)) continue
      for (const item of regexes) {
        if (isRecord(item) && typeof item.findRegex === 'string' && item.findRegex) {
          out.push(item as CardRegexScript)
        }
      }
    } catch {
      // 条目正文不是 JSON
    }
  }
  return out
}

function parsePromptEntry(raw: Record<string, unknown>, index: number, warnings: string[]): PresetEntry | null {
  const identifier = toStr(raw.identifier)
  if (identifier === '') {
    warnings.push(`prompts[${index}] 缺少 identifier，已跳过`)
    return null
  }
  // 导入硬上限（与世界书同口径，统一拒绝）：identifier 长度 / content 类型与长度
  if (identifier.length > MAX_WI_KEY_CHARS) {
    throw new Error(`预设条目 prompts[${index}] 的 identifier 超过 ${MAX_WI_KEY_CHARS} 字符上限，拒绝导入`)
  }
  if (raw.content !== undefined && raw.content !== null && typeof raw.content === 'object') {
    throw new Error(`预设条目 prompts[${index}]（${identifier}）的 content 不是字符串，拒绝导入`)
  }
  const marker = toBool(raw.marker, false)
  const position: PresetEntry['position'] = toNum(raw.injection_position, 0) === 1 ? 'in-chat' : 'relative'
  const entry: PresetEntry = {
    identifier,
    name: toStr(raw.name) || identifier,
    enabled: true,
    role: toRole(raw),
    position,
    depth: toNum(raw.injection_depth, 4),
    order: toNum(raw.injection_order, 100),
    content: toStr(raw.content),
    marker,
  }
  if (entry.content.length > MAX_LOREBOOK_CONTENT_CHARS) {
    throw new Error(`预设条目 prompts[${index}]（${identifier}）的正文超过 ${MAX_LOREBOOK_CONTENT_CHARS} 字符上限，拒绝导入`)
  }
  if (marker) entry.markerId = identifier
  // ST 三个原忽略字段：归一化进条目，导出时带回
  if (toBool(raw.forbid_overrides, false)) entry.forbidOverrides = true
  if (toBool(raw.extension, false)) entry.extension = true
  if (Array.isArray(raw.injection_trigger)) {
    const triggers = raw.injection_trigger.map((t) => toStr(t).trim().toLowerCase()).filter((t) => t !== '')
    if (triggers.length > 0) entry.injectionTrigger = triggers
  }
  return entry
}

/** relative 条目用栈序（×10）；in-chat 保留 injection_order。 */
function assignRelativeOrder(entries: PresetEntry[]): void {
  entries.forEach((entry, index) => {
    if (entry.position !== 'in-chat') entry.order = (index + 1) * 10
  })
}

/**
 * 解析 ST 预设 JSON。缺 prompts 数组时抛中文错误；
 * 无法映射的条目不中断导入，记入 warnings。
 */
export function parseStPreset(json: unknown): ParseStPresetResult {
  if (!isRecord(json)) throw new Error('预设文件不是有效的 JSON 对象')
  if (!Array.isArray(json.prompts)) throw new Error('预设文件缺少 prompts 数组，无法导入')
  const rawPrompts: unknown[] = json.prompts
  if (rawPrompts.length > MAX_LOREBOOK_ENTRIES) {
    throw new Error(`预设条目数 ${rawPrompts.length} 超过上限 ${MAX_LOREBOOK_ENTRIES}，拒绝导入`)
  }
  const warnings: string[] = []

  const byId = new Map<string, PresetEntry>()
  const promptSeq: string[] = []
  rawPrompts.forEach((raw, index) => {
    if (!isRecord(raw)) {
      warnings.push(`prompts[${index}] 不是对象，已跳过`)
      return
    }
    const parsed = parsePromptEntry(raw, index, warnings)
    if (parsed === null) return
    if (byId.has(parsed.identifier)) {
      warnings.push(`prompts[${index}] 与已有条目 identifier 重复（${parsed.identifier}），已跳过`)
      return
    }
    byId.set(parsed.identifier, parsed)
    promptSeq.push(parsed.identifier)
  })

  const orderList = Array.isArray(json.prompt_order) ? pickPromptOrder(json.prompt_order) : null
  if (orderList !== null && orderList.length > MAX_LOREBOOK_ENTRIES) {
    throw new Error(`prompt_order 条目数 ${orderList.length} 超过上限 ${MAX_LOREBOOK_ENTRIES}，拒绝导入`)
  }
  const entries: PresetEntry[] = []
  const seen = new Set<string>()

  if (orderList !== null) {
    for (const item of orderList) {
      const src = byId.get(item.identifier)
      if (!src || seen.has(item.identifier)) continue
      seen.add(item.identifier)
      entries.push({ ...src, enabled: item.enabled })
    }
    const leftover = promptSeq.filter((id) => !seen.has(id)).length
    if (leftover > 0) {
      warnings.push(`有 ${leftover} 条未列入 prompt_order 的库条目，已关闭（可在编辑器中开启）`)
    }
    for (const id of promptSeq) {
      if (seen.has(id)) continue
      const src = byId.get(id)
      if (!src) continue
      entries.push({ ...src, enabled: false })
    }
    assignRelativeOrder(entries)
  } else {
    for (const id of promptSeq) {
      const src = byId.get(id)
      if (src) entries.push(src)
    }
  }

  const preset: PromptPreset = {
    name: toStr(json.name) || '未命名预设',
    identifier: toStr(json.identifier) || toStr(json.name) || 'imported-preset',
    entries,
  }
  const regexScripts = pickRegexScripts(json, json)
  const embedded = regexScripts.length > 0 ? [] : collectPromptEmbeddedRegex(rawPrompts)
  const scripts = regexScripts.length > 0 ? regexScripts : embedded
  if (scripts.length > 0) {
    preset.regexScripts = scripts
    warnings.push(`已导入 ${scripts.length} 条预设正则（随脚本开关生效）`)
  }
  return { preset, warnings }
}

/** 导出为 ST 形态：prompts + 单个 prompt_order（character_id 100001）。 */
export function exportStPreset(preset: PromptPreset): unknown {
  const prompts = preset.entries.map((e) => ({
    identifier: e.identifier,
    name: e.name,
    role: e.role,
    content: e.content,
    marker: e.marker,
    system_prompt: e.role === 'system',
    injection_position: e.position === 'in-chat' ? 1 : 0,
    injection_depth: e.depth,
    injection_order: e.order,
    ...(e.forbidOverrides ? { forbid_overrides: true } : {}),
    ...(e.extension ? { extension: true } : {}),
    ...(e.injectionTrigger && e.injectionTrigger.length > 0 ? { injection_trigger: [...e.injectionTrigger] } : {}),
  }))
  const order = preset.entries.map((e) => ({ identifier: e.identifier, enabled: e.enabled }))
  const exported: Record<string, unknown> = {
    name: preset.name,
    identifier: preset.identifier,
    prompts,
    prompt_order: [{ character_id: EXPORT_CHARACTER_ID, order }],
  }
  if (preset.regexScripts && preset.regexScripts.length > 0) {
    exported.extensions = { regex_scripts: preset.regexScripts }
  }
  return exported
}
