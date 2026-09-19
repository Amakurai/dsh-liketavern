/** ST 内建条目标记的往返边界：自定义 system 规则保持可注入，角色修改不改变资产身份，旧存储有明确回退。 */
import { describe, expect, it } from 'vitest'
import type { PromptPreset } from '../src/core/types.js'
import { exportStPreset, parseStPreset, parseStoredPreset } from '../src/state/presetStore.js'

interface ExportedPrompt {
  identifier: string
  role: string
  system_prompt: boolean
  injection_position: number
}
const exportedPrompts = (preset: PromptPreset): ExportedPrompt[] =>
  (exportStPreset(preset) as { prompts: ExportedPrompt[] }).prompts

describe('ST system_prompt 元数据', () => {
  it('自定义 system 规则导出后仍属于 ST 可注入的 relative 条目', () => {
    const imported = parseStPreset({ prompts: [
      { identifier: 'writing-style', role: 'system', content: '使用第三人称叙事。', system_prompt: false },
      { identifier: 'main', role: 'assistant', content: '角色主提示。', system_prompt: true },
    ] }).preset
    const stored = parseStoredPreset(JSON.parse(JSON.stringify(imported)))
    const exported = exportedPrompts(stored)
    expect(stored.entries.map(entry => entry.systemPrompt)).toEqual([false, true])
    // ST populateChatCompletion 用此条件挑选用户 relative 条目，system role 不代表内建条目。
    expect(exported.filter(prompt => prompt.system_prompt === false && prompt.injection_position !== 1)
      .map(prompt => prompt.identifier)).toEqual(['writing-style'])
    expect(exported.find(prompt => prompt.identifier === 'main')).toMatchObject({ role: 'assistant', system_prompt: true })
    expect(parseStPreset(exportStPreset(stored)).preset.entries).toEqual(stored.entries)
  })

  it('修改消息角色不改内建标记，显式 false 覆盖内建槽位回退', () => {
    const preset = parseStPreset({ prompts: [
      { identifier: 'main', role: 'system', content: '主提示', system_prompt: false },
      { identifier: 'custom', role: 'user', content: '自定义', system_prompt: true },
    ] }).preset
    preset.entries[0]!.role = 'assistant'
    preset.entries[1]!.role = 'system'
    expect(exportedPrompts(preset)).toEqual([
      expect.objectContaining({ identifier: 'main', role: 'assistant', system_prompt: false }),
      expect.objectContaining({ identifier: 'custom', role: 'system', system_prompt: true }),
    ])
  })

  it('缺少元数据的导入与旧存储按内建槽位或 marker 推断，不按 role 推断', () => {
    const preset = parseStPreset({ prompts: [
      ...['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'].map(identifier => ({ identifier, role: 'user', content: identifier })),
      { identifier: 'chatHistory', marker: true },
      { identifier: 'custom-system', role: 'system', content: '普通规则' },
      { identifier: 'custom-assistant', role: 'assistant', content: '普通示例' },
    ] }).preset
    const expected = [true, true, true, true, true, false, false]
    expect(preset.entries.map(entry => entry.systemPrompt)).toEqual(expected)
    const oldStored = parseStoredPreset({ ...preset, entries: preset.entries.map(({ systemPrompt: _systemPrompt, ...entry }) => entry) })
    expect(exportedPrompts(oldStored).map(entry => entry.system_prompt)).toEqual(expected)
  })

  it('内部存储拒绝错型内建标记，不能把 false 字符串当成启用', () => {
    const preset = parseStPreset({ prompts: [{ identifier: 'custom', content: '规则' }] }).preset
    expect(() => parseStoredPreset({ ...preset, entries: [{ ...preset.entries[0], systemPrompt: 'false' }] })).toThrow()
  })

  it('相同 order 导出保留原栈先后，identifier 不参与提示词排序', () => {
    const preset = parseStPreset({ prompts: [
      { identifier: 'z-first', content: '第一条' },
      { identifier: 'depth', content: '深度条目', injection_position: 1, injection_depth: 1 },
      { identifier: 'a-second', content: '第二条' },
      { identifier: 'chatHistory', marker: true },
    ] }).preset
    preset.entries[0]!.order = 10
    preset.entries[2]!.order = 10
    const reimported = parseStPreset(exportStPreset(preset)).preset
    expect(reimported.entries.map(entry => entry.identifier)).toEqual(['z-first', 'depth', 'a-second', 'chatHistory'])
  })
})
