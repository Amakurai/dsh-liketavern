/** 资产稳定文件 ID 回归：真实文件系统验证净化碰撞的后缀在前槽删除后仍保持身份、修订与导入目标。 */
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PromptPreset } from '../src/core/types.js'
import { exportStPreset } from '../src/core/presetExport.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import type { SessionBinding } from '../src/node/bindings.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let state: TavernState
let service: TavernService
let fs: WorkspaceFs
const preset = (identifier: string, name = identifier): PromptPreset => ({ identifier, name, entries: [] })
const book = (name: string, content: string) => ({ name, entries: { one: { key: ['港口'], content } } })
const binding = (presetId: string | null, lorebookIds: string[] = []): SessionBinding => ({
  sessionId: 'test-session', cardId: 'test-card', presetId, personaId: null, lorebookIds,
  characterLorebookId: null, createdAt: '2026-01-01T00:00:00.000Z',
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-stable-asset-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  fs = new WorkspaceFs(root, null)
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state,
    { get: () => ({}), update: async () => {} } as TavernSettingsScope)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('碰撞后缀的稳定资产身份', () => {
  it('前占位删除后有效预设修订仍保存到已有后缀，缓存也沿用原 ID 更新', async () => {
    const first = await state.savePreset(preset('my preset', '前占位'))
    const second = await state.savePreset(preset('my?preset', '目标预设'))
    const snapshot = await service.getPreset({ id: second })
    await state.deletePreset(first)
    const next = { ...snapshot.preset, name: '修改名称' }
    await expect(service.savePreset({ preset: next, expectedRevision: snapshot.revision })).resolves.toMatchObject({ id: second })
    expect(await state.listPresets()).toEqual([second])
    expect(await fs.readText(`library/presets/${first}.json`)).toBeNull()
    expect(await state.loadPreset(second)).toEqual(next)
  })

  it('前占位删除后同 identifier 重新导入与普通保存更新已有文件而不复制身份', async () => {
    const first = await state.savePreset(preset('my preset', '前占位'))
    const second = await state.savePreset(preset('my?preset', '目标预设'))
    await state.loadPreset(second)
    await state.deletePreset(first)
    const imported = preset('my?preset', '重新导入')
    const result = await service.importPreset({ name: imported.name, json: exportStPreset(imported) })
    expect(result.id).toBe(second)
    expect((await state.loadPreset(second))?.name).toBe(imported.name)
    expect(await state.savePreset({ ...imported, name: '再次保存' })).toBe(second)
    expect(await state.listPresets()).toEqual([second])
    expect(await fs.readText(`library/presets/${first}.json`)).toBeNull()
    expect((await state.loadPreset(second))?.name).toBe('再次保存')
  })

  it('较早数字后缀腾空也不能让已有后缀移动或误报修订冲突', async () => {
    const first = await state.savePreset(preset('my preset'))
    const middle = await state.savePreset(preset('my?preset'))
    const last = await state.savePreset(preset('my*preset'))
    const snapshot = await service.getPreset({ id: last })
    await state.deletePreset(middle)
    await expect(service.savePreset({ preset: { ...snapshot.preset, name: '仍在第三槽' },
      expectedRevision: snapshot.revision })).resolves.toMatchObject({ id: last })
    expect((await state.listPresets()).sort()).toEqual([first, last].sort())
    expect(await fs.readText(`library/presets/${middle}.json`)).toBeNull()
    expect((await state.loadPreset(last))?.name).toBe('仍在第三槽')
  })

  it('世界书原始名称重导入与按实际文件 ID 的有效修订保存同样保持已有后缀', async () => {
    const first = await state.saveLorebook('港口 设定', book('港口 设定', '前占位'))
    const second = await state.saveLorebook('港口?设定', book('港口?设定', '原内容'))
    const snapshot = await service.getLorebook({ name: second })
    await state.deleteLorebook(first)
    await expect(state.saveLorebookSnapshot(second, book('港口?设定', '有效保存'), snapshot.revision))
      .resolves.toMatchObject({ name: second })
    expect(await service.importLorebook({ name: '港口?设定', json: book('港口?设定', '重新导入') }))
      .toMatchObject({ name: second })
    expect(await state.listLorebooks()).toEqual([second])
    expect((await state.loadLorebookEntries(second, 'global')).map(entry => entry.content)).toEqual(['重新导入'])
    expect(await fs.readText(`library/lorebooks/${first}.json`)).toBeNull()
  })

  it('同修订的并发后缀编辑仍只提交一次，不占用新空槽', async () => {
    const first = await state.savePreset(preset('my preset'))
    const second = await state.savePreset(preset('my?preset'))
    const snapshot = await service.getPreset({ id: second })
    await state.deletePreset(first)
    const result = await Promise.allSettled(['窗口 A', '窗口 B'].map(name => service.savePreset({
      id: second, preset: { ...snapshot.preset, name }, expectedRevision: snapshot.revision,
    })))
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect((await state.loadPreset(second))?.name).toBe(['窗口 A', '窗口 B'][result.findIndex(item => item.status === 'fulfilled')])
    expect(await state.listPresets()).toEqual([second])
  })

  it('已有占位时沿用后缀，显示名可改而无目标 ID 的新 identifier 仍创建新资产', async () => {
    const first = await state.savePreset(preset('my preset', '占位'))
    const second = await state.savePreset(preset('my?preset', '目标'))
    expect(await state.savePreset(preset('my?preset', '改名'))).toBe(second)
    expect((await state.loadPreset(first))?.name).toBe('占位')
    const changed = await service.savePreset({ preset: preset('new-preset', '新身份'), expectedRevision: null })
    expect(changed.id).toBe('new-preset')
    expect((await state.loadPreset(second))?.name).toBe('改名')
  })

  it('历史时间戳数字后缀也在较早槽为空时保持原 ID', async () => {
    const value = preset('my?preset', '历史时间戳')
    const id = 'my_preset-1700000000000'
    await fs.writeText(`library/presets/${id}.json`, JSON.stringify(value))
    expect(await state.savePreset({ ...value, name: '继续编辑' })).toBe(id)
    expect(await state.listPresets()).toEqual([id])
  })

  it.runIf(process.platform === 'win32')('Windows 后缀匹配返回目录中的实际文件拼写', async () => {
    const first = await state.savePreset(preset('my preset'))
    const second = await state.savePreset(preset('my?preset'))
    const actual = second.toUpperCase()
    await rename(join(root, `library/presets/${second}.json`), join(root, 'library/presets/moving.json'))
    await rename(join(root, 'library/presets/moving.json'), join(root, `library/presets/${actual}.JSON`))
    await state.deletePreset(first)
    expect(await state.savePreset(preset('my?preset', '保留实际拼写'))).toBe(actual)
    expect((await state.loadPreset(actual))?.name).toBe('保留实际拼写')
  })

  it.runIf(process.platform === 'win32')('Windows 预设别名热缓存与 standing 修订随实际后缀文件保存失效', async () => {
    const first = await state.savePreset(preset('Mixed Preset'))
    const second = await state.savePreset(preset('Mixed?Preset', '原文'))
    const alias = second.toUpperCase()
    const snapshot = await service.getPreset({ id: alias })
    const before = state.standingRevTags(binding(alias))
    await state.deletePreset(first)
    const changed = { ...snapshot.preset, name: '实际文件已更新' }
    await expect(service.savePreset({ id: second, preset: changed, expectedRevision: snapshot.revision })).resolves.toMatchObject({ id: second })
    expect(await state.loadPreset(alias)).toEqual(changed)
    expect(state.standingRevTags(binding(alias))).not.toEqual(before)
    await state.deletePreset(alias)
    expect(await state.loadPreset(second)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('Windows 世界书别名热缓存与 standing 修订随原名重导入失效', async () => {
    const first = await state.saveLorebook('Mixed Book', book('Mixed Book', '占位'))
    const second = await state.saveLorebook('Mixed?Book', book('Mixed?Book', '原内容'))
    const alias = second.toUpperCase()
    expect((await state.loadLorebookEntries(alias, 'global')).map(entry => entry.content)).toEqual(['原内容'])
    const before = state.standingRevTags(binding(null, [alias]))
    await state.deleteLorebook(first)
    expect(await state.saveLorebook('Mixed?Book', book('Mixed?Book', '重导入内容'))).toBe(second)
    expect((await state.loadLorebookEntries(alias, 'global')).map(entry => entry.content)).toEqual(['重导入内容'])
    expect(state.standingRevTags(binding(null, [alias]))).not.toEqual(before)
    await state.deleteLorebook(alias)
    expect(await state.loadLorebookEntries(second, 'global')).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('Linux 大小写不同文件的缓存与修订保持独立', async () => {
    await state.savePreset(preset('Mixed', '大写文件'))
    await state.savePreset(preset('mixed', '小写文件'))
    await state.loadPreset('mixed')
    const before = state.standingRevTags(binding('mixed'))
    await state.savePreset(preset('Mixed', '仅更新大写'))
    expect((await state.loadPreset('mixed'))?.name).toBe('小写文件')
    expect(state.standingRevTags(binding('mixed'))).toEqual(before)
    expect((await state.loadPreset('Mixed'))?.name).toBe('仅更新大写')
  })

  it('人设落盘时固化的后缀 ID 在前占位删除后继续用于有效修订保存', async () => {
    await fs.writeText('personas/traveler_name.json', JSON.stringify({ id: 'legacy-other', name: '旧占位', description: '', avatar: null }))
    const id = await state.savePersona({ id: 'traveler name', name: '旅人', description: '', avatar: null })
    expect(id).toBe('traveler_name-2')
    const snapshot = (await service.listPersonas({})).items.find(item => item.id === id)!
    await state.deletePersona('traveler_name')
    const { revision, ...value } = snapshot
    await expect(service.savePersona({ persona: { ...value, name: '改名旅人' }, expectedRevision: revision })).resolves.toMatchObject({ id })
    expect((await state.listPersonas()).map(item => item.id)).toEqual([id])
  })
})

/** 旧实现已可能生成同 identifier 的多份资产；修订只用于冲突检测，不能充当文件定位器。 */
describe('明确预设保存目标', () => {
  const base = 'my_preset'
  const suffix = 'my_preset-2'
  async function duplicateIdentity(sameRevision = false) {
    const target = preset('my?preset', '后缀原文')
    await fs.writeText(`library/presets/${suffix}.json`, JSON.stringify(target))
    await fs.writeText(`library/presets/${base}.json`, JSON.stringify(sameRevision ? target : { ...target, name: '前槽副本' }))
    return service.getPreset({ id: suffix })
  }

  it.each([false, true])('历史重复身份使用选中 suffix ID，仅修改目标文件；相同修订=%s', async sameRevision => {
    const snapshot = await duplicateIdentity(sameRevision)
    const before = await fs.readText(`library/presets/${base}.json`)
    await expect(service.savePreset({ id: suffix, preset: { ...snapshot.preset, name: '只改后缀' },
      expectedRevision: snapshot.revision })).resolves.toMatchObject({ id: suffix })
    expect(await fs.readText(`library/presets/${base}.json`)).toBe(before)
    expect((await state.loadPreset(suffix))?.name).toBe('只改后缀')
  })

  it('无 ID 的旧保存与重新导入遇到重复身份明确拒绝，不凭相同修订猜目标', async () => {
    const snapshot = await duplicateIdentity(true)
    const before = await Promise.all([base, suffix].map(id => fs.readText(`library/presets/${id}.json`)))
    await expect(service.savePreset({ preset: { ...snapshot.preset, name: '不得猜测' }, expectedRevision: snapshot.revision })).rejects.toThrow('多个文件')
    await expect(state.savePreset({ ...snapshot.preset, name: '不得导入覆盖' })).rejects.toThrow('多个文件')
    expect(await Promise.all([base, suffix].map(id => fs.readText(`library/presets/${id}.json`)))).toEqual(before)
  })

  it('指定 suffix 已变时不能按另一文件的旧修订误定位，目标删除也不回退到副本', async () => {
    const snapshot = await duplicateIdentity(true)
    const baseBefore = await fs.readText(`library/presets/${base}.json`)
    await state.savePresetSnapshot({ ...snapshot.preset, name: '其它窗口新版' }, { id: suffix, expectedRevision: snapshot.revision })
    await expect(service.savePreset({ id: suffix, preset: { ...snapshot.preset, name: '旧窗口' }, expectedRevision: snapshot.revision })).rejects.toThrow('另一窗口')
    await expect(service.savePreset({ preset: { ...snapshot.preset, name: '旧窗口猜目标' }, expectedRevision: snapshot.revision })).rejects.toThrow('多个文件')
    await state.deletePreset(suffix)
    await expect(service.savePreset({ id: suffix, preset: snapshot.preset, expectedRevision: snapshot.revision })).rejects.toThrow('删除')
    expect(await fs.readText(`library/presets/${base}.json`)).toBe(baseBefore)
    expect(await fs.readText(`library/presets/${suffix}.json`)).toBeNull()
  })

  it.each(['my?preset', '../my_preset', 'my_preset/child'])('指定 ID 不允许净化成另一个文件或越界：%s', async id => {
    const snapshot = await duplicateIdentity()
    const before = await fs.readText(`library/presets/${base}.json`)
    await expect(service.savePreset({ id, preset: snapshot.preset, expectedRevision: snapshot.revision })).rejects.toThrow('非法')
    expect(await fs.readText(`library/presets/${base}.json`)).toBe(before)
  })

  it('指定文件不能改变 identifier，无修订旧客户端也不能覆盖该文件', async () => {
    const snapshot = await duplicateIdentity()
    const before = await fs.readText(`library/presets/${suffix}.json`)
    await expect(service.savePreset({ id: suffix, preset: { ...snapshot.preset, identifier: 'different' }, expectedRevision: snapshot.revision })).rejects.toThrow('identifier 不可修改')
    await expect(service.savePreset({ id: suffix, preset: { ...snapshot.preset, name: '旧客户端' } })).rejects.toThrow('另一窗口')
    await expect(state.savePresetSnapshot({ ...snapshot.preset, name: '内部无版本' }, { id: suffix })).rejects.toThrow('修订版本')
    await expect(state.savePresetSnapshot({ ...snapshot.preset, name: '内部新建版本' }, { id: suffix, expectedRevision: null })).rejects.toThrow('修订版本')
    expect(await fs.readText(`library/presets/${suffix}.json`)).toBe(before)
  })
})
