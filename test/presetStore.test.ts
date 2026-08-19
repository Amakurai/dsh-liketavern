/**
 * SillyTavern 预设（presetStore）单元测试。
 * 覆盖：全字段解析（role/system_prompt/injection_*）、prompt_order 优先 100001、
 * 未列出库条目摘要 warning、无 prompt_order 默认全开、未映射字段仅在有意义时 warning、
 * 缺 prompts 抛错、栈序写入 relative.order、往返导出。
 */
import { describe, expect, it } from 'vitest'
import { exportStPreset, parseStPreset } from '../src/state/presetStore.js'

const ST_PRESET = {
  prompts: [
    {
      identifier: 'main',
      name: 'Main Prompt',
      role: 'system',
      content: '你是 {{char}}。',
      marker: false,
      system_prompt: true,
      injection_position: 0,
      injection_order: 100,
      forbid_overrides: false,
    },
    {
      identifier: 'chatHistory',
      name: 'Chat History',
      marker: true,
      system_prompt: true,
      injection_position: 0,
      injection_order: 100,
    },
    {
      identifier: 'jailbreak',
      name: 'Jailbreak',
      role: 'user',
      content: '保持人设。',
      injection_position: 1,
      injection_depth: 2,
      injection_order: 90,
      injection_trigger: ['key'],
    },
    {
      identifier: 'aux',
      name: 'Aux Note',
      role: 'assistant',
      content: '辅助',
      injection_position: 0,
      extension: true,
      // 未在 prompt_order 中列出 → enabled=false，记一条摘要
    },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: false },
        { identifier: 'jailbreak', enabled: true },
      ],
    },
  ],
}

describe('parseStPreset', () => {
  it('全字段解析：role/position/depth/order/marker/enabled', () => {
    const { preset } = parseStPreset(ST_PRESET)
    expect(preset.entries).toHaveLength(4)
    expect(preset.entries.map((e) => e.identifier)).toEqual(['main', 'chatHistory', 'jailbreak', 'aux'])

    const main = preset.entries[0]!
    expect(main.identifier).toBe('main')
    expect(main.name).toBe('Main Prompt')
    expect(main.role).toBe('system')
    expect(main.enabled).toBe(true)
    expect(main.position).toBe('relative')
    expect(main.depth).toBe(4) // injection_depth 默认 4
    expect(main.order).toBe(10) // relative：prompt_order 栈序
    expect(main.content).toBe('你是 {{char}}。')
    expect(main.marker).toBe(false)
    expect(main.markerId).toBeUndefined()

    const history = preset.entries[1]!
    expect(history.marker).toBe(true)
    expect(history.markerId).toBe('chatHistory') // identifier 原样进 markerId
    expect(history.role).toBe('system') // marker 条目 role 默认 system
    expect(history.enabled).toBe(false) // prompt_order 中 enabled: false
    expect(history.order).toBe(20)

    const jb = preset.entries[2]!
    expect(jb.role).toBe('user')
    expect(jb.position).toBe('in-chat') // injection_position 1
    expect(jb.depth).toBe(2)
    expect(jb.order).toBe(90) // in-chat 仍用 injection_order
    expect(jb.enabled).toBe(true)

    const aux = preset.entries[3]!
    expect(aux.role).toBe('assistant')
    expect(aux.enabled).toBe(false) // 未列出 → 禁用
    expect(aux.order).toBe(40) // 附在栈末的 relative 序
  })

  it('warnings：未列出条目一条摘要 + 有意义的未映射字段（空 forbid_overrides 不计）', () => {
    const { warnings } = parseStPreset(ST_PRESET)
    expect(warnings.some((w) => w.includes('1 条') && w.includes('prompt_order'))).toBe(true)
    expect(warnings.some((w) => w.includes('forbid_overrides'))).toBe(false)
    expect(warnings.some((w) => w.includes('injection_trigger'))).toBe(true)
    expect(warnings.some((w) => w.includes('extension'))).toBe(true)
    expect(warnings).toHaveLength(3)
    expect(warnings.every((w) => !w.includes('"aux"'))).toBe(true)
  })

  it('forbid_overrides=true 才记未映射 warning', () => {
    const { warnings } = parseStPreset({
      prompts: [{ identifier: 'main', content: 'x', forbid_overrides: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    })
    expect(warnings.some((w) => w.includes('forbid_overrides'))).toBe(true)
  })

  it('无 prompt_order → 全部 enabled=true 且无相关 warning', () => {
    const { preset, warnings } = parseStPreset({
      prompts: [
        { identifier: 'a', content: '1' },
        { identifier: 'b', content: '2', role: 'user' },
      ],
    })
    expect(preset.entries.map((e) => e.enabled)).toEqual([true, true])
    expect(warnings).toEqual([])
    expect(preset.name).toBe('未命名预设')
  })

  it('优先 character_id 100001，忽略排在前面的 100000 骨架', () => {
    const { preset, warnings } = parseStPreset({
      prompts: [
        { identifier: 'main', name: '骨架主提示', content: 'skeleton', role: 'system' },
        { identifier: 'personaDescription', name: 'Persona', marker: true, system_prompt: true },
        { identifier: 'mod-a', name: '模块 A', content: 'A', role: 'user', system_prompt: true },
        { identifier: 'lib-only', name: '库条目', content: 'unused' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'personaDescription', enabled: false },
          ],
        },
        {
          character_id: 100001,
          order: [
            { identifier: 'mod-a', enabled: true },
            { identifier: 'personaDescription', enabled: true },
            { identifier: 'main', enabled: false },
          ],
        },
      ],
    })
    expect(preset.entries.map((e) => e.identifier)).toEqual(['mod-a', 'personaDescription', 'main', 'lib-only'])
    expect(preset.entries.map((e) => e.enabled)).toEqual([true, true, false, false])
    expect(preset.entries[0]!.role).toBe('user') // system_prompt 不覆盖显式 role
    expect(preset.entries[0]!.order).toBe(10)
    expect(preset.entries[1]!.order).toBe(20)
    expect(warnings.some((w) => w.includes('1 条'))).toBe(true)
    expect(warnings.filter((w) => w.includes('prompt_order'))).toHaveLength(1)
  })

  it('嵌套 items 的 folder 会摊平进栈', () => {
    const { preset } = parseStPreset({
      prompts: [
        { identifier: 'folder', name: '夹' },
        { identifier: 'child', name: '子', content: 'c' },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [{ identifier: 'folder', enabled: true, items: [{ identifier: 'child', enabled: true }] }],
        },
      ],
    })
    expect(preset.entries.map((e) => [e.identifier, e.enabled])).toEqual([
      ['folder', true],
      ['child', true],
    ])
  })

  it('缺 prompts 数组抛中文 Error', () => {
    expect(() => parseStPreset({})).toThrow(/缺少 prompts 数组/)
    expect(() => parseStPreset('nope')).toThrow(/不是有效的 JSON 对象/)
  })
})

describe('exportStPreset 与往返', () => {
  it('导出 ST 形态：prompts + 单个 prompt_order（character_id 100001）', () => {
    const { preset } = parseStPreset(ST_PRESET)
    const exported = exportStPreset(preset) as {
      prompts: Array<Record<string, unknown>>
      prompt_order: Array<{ character_id: number; order: Array<{ identifier: string; enabled: boolean }> }>
    }
    expect(exported.prompts).toHaveLength(4)
    expect(exported.prompt_order).toHaveLength(1)
    expect(exported.prompt_order[0]!.character_id).toBe(100001)
    expect(exported.prompt_order[0]!.order).toEqual([
      { identifier: 'main', enabled: true },
      { identifier: 'chatHistory', enabled: false },
      { identifier: 'jailbreak', enabled: true },
      { identifier: 'aux', enabled: false },
    ])
    const jb = exported.prompts[2]!
    expect(jb.injection_position).toBe(1)
    expect(jb.injection_depth).toBe(2)
    expect(jb.injection_order).toBe(90)
    expect(jb.system_prompt).toBe(false)
    expect(exported.prompts[0]!.system_prompt).toBe(true)
    expect(exported.prompts[1]!.marker).toBe(true)
    expect(exported.prompts[0]!.injection_order).toBe(10)
  })

  it('往返：parse(export(parse(x))) 条目深相等且无 warning', () => {
    const { preset } = parseStPreset(ST_PRESET)
    const again = parseStPreset(exportStPreset(preset))
    expect(again.preset.entries).toEqual(preset.entries)
    expect(again.warnings).toEqual([])
  })

  it('导入 extensions.regex_scripts，往返保留', () => {
    const { preset, warnings } = parseStPreset({
      name: '夏瑾',
      identifier: 'xiajin',
      prompts: [{ identifier: 'main', content: 'x' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
      extensions: {
        regex_scripts: [
          {
            id: 'wrap-1',
            scriptName: '包裹最新指示',
            findRegex: '^([\\s\\S]*)$',
            replaceString: '<最新互动>\n$1\n</最新互动>',
            placement: [1],
            disabled: false,
            promptOnly: true,
            markdownOnly: false,
            maxDepth: 1,
          },
          {
            id: 'off',
            scriptName: '底部正则',
            findRegex: '/(.*)/s',
            replaceString: '$1',
            placement: [1, 2],
            disabled: true,
            promptOnly: true,
          },
        ],
      },
    })
    expect(preset.regexScripts).toHaveLength(2)
    expect(preset.regexScripts![0]!.scriptName).toBe('包裹最新指示')
    expect(preset.regexScripts![1]!.disabled).toBe(true)
    expect(warnings.some((w) => w.includes('2 条预设正则'))).toBe(true)
    const again = parseStPreset(exportStPreset(preset))
    expect(again.preset.regexScripts).toEqual(preset.regexScripts)
  })

  it('extensions 没有正则时，从条目正文 RegexBinding.regexes 兜底导入', () => {
    const { preset, warnings } = parseStPreset({
      name: '绑定正则',
      identifier: 'bind-regex',
      prompts: [
        {
          identifier: 'ext',
          content: JSON.stringify({
            RegexBinding: {
              regexes: [{ scriptName: '隐藏变量', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi', replaceString: '', placement: [2], markdownOnly: true }],
            },
          }),
        },
      ],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'ext', enabled: true }] }],
    })
    expect(preset.regexScripts).toHaveLength(1)
    expect(preset.regexScripts![0]!.scriptName).toBe('隐藏变量')
    expect(warnings.some((w) => w.includes('1 条预设正则'))).toBe(true)
  })
})
