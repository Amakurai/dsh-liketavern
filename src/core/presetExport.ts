/** 预设的纯数据导出：面板与后端共用完整 ST 格式，保留条目纪律并遵守脚本数据导出设置。 */
import type { PromptPreset } from './types.js'
import { exportHelperScriptTrees, helperScriptSettings } from './helperScripts.js'

export function exportStPreset(preset: PromptPreset): unknown {
  const prompts = preset.entries.map((entry) => ({
    identifier: entry.identifier,
    name: entry.name,
    role: entry.role,
    content: entry.content,
    marker: entry.marker,
    system_prompt: entry.role === 'system',
    injection_position: entry.position === 'in-chat' ? 1 : 0,
    injection_depth: entry.depth,
    injection_order: entry.order,
    ...(entry.forbidOverrides ? { forbid_overrides: true } : {}),
    ...(entry.extension ? { extension: true } : {}),
    ...(entry.injectionTrigger?.length ? { injection_trigger: [...entry.injectionTrigger] } : {}),
  }))
  // 编辑器改 order 不重排源数组；relative 栈序须与组装一致。深度条目保留原位，避免同 depth/order 的先后被改写。
  const relative = preset.entries.filter(entry => entry.position !== 'in-chat')
    .sort((a, b) => a.order - b.order || a.identifier.localeCompare(b.identifier))
  let relativeIndex = 0
  const order = preset.entries.map(entry => {
    const ordered = entry.position === 'in-chat' ? entry : relative[relativeIndex++]!
    return { identifier: ordered.identifier, enabled: ordered.enabled }
  })
  const exported: Record<string, unknown> = {
    name: preset.name,
    identifier: preset.identifier,
    prompts,
    prompt_order: [{ character_id: 100001, order }],
  }
  if (preset.regexScripts?.length) exported.extensions = { regex_scripts: preset.regexScripts }
  if (preset.helperSettings !== undefined) {
    const settings = helperScriptSettings(preset.helperSettings)
    exported.extensions = {
      ...(exported.extensions as Record<string, unknown> ?? {}),
      tavern_helper: { ...settings, scripts: exportHelperScriptTrees(settings.scripts ?? []) },
    }
  }
  return exported
}
