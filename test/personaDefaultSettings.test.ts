/** 人设自动默认项的竞争边界：真实宿主修订号与临时存储验证保存、删除不覆盖并发配置或显式选择。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { FileSettings } from './hostSettingsFactory.js'
import { Config, TAVERN_NS, resolveConfig } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

const contexts: Context[] = [], directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(operation: 'save' | 'delete') {
  const root = await mkdtemp(join(tmpdir(), 'tavern-persona-default-'))
  directories.push(root)
  const profile = join(root, 'settings.json'), ctx = new Context()
  contexts.push(ctx)
  const persona = { id: 'target-persona', name: '所选人设', description: '保留的资产', avatar: null }
  await writeFile(profile, JSON.stringify({ [TAVERN_NS]: { defaults: {
    cardId: 'old-card', presetId: 'old-preset', personaId: operation === 'save' ? '' : persona.id,
    lorebookIds: ['old-book'], characterLorebookId: 'old-main',
  } } }))
  const actual = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig(actual.get()))
  await state.init()
  if (operation === 'delete') await state.savePersona(persona)
  return { profile, ctx, persona, actual, state }
}

it.each([
  ['save', 'other-fields'], ['save', 'explicit-persona'],
  ['delete', 'other-fields'], ['delete', 'explicit-persona'],
] as const)('%s 的默认项写入排队时发生 %s，更晚的用户选择与无关设置必须保留', async (operation, concurrent) => {
  const { profile, ctx, persona, actual, state } = await fixture(operation)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let writes = 0
  const scope = { get: actual.get, revision: actual.revision, update: async (patch: object, revision?: number) => {
    if (++writes === 1) { entered.resolve(); await release.promise }
    await actual.update(patch, revision)
  } }
  const service = new TavernService(ctx, state, scope)
  const pending = operation === 'save' ? service.savePersona({ persona, expectedRevision: null }) : service.deletePersona({ id: persona.id })
  try {
    await entered.promise
    const changed = { cardId: 'new-card', presetId: 'new-preset', lorebookIds: ['new-book'], characterLorebookId: 'new-main',
      ...(concurrent === 'explicit-persona' ? { personaId: 'user-selected-persona' } : {}) }
    await actual.update({ defaults: changed })
    release.resolve()
    const result = await pending
    if (operation === 'save') expect(result).not.toHaveProperty('defaultWarning')
    const expectedPersona = concurrent === 'explicit-persona' ? 'user-selected-persona' : operation === 'save' ? persona.id : ''
    const expected = { ...changed, personaId: expectedPersona }
    expect(actual.get().defaults).toEqual(expected)
    expect(JSON.parse(await readFile(profile, 'utf8'))).toMatchObject({ [TAVERN_NS]: { defaults: expected } })
    expect(await state.loadPersona(persona.id)).toEqual(operation === 'save' ? persona : null)
    const restarted = new Context()
    contexts.push(restarted)
    expect((await new FileSettings(restarted, profile).register(TAVERN_NS, Config)).get().defaults).toEqual(expected)
  } finally { release.resolve(); await pending }
})

it('配置持续竞争时有限次拒绝自动默认项，已保存的人设仍可带回执继续编辑', async () => {
  const { ctx, persona, actual, state } = await fixture('save')
  let competing = true, writes = 0
  const scope = { ...actual, update: async (patch: object, revision?: number) => {
    writes++
    if (competing) await actual.update({ defaults: { presetId: `other-window-${writes}` } })
    await actual.update(patch, revision)
  } }
  const service = new TavernService(ctx, state, scope)
  const result = await service.savePersona({ persona, expectedRevision: null })
  expect(result.defaultWarning).toEqual(expect.any(String))
  expect(writes).toBeGreaterThan(0)
  expect(writes).toBeLessThanOrEqual(5)
  expect(await state.loadPersona(persona.id)).toEqual(persona)
  expect(actual.get().defaults.personaId).toBe('')
  const concurrentPreset = actual.get().defaults.presetId
  competing = false
  const edited = { ...persona, description: '继续编辑的正文' }
  expect(await service.savePersona({ persona: edited, expectedRevision: result.revision })).not.toHaveProperty('defaultWarning')
  expect(await state.loadPersona(persona.id)).toEqual(edited)
  expect(actual.get().defaults).toMatchObject({ personaId: persona.id, presetId: concurrentPreset })
})
