/** 人设损坏的绑定恢复边界：真实剧情、绑定文件与模拟宿主会话验证错误不触发静默换人设，修复后仍接回原剧情。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { loadBinding } from '../src/node/bindings.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'

let root: string, paths: TavernPaths
const sessionId = 'session-persona-recovery'
const chosen = { id: 'chosen', name: '原人设', description: '原人设描述', avatar: null }
const fallback = { id: 'fallback', name: '默认人设', description: '默认描述', avatar: null }
async function open() {
  const state = new TavernState(paths, () => resolveConfig({ defaults: { personaId: fallback.id } }))
  await state.init()
  return state
}
function service(state: TavernState) {
  const session = Session.create(sessionId as Session['id'])
  const host = { reflect: { provide: () => {} }, get: () => undefined,
    sessions: { get: (id: string) => id === sessionId ? session : undefined } } as unknown as Context
  const settings = { get: () => ({}), revision: () => 0, update: async () => {} } as TavernSettingsScope
  return new TavernService(host, state, settings)
}
async function fixture(personaId: string | null = chosen.id) {
  const state = await open()
  await state.savePersona(chosen); await state.savePersona(fallback)
  const card = await state.createCharacter('保留剧情的角色')
  await state.saveBinding({ sessionId, cardId: card.cardId, presetId: null, personaId,
    lorebookIds: [], characterLorebookId: null, greetingIndex: 0, interactiveCards: false, helperMvu: false, createdAt: new Date(0).toISOString() })
  const binding = (await loadBinding(paths, sessionId, true))!
  const before = await readFile(sessionFile(paths, sessionId), 'utf8')
  return { state, binding, before }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-corrupt-persona-'))
  paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it.each(['{"id":', JSON.stringify({ ...chosen, name: 42 })])('明确绑定的人设损坏时拒绝自愈写回，修复后仍使用原绑定和剧情：%s', async broken => {
  const { binding, before } = await fixture()
  const file = join(paths.personas, `${chosen.id}.json`)
  const original = await readFile(file, 'utf8')
  await writeFile(file, broken)
  const restarted = await open()
  // 普通列表/容错读取可以跳过坏资产，但这条空结果不能授权绑定恢复换成人设 fallback。
  expect(await restarted.loadPersona(chosen.id)).toBeNull()
  expect(await restarted.loadStoryBinding(sessionId)).toEqual(binding)
  await expect(service(restarted).getSessionBinding({ sessionId })).rejects.toThrow(/人设.*损坏/)
  expect(await readFile(sessionFile(paths, sessionId), 'utf8')).toBe(before)
  await writeFile(file, original)
  expect(await service(restarted).getSessionBinding({ sessionId })).toMatchObject({ binding, userName: chosen.name })
})

it('默认人设损坏时也不把绑定写成另一条唯一人设，修复后才正常接上默认项', async () => {
  const { binding, before } = await fixture(null)
  const file = join(paths.personas, `${fallback.id}.json`), original = await readFile(file, 'utf8')
  await writeFile(file, '{}')
  const restarted = await open()
  await expect(service(restarted).getSessionBinding({ sessionId })).rejects.toThrow(/人设.*损坏/)
  expect(await readFile(sessionFile(paths, sessionId), 'utf8')).toBe(before)
  await writeFile(file, original)
  expect(await service(restarted).getSessionBinding({ sessionId })).toMatchObject({ binding: { ...binding, personaId: fallback.id }, userName: fallback.name })
})

it('有效的明确人设优先于损坏默认项，不因无关默认文件影响当前扮演', async () => {
  const { binding } = await fixture()
  await writeFile(join(paths.personas, `${fallback.id}.json`), '{}')
  expect(await service(await open()).getSessionBinding({ sessionId })).toMatchObject({ binding, userName: chosen.name })
})

it('选中人设确实删除时仍回退到默认项，保留当前剧情身份', async () => {
  const { state, binding } = await fixture()
  await state.deletePersona(chosen.id)
  expect(await service(await open()).getSessionBinding({ sessionId })).toMatchObject({ binding: { ...binding, personaId: fallback.id }, userName: fallback.name })
})
