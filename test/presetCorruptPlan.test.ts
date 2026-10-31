/** 选中预设损坏的真实剧情回归：首次组装明确失败、不冻结默认计划，修复可重试；已成功冻结的轮次仍按原快照继续。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'

let root: string, paths: TavernPaths
const sessionId = 'selected-preset-story', marker = 'SELECTED-PRESET-ONLY-RULE'
async function open() {
  const state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  return state
}
async function fixture() {
  const state = await open(), card = await state.createCharacter('预设故障工厂角色')
  const preset = defaultPreset()
  preset.identifier = 'selected-preset'; preset.name = '剧情专用预设'; preset.entries[0]!.content = marker
  preset.sampling = { temperature: 0.35 }
  const presetId = await state.savePreset(preset)
  await state.saveBinding({ sessionId, cardId: card.cardId, presetId, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  return { state, presetId, binding: (await state.loadBinding(sessionId))!, file: join(paths.presets, `${presetId}.json`) }
}
const run = (state: TavernState) => runTavernPipeline({ state, sessionId, agent: null, mode: 'live', historyOverride: [{ role: 'user', content: '继续剧情' }] })
const service = (state: TavernState) => new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-corrupt-preset-plan-'))
  paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'), presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.each(['{"entries":', '{"identifier":"selected-preset","name":"坏预设","entries":[null]}'])('坏预设不冻结默认正文或采样，修复后原层可重试：%s', async broken => {
  const { presetId, binding, file } = await fixture(), original = await readFile(file, 'utf8')
  const before = await readFile(sessionFile(paths, sessionId), 'utf8')
  await writeFile(file, broken)
  const restarted = await open()
  // 列表的容错空缓存不能冒充已成功读取了当前预设。
  expect(await restarted.loadPreset(presetId)).toBeNull()
  await expect(service(restarted).getPreset({ id: presetId })).rejects.toThrow(/预设.*损坏/)
  await onTurnStart(restarted, sessionId, 1)
  const ws = await restarted.storyWorkspace(binding.cardId, binding.storyId)
  const templateBefore = await ws.fs.readText('state/template.json')
  const error = await run(restarted).then(() => null, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/预设.*损坏/)
  expect(restarted.turnPlans.has(sessionId)).toBe(false)
  expect(restarted.pendingTurnPlans.has(sessionId)).toBe(false)
  expect(await ws.fs.readText('state/template.json')).toBe(templateBefore)
  expect(await readFile(sessionFile(paths, sessionId), 'utf8')).toBe(before)
  await writeFile(file, original)
  const recovered = await run(restarted)
  expect(recovered?.standing).toContain(marker)
  expect(recovered?.sampling.temperature).toBe(0.35)
})

it('已冻结轮次不重读预设；下一轮遇坏文件才拒绝，不能把旧规则钉到默认计划', async () => {
  const { state, presetId, file } = await fixture()
  await onTurnStart(state, sessionId, 1)
  const frozen = await run(state)
  const unavailable = vi.spyOn(state, 'loadPreset').mockRejectedValue(new Error('模拟预设暂时不可读'))
  expect(await run(state)).toBe(frozen)
  expect(unavailable).not.toHaveBeenCalled()
  unavailable.mockRestore()
  await onTurnEnd(state, sessionId)
  // 删除使进程内修订失效，随后模拟外部恢复留下坏 JSON；其余文件与楼层生命周期均为真实实现。
  await state.deletePreset(presetId)
  await writeFile(file, '{}')
  await onTurnStart(state, sessionId, 2)
  const error = await run(state).then(() => null, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/预设.*损坏/)
  expect(state.turnPlans.has(sessionId)).toBe(false)
  expect(frozen?.standing).toContain(marker)
})

it('预设确实删除时沿用内建默认回退，剧情绑定身份不变', async () => {
  const { state, presetId, binding } = await fixture()
  await state.deletePreset(presetId)
  await expect(service(state).getPreset({ id: presetId })).rejects.toThrow(/预设.*不存在/)
  await onTurnStart(state, sessionId, 1)
  expect(await run(state)).not.toBeNull()
  expect(await state.loadBinding(sessionId)).toEqual(binding)
})
