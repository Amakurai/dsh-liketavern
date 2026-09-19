/** ST 三个文本格式字段的数据边界：导入/导出保留空串与宏原文，保存和真实磁盘读取拒绝错型、未知键与超量内容。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptPreset } from '../src/core/types.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { MAX_LOREBOOK_CONTENT_CHARS } from '../src/state/lorebook.js'
import { exportStPreset, parseStoredPreset, parseStPreset } from '../src/state/presetStore.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const presetInput = { identifier: 'formats', name: '格式测试', prompts: [{ identifier: 'main', content: '规则' }] }
const formatKeys = ['wi_format', 'scenario_format', 'personality_format'] as const

describe('ST 格式字段契约', () => {
  it('仅导入三个明确字段，保留空串、空白和宏原文并往返回正式 ST 键', () => {
    const raw = { ...presetInput, wi_format: '  <world>{0}</world>  ', scenario_format: '',
      personality_format: '<personality>{{personality}}</personality>', future_format: '不透传',
      formatting: { scenario: '不是 ST 字段' } }
    const preset = parseStPreset(raw).preset
    expect(preset.formatting).toEqual({ worldInfo: raw.wi_format, scenario: '', personality: raw.personality_format })
    const stored = parseStoredPreset(JSON.parse(JSON.stringify(preset)))
    const exported = exportStPreset(stored) as Record<string, unknown>
    expect(exported).toMatchObject({ wi_format: raw.wi_format, scenario_format: '', personality_format: raw.personality_format })
    expect(exported).not.toHaveProperty('future_format')
    expect(exported).not.toHaveProperty('formatting')
    expect(parseStPreset(exported).preset.formatting).toEqual(preset.formatting)
  })

  it('缺省不补格式，部分定义不写出其余键', () => {
    const absent = parseStPreset(presetInput).preset
    expect(absent).not.toHaveProperty('formatting')
    const emptyExport = exportStPreset(absent)
    for (const key of formatKeys) expect(emptyExport).not.toHaveProperty(key)
    const partial = parseStPreset({ ...presetInput, wi_format: '' }).preset
    expect(partial.formatting).toEqual({ worldInfo: '' })
    const exported = exportStPreset(partial)
    expect(exported).toHaveProperty('wi_format', '')
    expect(exported).not.toHaveProperty('scenario_format')
    expect(exported).not.toHaveProperty('personality_format')
  })

  it.each(formatKeys)('导入 %s 拒绝错型或超长值，不静默转换或截断', key => {
    for (const value of [null, 1, false, [], {}, 'x'.repeat(MAX_LOREBOOK_CONTENT_CHARS + 1)]) {
      expect(() => parseStPreset({ ...presetInput, [key]: value })).toThrow('预设格式字段无效')
    }
    const allowed = 'x'.repeat(MAX_LOREBOOK_CONTENT_CHARS)
    expect(exportStPreset(parseStPreset({ ...presetInput, [key]: allowed }).preset)).toHaveProperty(key, allowed)
  })

  it('内部格式对象严格拒绝未知键和非法内容', () => {
    const preset = parseStPreset(presetInput).preset
    for (const formatting of [null, [], 'text', { unknown: '' }, { scenario: false },
      { worldInfo: 'x'.repeat(MAX_LOREBOOK_CONTENT_CHARS + 1) }, { personality: {} }]) {
      expect(() => parseStoredPreset({ ...preset, formatting })).toThrow('预设格式字段无效')
    }
    expect(parseStoredPreset({ ...preset, formatting: {} }).formatting).toEqual({})
  })

  it('真实保存拒绝坏格式且不覆盖，重新读取验证格式对象', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-preset-formatting-'))
    roots.push(root)
    const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
      presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
    const makeState = () => new TavernState(paths, () => resolveConfig({}))
    const state = makeState()
    await state.init()
    const preset = parseStPreset({ ...presetInput, wi_format: '', scenario_format: '<scene>{{scenario}}</scene>' }).preset
    const id = await state.savePreset(preset)
    const path = join(paths.presets, `${id}.json`)
    const before = await readFile(path, 'utf8')
    await expect(state.savePreset({ ...preset, formatting: { scenario: 3 } } as unknown as PromptPreset)).rejects.toThrow('预设格式字段无效')
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await makeState().loadPreset(id))?.formatting).toEqual(preset.formatting)
    await writeFile(path, JSON.stringify({ ...preset, formatting: { scenario: [] } }))
    expect(await makeState().loadPreset(id)).toBeNull()
  })
})
