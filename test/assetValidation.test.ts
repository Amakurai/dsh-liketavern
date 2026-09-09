/** 资产数据边界回归：真实文件系统与最小服务适配器验证非法保存不覆盖、坏文件不拖垮资产列表。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import type { Persona } from '../src/core/persona.js'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let state: TavernState
let service: TavernService
let fs: WorkspaceFs
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-asset-validation-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  fs = new WorkspaceFs(root, null)
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as SettingsScope<TavernConfigRaw>)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('预设保存与读取', () => {
  it.each([
    { name: 42 },
    { name: {} },
    { regexScripts: 'bad' },
    { regexScripts: [null] },
    { regexScripts: [{ findRegex: {}, placement: 'assistant' }] },
  ])('拒绝错误顶层字段且不覆盖原预设：%j', async patch => {
    const preset = { ...defaultPreset(), identifier: 'valid' }
    await service.savePreset({ preset })
    const before = await fs.readText('library/presets/valid.json')
    await expect(service.savePreset({ preset: { ...preset, ...patch } })).rejects.toMatchObject({ code: 'invalid-preset' })
    expect(await fs.readText('library/presets/valid.json')).toBe(before)
    expect((await service.listPresets({})).items[0]?.name).toBe(preset.name)
  })

  it.each([
    { content: 42 }, { enabled: 'false' }, { role: 'invalid' }, { order: '20' },
    { markerId: {} }, { injectionTrigger: [42] }, { forbidOverrides: 'false' },
  ])('拒绝会改变运行行为的条目错型：%j', async patch => {
    const preset = defaultPreset()
    await expect(service.savePreset({ preset: { ...preset, entries: [{ ...preset.entries[0], ...patch }] } })).rejects.toMatchObject({ code: 'invalid-preset' })
    expect(await state.listPresets()).toEqual([])
  })

  it('有效内部预设保存保持条目顺序、markerId 与不可导出的脚本数据', async () => {
    const preset = { ...defaultPreset(), identifier: 'roundtrip', helperSettings: { scripts: [
      { id: 'script', type: 'script', name: '后台', enabled: true, content: '', data: { secret: 7 }, export_with: { data: false } },
    ] } }
    preset.entries = [{ ...preset.entries[0]!, order: 99 }, { ...preset.entries[1]!, identifier: 'custom-marker', marker: true, markerId: 'chatHistory', order: 5 }]
    await service.savePreset({ preset })
    const stored = (await service.getPreset({ id: preset.identifier })).preset
    expect(stored.entries).toEqual(preset.entries)
    expect(stored.helperSettings).toMatchObject({ scripts: [{ data: { secret: 7 } }] })
  })

  it.each([42, [], {}, { name: 42, identifier: 'broken', entries: [] }, { name: '坏条目', identifier: 'broken', entries: [null] }])('合法 JSON 但预设结构损坏时按坏文件处理：%j', async value => {
    await fs.writeText('library/presets/broken.json', JSON.stringify(value))
    expect(await state.loadPreset('broken')).toBeNull()
    expect((await state.listPresetSummaries())[0]).toEqual({ id: 'broken', name: 'broken', regexCount: 0 })
  })
})

describe('人设数据边界', () => {
  const persona: Persona = { id: 'valid', name: '旅行者', description: '沿海旅行', avatar: null, lorebookId: 'coast' }
  it.each([42, [], {}, { id: 'broken', name: 42, description: '', avatar: null }, { id: 'broken', name: '坏人设', description: {}, avatar: null }])('坏人设不影响有效列表与解析：%j', async value => {
    await state.savePersona(persona)
    await fs.writeText('personas/broken.json', JSON.stringify(value))
    expect(await state.loadPersona('broken')).toBeNull()
    expect(await state.listPersonas()).toEqual([persona])
    expect(await state.resolvePersona(null)).toEqual(persona)
  })

  it('存储入口同样拒绝错型字段且不覆盖旧人设', async () => {
    await state.savePersona(persona)
    const before = await fs.readText('personas/valid.json')
    await expect(state.savePersona({ ...persona, description: [] } as unknown as Persona)).rejects.toThrow()
    expect(await fs.readText('personas/valid.json')).toBe(before)
  })
})
