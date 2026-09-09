/**
 * SillyTavern 预设（presetStore）单元测试。
 * 覆盖：全字段解析（role/system_prompt/injection_*）、prompt_order 优先 100001、
 * 未列出库条目摘要 warning、无 prompt_order 默认全开、
 * forbid_overrides / extension / injection_trigger 归一化保留并随导出带回、
 * 缺 prompts 抛错、栈序写入 relative.order、往返导出、
 * 导入硬上限与错型拒绝（条目数 2000 / 正文 100000 / identifier 500、prompt_order 嵌套层级 16，
 * 与世界书同口径统一拒绝）。
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
    expect(jb.injectionTrigger).toEqual(['key']) // 归一化保留（小写）

    const aux = preset.entries[3]!
    expect(aux.role).toBe('assistant')
    expect(aux.enabled).toBe(false) // 未列出 → 禁用
    expect(aux.order).toBe(40) // 附在栈末的 relative 序
    expect(aux.extension).toBe(true) // 扩展标记往返保留

    // forbid_overrides: false 是默认值，不进内部模型
    expect(main.forbidOverrides).toBeUndefined()
  })

  it('forbid_overrides / injection_trigger / extension 不再告警，归一化进条目', () => {
    const { preset, warnings } = parseStPreset({
      prompts: [
        { identifier: 'main', content: 'x', forbid_overrides: true },
        { identifier: 'jb', content: 'y', injection_trigger: ['Normal', 'continue'] },
      ],
      prompt_order: [
        { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'jb', enabled: true }] },
      ],
    })
    expect(warnings).toEqual([])
    expect(preset.entries[0]!.forbidOverrides).toBe(true)
    expect(preset.entries[1]!.injectionTrigger).toEqual(['normal', 'continue']) // trim + 小写归一化
  })

  it('warnings：未列出条目一条摘要；三字段已归一化不再告警', () => {
    const { warnings } = parseStPreset(ST_PRESET)
    expect(warnings.some((w) => w.includes('1 条') && w.includes('prompt_order'))).toBe(true)
    expect(warnings.some((w) => w.includes('forbid_overrides'))).toBe(false)
    expect(warnings.some((w) => w.includes('injection_trigger'))).toBe(false)
    expect(warnings.some((w) => w.includes('extension'))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings.every((w) => !w.includes('"aux"'))).toBe(true)
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

describe('导入硬上限与错型拒绝（与世界书同口径，统一拒绝）', () => {
  it('prompts 条目数超过 2000 拒绝导入', () => {
    const prompts = Array.from({ length: 2001 }, (_, i) => ({ identifier: `p${i}`, content: 'c' }))
    expect(() => parseStPreset({ prompts })).toThrow(/条目数 2001 超过上限 2000/)
    // 恰好 2000 条放行
    const ok = Array.from({ length: 2000 }, (_, i) => ({ identifier: `p${i}`, content: 'c' }))
    expect(parseStPreset({ prompts: ok }).preset.entries).toHaveLength(2000)
  })

  it('单条 prompt 正文超过 100000 字符拒绝；identifier 超过 500 字符拒绝', () => {
    expect(() => parseStPreset({ prompts: [{ identifier: 'a', content: 'x'.repeat(100_001) }] })).toThrow(/正文/)
    expect(() => parseStPreset({ prompts: [{ identifier: 'i'.repeat(501), content: 'c' }] })).toThrow(/identifier/)
  })

  it('content 错型（对象/数组）在归一化时抛错，而不是落盘后才炸', () => {
    expect(() => parseStPreset({ prompts: [{ identifier: 'a', content: { nested: true } }] })).toThrow(
      /content 不是字符串/,
    )
    expect(() => parseStPreset({ prompts: [{ identifier: 'a', content: ['x'] }] })).toThrow(/content 不是字符串/)
  })

  it('prompt_order 嵌套层级超过 16 拒绝（恶意深嵌套会撑爆调用栈）', () => {
    let item: Record<string, unknown> = { identifier: 'leaf', enabled: true }
    for (let i = 0; i < 20; i++) item = { identifier: `f${i}`, enabled: true, items: [item] }
    expect(() =>
      parseStPreset({
        prompts: [{ identifier: 'leaf', content: 'c' }],
        prompt_order: [{ character_id: 100001, order: [item] }],
      }),
    ).toThrow(/嵌套层级/)
  })

  it('prompt_order 展开项超过 2000 同样拒绝', () => {
    const flat = Array.from({ length: 2001 }, (_, i) => ({ identifier: `g${i}`, enabled: true }))
    expect(() =>
      parseStPreset({ prompts: [{ identifier: 'main', content: 'c' }], prompt_order: [{ character_id: 100001, order: flat }] }),
    ).toThrow(/prompt_order 条目数/)
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
    expect(jb.injection_trigger).toEqual(['key']) // 导出带回
    expect(exported.prompts[0]!.system_prompt).toBe(true)
    expect(exported.prompts[0]!.forbid_overrides).toBeUndefined() // 默认值不导出
    expect(exported.prompts[1]!.marker).toBe(true)
    expect(exported.prompts[0]!.injection_order).toBe(10)
    expect(exported.prompts[3]!.extension).toBe(true) // 扩展标记导出带回
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

it('预设脚本随导入导出保留，兼容键值对设置，并遵守脚本数据排除标记',()=>{
  const {preset}=parseStPreset({name:'工厂预设',prompts:[],extensions:{tavern_helper:[['scripts',[{id:'script',enabled:true,content:'await Promise.resolve()',data:{secret:7},export_with:{data:false}}]],['variables',{author:5}]]}})
  expect(preset.helperSettings).toMatchObject({variables:{author:5},scripts:[{id:'script',data:{secret:7}}]})
  const exported=exportStPreset(preset)
  expect(exported).toMatchObject({extensions:{tavern_helper:{variables:{author:5},scripts:[{id:'script',enabled:true,content:'await Promise.resolve()',data:{}}]}}})
  expect(JSON.stringify(exported)).not.toContain('secret')
  expect(parseStPreset(exported).preset.helperSettings).toMatchObject({scripts:[{id:'script'}]})
})
it('预设内非法脚本设置不能通过导入或保存验证',()=>{
  expect(()=>parseStPreset({prompts:[],extensions:{tavern_helper:{scripts:[{id:'duplicate'},{id:'duplicate'}]}}})).toThrow(/重复/)
  expect(()=>exportStPreset({identifier:'invalid',name:'invalid',entries:[],helperSettings:[] as unknown as Record<string,unknown>})).toThrow(/对象/)
})
