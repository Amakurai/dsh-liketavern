/** 人设文件身份回归：真实资产、绑定与服务接口验证旧 JSON 的 id 不会把选择、编辑或删除指向另一份文件，修订和旧别名仍可用。 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'

let root: string, paths: TavernPaths, state: TavernState, service: TavernService
const sessionId = 'persona-file-identity'
const selected = { id: 'other', name: '所选旧人设', description: '所选正文', avatar: null }
const other = { id: 'other', name: '另一人设', description: '必须保留的正文', avatar: null }
const file = (id: string) => join(paths.personas, `${id}.json`)
const open = async () => { const next = new TavernState(paths, () => resolveConfig({})); await next.init(); return next }
function remote(next: TavernState) {
  const session = Session.create(sessionId as Session['id'])
  const ctx = { reflect: { provide: () => {} }, get: () => undefined,
    sessions: { get: (id: string) => id === sessionId ? session : undefined } } as unknown as Context
  const settings = { get: () => ({ defaults: { personaId: other.id } }), revision: () => 0, update: async () => {} } as TavernSettingsScope
  return new TavernService(ctx, next, settings)
}
async function write(id: string, value: unknown) { await writeFile(file(id), JSON.stringify(value)) }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-persona-file-'))
  paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'), presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  state = await open(); service = remote(state)
  await write('chosen', selected); await write('other', other)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('列表和读取使用实际文件 ID，删除所选旧人设不会删掉 JSON id 指向的另一份', async () => {
  const before = await readFile(file('other'), 'utf8'), selectedBefore = await readFile(file('chosen'), 'utf8')
  const entry = (await service.listPersonas({})).items.find(item => item.name === selected.name)!
  expect(entry.id).toBe('chosen')
  expect(await state.loadPersona('chosen', true)).toEqual({ ...selected, id: 'chosen' })
  expect(await readFile(file('chosen'), 'utf8')).toBe(selectedBefore)
  await service.deletePersona({ id: entry.id })
  await expect(readFile(file('chosen'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(file('other'), 'utf8')).toBe(before)
})

it('按列表修订编辑旧人设只修改选中文件，不新建副本或覆盖另一份', async () => {
  const before = await readFile(file('other'), 'utf8')
  const { revision, ...persona } = (await service.listPersonas({})).items.find(item => item.name === selected.name)!
  await expect(service.savePersona({ persona: { ...persona, description: '修改所选正文' }, expectedRevision: revision })).resolves.toMatchObject({ id: 'chosen' })
  expect(await state.loadPersona('chosen', true)).toMatchObject({ id: 'chosen', description: '修改所选正文' })
  expect((await state.listPersonas()).map(item => item.id).sort()).toEqual(['chosen', 'other'])
  expect(await readFile(file('other'), 'utf8')).toBe(before)
})

it('绑定读取保留所选文件与剧情身份，不因文件内旧 id 静默改绑另一人设', async () => {
  await write('chosen', { ...selected, id: 'chosen' })
  const card = await state.createCharacter('文件身份角色')
  await state.saveBinding({ sessionId, cardId: card.cardId, presetId: null, personaId: 'chosen', lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding(sessionId))!, before = await readFile(sessionFile(paths, sessionId), 'utf8')
  await write('chosen', selected)
  expect(await remote(await open()).getSessionBinding({ sessionId })).toMatchObject({ binding, userName: selected.name })
  expect(await readFile(sessionFile(paths, sessionId), 'utf8')).toBe(before)
})

it('同一旧原始身份的两份副本各用实际文件 ID 编辑，保存后仍保留旧别名的歧义检查', async () => {
  const legacy = { ...selected, id: 'traveler name', name: '旧备份旅人' }
  await write('traveler_name', legacy); await write('traveler_name-2', legacy)
  const items = (await service.listPersonas({})).items.filter(item => item.name === legacy.name)
  expect(items.map(item => item.id).sort()).toEqual(['traveler_name', 'traveler_name-2'])
  const before = await readFile(file('traveler_name'), 'utf8')
  const { revision, ...persona } = items.find(item => item.id === 'traveler_name-2')!
  await service.savePersona({ persona: { ...persona, name: '只改后缀副本' }, expectedRevision: revision })
  expect(await readFile(file('traveler_name'), 'utf8')).toBe(before)
  await expect(state.loadPersona(legacy.id)).rejects.toThrow('资产身份对应多个文件')
  await state.deletePersona('traveler_name')
  expect(await state.loadPersona(legacy.id)).toMatchObject({ id: 'traveler_name-2', name: '只改后缀副本' })
})

it.each(['modified', 'deleted'] as const)('旧人设的文件已被 %s 时，修订保存仍拒绝且不改另一份', async change => {
  const { revision, ...persona } = (await service.listPersonas({})).items.find(item => item.name === selected.name)!
  const before = await readFile(file('other'), 'utf8')
  if (change === 'modified') await write('chosen', { ...selected, description: '另一窗口的新正文' })
  else await rm(file('chosen'))
  await expect(service.savePersona({ persona: { ...persona, name: '过时编辑' }, expectedRevision: revision })).rejects.toThrow(/另一窗口|删除/)
  expect(await readFile(file('other'), 'utf8')).toBe(before)
  if (change === 'modified') expect(JSON.parse(await readFile(file('chosen'), 'utf8')).description).toBe('另一窗口的新正文')
  else await expect(readFile(file('chosen'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('人设列表只展示可直接定位的文件，子目录备份与非法文件名不冒充可编辑项', async () => {
  await mkdir(join(paths.personas, 'backup'))
  await writeFile(join(paths.personas, 'backup', 'other.json'), JSON.stringify(other))
  await write('unsafe name', other)
  expect((await state.listPersonas()).map(item => item.id).sort()).toEqual(['chosen', 'other'])
})

it.runIf(process.platform === 'win32')('Windows 大小写别名冷读和修订保存都返回实际文件拼写', async () => {
  const restarted = await open(), target = remote(restarted)
  expect(await restarted.loadPersona('CHOSEN', true)).toMatchObject({ id: 'chosen', name: selected.name })
  const { revision, ...persona } = (await target.listPersonas({})).items.find(item => item.id === 'chosen')!
  await expect(target.savePersona({ persona: { ...persona, id: 'CHOSEN', name: '别名编辑' }, expectedRevision: revision })).resolves.toMatchObject({ id: 'chosen' })
  expect(await restarted.loadPersona('CHOSEN')).toMatchObject({ id: 'chosen', name: '别名编辑' })
  expect(await restarted.loadPersona('other')).toEqual(other)
})

it.runIf(process.platform !== 'win32')('大小写敏感平台的两份旧人设独立编辑，不能按相同 JSON id 合并', async () => {
  await write('Chosen', selected)
  const { revision, ...persona } = (await service.listPersonas({})).items.find(item => item.id === 'Chosen')!
  const before = await readFile(file('chosen'), 'utf8')
  await service.savePersona({ persona: { ...persona, description: '大写文件修改' }, expectedRevision: revision })
  expect(await readFile(file('chosen'), 'utf8')).toBe(before)
  expect(await state.loadPersona('Chosen')).toMatchObject({ id: 'Chosen', description: '大写文件修改' })
})
