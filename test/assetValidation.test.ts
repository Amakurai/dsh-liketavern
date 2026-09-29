/** 资产数据边界回归：真实文件系统与最小服务适配器验证非法保存不覆盖、坏文件不拖垮资产列表。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TavernSettingsScope } from '../src/node/config.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import type { Persona } from '../src/core/persona.js'
import type { RegexRule } from '../src/core/types.js'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { personaEditRevision } from '../src/state/characterRevision.js'
import { encodeChatWorldbooks } from '../src/state/chatWorldbooks.js'

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
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('预设保存与读取', () => {
  it('只改名称或内嵌正则不能覆盖另一窗口的新提示词；相同版本并发只有一个成功', async () => {
    const preset = { ...defaultPreset(), identifier: 'concurrent', regexScripts: [{ id: 'r', disabled: false }] }
    const created = await service.savePreset({ preset })
    const next = { ...preset, entries: preset.entries.map(e => ({ ...e, content: '另一窗口已更新' })) }
    const result = await Promise.allSettled(['A', 'B'].map(name => service.savePreset({ preset: { ...next, name }, expectedRevision: created.revision })))
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const before = await fs.readText('library/presets/concurrent.json')
    await expect(service.savePreset({ preset: { ...preset, name: '旧改名' }, expectedRevision: created.revision })).rejects.toThrow('另一窗口')
    await expect(service.savePreset({ preset: { ...preset, regexScripts: [{ id: 'r', disabled: true }] }, expectedRevision: created.revision })).rejects.toThrow('另一窗口')
    await expect(service.savePreset({ preset })).rejects.toThrow('另一窗口')
    expect(await fs.readText('library/presets/concurrent.json')).toBe(before)
  })

  it('脚本库单独更新后预设编辑保留脚本库，删除或损坏文件拒绝旧草稿写入', async () => {
    const preset = { ...defaultPreset(), identifier: 'script-preserve', helperSettings: { variables: { value: 1 } } }
    const first = await service.savePreset({ preset })
    await state.savePreset({ ...preset, helperSettings: { variables: { value: 2 } } })
    const second = await service.savePreset({ preset: { ...preset, name: '改名' }, expectedRevision: first.revision })
    expect((await state.loadPreset(first.id))?.helperSettings).toMatchObject({ variables: { value: 2 } })
    expect((await service.getPreset({ id: first.id })).revision).toBe(second.revision)
    await fs.writeText(`library/presets/${first.id}.json`, '{broken')
    await expect(service.savePreset({ preset, expectedRevision: second.revision })).rejects.toThrow()
    expect(await fs.readText(`library/presets/${first.id}.json`)).toBe('{broken')
    await expect(state.savePreset(preset)).resolves.toBe(first.id)
    expect((await state.loadPreset(first.id))?.name).toBe(preset.name)
    await state.deletePreset(first.id)
    await expect(service.savePreset({ preset, expectedRevision: second.revision })).rejects.toThrow('删除')
  })
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

/** 面板三类世界书使用各自真实文件与锁，聊天集合还必须保护卡面切书后的保留副本。 */
describe('世界书编辑版本', () => {
  const book = (content: string) => ({ name: '港口', entries: { one: { uid: 'one', key: ['港口'], content } } })
  it('独立库书同版本并发只提交一次，删除后旧编辑不能复活，损坏文件不被覆盖', async () => {
    const initial = await service.saveLorebook({ name: '港口', json: book('初始') })
    const results = await Promise.allSettled(['A', 'B'].map(content => service.saveLorebook({ name: '港口', json: book(content), expectedRevision: initial.revision })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const latest = await service.getLorebook({ name: '港口' })
    await expect(service.saveLorebook({ name: '港口', json: book('旧客户端') })).rejects.toThrow('另一窗口')
    await fs.writeText('library/lorebooks/港口.json', '{broken')
    await expect(service.saveLorebook({ name: '港口', json: book('旧'), expectedRevision: latest.revision })).rejects.toThrow()
    expect(await fs.readText('library/lorebooks/港口.json')).toBe('{broken')
    await state.deleteLorebook('港口')
    await expect(service.saveLorebook({ name: '港口', json: book('旧'), expectedRevision: latest.revision })).rejects.toThrow('删除')
  })

  it('卡内书最后一条清空后仍可读取和继续编辑；旧版本不能覆盖空书', async () => {
    const { cardId } = await state.createCharacter('内嵌版本')
    await state.saveCharacterLorebook(cardId, book('初始'))
    const initial = await service.getCharacterLorebook({ cardId })
    const saved = await service.saveCharacterLorebook({ cardId, json: { name: '空书', entries: {} }, expectedRevision: initial.revision })
    const empty = await service.getCharacterLorebook({ cardId })
    expect(empty.entryCount).toBe(0)
    expect(empty.revision).toBe(saved.revision)
    await expect(service.saveCharacterLorebook({ cardId, json: book('旧'), expectedRevision: initial.revision })).rejects.toThrow('修改')
    await expect(service.saveCharacterLorebook({ cardId, json: book('继续编辑'), expectedRevision: empty.revision })).resolves.toMatchObject({ entryCount: 1 })
  })

  it('聊天世界书同版本并发拒绝覆盖，另一个剧情的版本与内容保持独立', async () => {
    const { cardId } = await state.createCharacter('双剧情世界书')
    for (const sessionId of ['a', 'b']) await state.saveBinding({ sessionId, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const storyId = (await state.loadBinding('a'))!.storyId!, otherId = (await state.loadBinding('b'))!.storyId!
    const initial = await service.getChatLorebook({ cardId, storyId }), other = await service.getChatLorebook({ cardId, storyId: otherId })
    const results = await Promise.allSettled(['A', 'B'].map(content => service.saveChatLorebook({ cardId, storyId, json: book(content), expectedRevision: initial.revision })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await service.getChatLorebook({ cardId, storyId: otherId })).toEqual(other)
    const story = await state.storyWorkspace(cardId, storyId), path = 'assets/chat-lorebook.json'
    const before = await story.fs.readText(path)
    await expect(service.saveChatLorebook({ cardId, storyId, json: book('旧'), expectedRevision: initial.revision })).rejects.toThrow('另一窗口')
    expect(await story.fs.readText(path)).toBe(before)
    const latest = await service.getChatLorebook({ cardId, storyId })
    const switched = JSON.stringify(encodeChatWorldbooks({ active: 'side', books: new Map([['main', latest.json], ['side', book('卡面已切换书')]]) }))
    await story.fs.writeText(path, switched)
    await expect(service.saveChatLorebook({ cardId, storyId, json: book('旧活动书'), expectedRevision: latest.revision })).rejects.toThrow('另一窗口或卡面')
    expect(await story.fs.readText(path)).toBe(switched)
    await story.fs.writeText(path, '{broken')
    await expect(service.getChatLorebook({ cardId, storyId })).rejects.toThrow()
    await expect(service.saveChatLorebook({ cardId, storyId, json: book('不得清空') })).rejects.toThrow()
    expect(await story.fs.readText(path)).toBe('{broken')
  })
})

describe('人设数据边界', () => {
  const persona: Persona = { id: 'valid', name: '旅行者', description: '沿海旅行', avatar: null, lorebookId: 'coast' }
  it('双窗口旧版本保存拒绝覆盖，原文件与热缓存均保留最新人设', async () => {
    await state.savePersona(persona, null)
    const old = (await service.listPersonas({})).items[0]!
    const newer = { ...persona, description: 'B 窗口的新描述' }
    await service.savePersona({ persona: newer, expectedRevision: old.revision })
    const before = await fs.readText('personas/valid.json')
    await expect(service.savePersona({ persona: { ...persona, name: 'A 只改名称' }, expectedRevision: old.revision })).rejects.toThrow('另一窗口')
    expect(await fs.readText('personas/valid.json')).toBe(before)
    expect(await state.loadPersona(persona.id)).toEqual(newer)
    expect(JSON.parse(before!)).not.toHaveProperty('revision')
    await expect(service.savePersona({ persona: { ...persona, name: '旧客户端' } })).rejects.toThrow('另一窗口')
  })

  it('同一版本的并发写入只有一个成功，版本校验与落盘共用锁', async () => {
    await state.savePersona(persona)
    const revision = personaEditRevision(persona)
    const values = ['窗口 A', '窗口 B'].map(description => ({ ...persona, description }))
    const result = await Promise.allSettled(values.map(value => state.savePersona(value, revision)))
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(await state.loadPersona(persona.id)).toEqual(values[result.findIndex(item => item.status === 'fulfilled')])
  })

  it('新建不能覆盖已有身份，旧编辑也不能复活已删除人设', async () => {
    await state.savePersona(persona, null)
    await expect(state.savePersona({ ...persona, description: '同名新建' }, null)).rejects.toThrow('另一窗口')
    await state.deletePersona(persona.id)
    await expect(state.savePersona(persona, personaEditRevision(persona))).rejects.toThrow('删除')
    expect(await fs.readText('personas/valid.json')).toBeNull()
  })

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

/** 手动双窗口复现：旧空表不能清空刚新增的规则，损坏文件也不能作为空表授权覆盖。 */
describe('全局正则整表并发保存', () => {
  const rule: RegexRule = { id: 'display', name: '保留规则', find: 'before', replace: 'after', enabled: true,
    scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'user' }

  it('旧窗口保存空列表时拒绝清空新规则，旧客户端也不能覆盖已有表', async () => {
    const empty = await service.listRegexRules({})
    const saved = await service.saveRegexRules({ rules: [rule], expectedRevision: empty.revision })
    const before = await fs.readText('regex/rules.json')
    await expect(service.saveRegexRules({ rules: [], expectedRevision: empty.revision })).rejects.toThrow('另一窗口')
    await expect(service.saveRegexRules({ rules: [] })).rejects.toThrow('另一窗口')
    expect(await fs.readText('regex/rules.json')).toBe(before)
    expect(await state.listRegexRules()).toEqual([rule])
    await expect(service.saveRegexRules({ rules: [{ ...rule, enabled: false }], expectedRevision: saved.revision })).resolves.toMatchObject({ count: 1 })
  })

  it('相同版本的并发保存只有一个成功', async () => {
    const before = await service.listRegexRules({})
    const result = await Promise.allSettled(['A', 'B'].map(name => service.saveRegexRules({ rules: [{ ...rule, name }], expectedRevision: before.revision })))
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect((await state.listRegexRules())[0]?.name).toBe(['A', 'B'][result.findIndex(item => item.status === 'fulfilled')])
  })

  it.each(['{broken', '[{}]'])('损坏文件不能作为空表编辑或被旧空表覆盖：%s', async damaged => {
    const before = await service.listRegexRules({})
    await fs.writeText('regex/rules.json', damaged)
    await expect(service.listRegexRules({})).rejects.toThrow()
    await expect(service.saveRegexRules({ rules: [], expectedRevision: before.revision })).rejects.toThrow()
    expect(await fs.readText('regex/rules.json')).toBe(damaged)
  })

  it('服务直接调用的错误类型也必须拒绝，不能替换为空数组', async () => {
    const saved = await service.saveRegexRules({ rules: [rule] })
    await expect(service.saveRegexRules({ rules: null as unknown as RegexRule[], expectedRevision: saved.revision })).rejects.toThrow()
    expect(await state.listRegexRules()).toEqual([rule])
  })
})
