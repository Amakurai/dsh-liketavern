/** 大量净化重名的资产分配：真实目录与固定时钟验证超过 99 个占位后仍隔离新身份、保留原始别名与抢救正文。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

type Kind = 'lorebook' | 'preset' | 'persona'
const kinds: Kind[] = ['lorebook', 'preset', 'persona']
const base = 'crowded_', firstName = 'crowded?', secondName = 'crowded!', clock = 1_700_000_000_000
let root: string, state: TavernState
const directory = (kind: Kind) => join(root, ...(kind === 'persona' ? ['personas'] : ['library', kind === 'lorebook' ? 'lorebooks' : 'presets']))
const file = (kind: Kind, id: string) => join(directory(kind), `${id}.json`)
function value(kind: Kind, identity: string, body: string) {
  if (kind === 'lorebook') return { name: identity, entries: { one: { key: ['工厂'], content: body } } }
  if (kind === 'preset') return { identifier: identity, name: body, entries: [] }
  return { id: identity, name: body, description: body, avatar: null }
}
async function open() {
  const next = new TavernState({ root, characters: join(root, 'characters'), lorebooks: directory('lorebook'), presets: directory('preset'),
    personas: directory('persona'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({ cascadeDeleteEmbeddedBook: false }))
  await next.init(); return next
}
async function seed(kind: Kind, extraTimestamp = false) {
  const originals = new Map<string, string>()
  for (let index = 1; index <= 99; index++) {
    const id = index === 1 ? base : `${base}-${index}`, body = JSON.stringify(value(kind, id, `占位 ${index}`))
    await writeFile(file(kind, id), body); originals.set(id, body)
  }
  if (extraTimestamp) {
    const id = `${base}-${clock}`, body = JSON.stringify(value(kind, id, '已有时间戳正文'))
    await writeFile(file(kind, id), body); originals.set(id, body)
  }
  return originals
}
async function save(kind: Kind, name: string, body: string, target = state): Promise<string> {
  if (kind === 'lorebook') return target.saveLorebook(name, value(kind, name, body))
  if (kind === 'preset') return target.savePreset({ identifier: name, name: body, entries: [] })
  return target.savePersona({ id: name, name: body, description: body, avatar: null })
}
async function load(kind: Kind, name: string) {
  if (kind === 'lorebook') return state.loadLorebookJson(name)
  if (kind === 'preset') return state.loadPreset(name, true)
  return state.loadPersona(name, true)
}
async function remove(kind: Kind, name: string) {
  if (kind === 'lorebook') return state.deleteLorebook(name)
  if (kind === 'preset') return state.deletePreset(name)
  return state.deletePersona(name)
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tavern-asset-allocation-')); state = await open() })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.each(kinds)('%s 超过 99 个占位后，同毫秒的两个并发新身份不相互覆盖，旧别名仍可读写删除', async kind => {
  const originals = await seed(kind), other = await open()
  vi.spyOn(Date, 'now').mockReturnValue(clock)
  const [first, second] = await Promise.all([save(kind, firstName, 'FIRST-NEW-ASSET'), save(kind, secondName, 'SECOND-NEW-ASSET', other)])
  expect(first).not.toBe(second)
  expect(JSON.stringify(await load(kind, firstName))).toContain('FIRST-NEW-ASSET')
  expect(JSON.stringify(await load(kind, secondName))).toContain('SECOND-NEW-ASSET')
  for (const [id, body] of originals) expect(await readFile(file(kind, id), 'utf8')).toBe(body)
  const secondBefore = await readFile(file(kind, second), 'utf8')
  // 空出较早占位后，同身份导入仍回到原后缀；不能把新分配器变成另建副本。
  await rm(file(kind, base))
  expect(await save(kind, firstName, 'FIRST-UPDATED-ASSET')).toBe(first)
  expect(await readFile(file(kind, second), 'utf8')).toBe(secondBefore)
  await remove(kind, secondName)
  await expect(readFile(file(kind, second))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(await load(kind, firstName))).toContain('FIRST-UPDATED-ASSET')
})

it.each(kinds)('%s 的旧时间戳路径已存在时，新身份不能在回拨时钟下覆盖它', async kind => {
  const originals = await seed(kind, true)
  vi.spyOn(Date, 'now').mockReturnValue(clock)
  const id = await save(kind, firstName, 'CLOCK-ROLLBACK-NEW-ASSET')
  expect(originals.has(id)).toBe(false)
  for (const [name, body] of originals) expect(await readFile(file(kind, name), 'utf8')).toBe(body)
  expect(JSON.stringify(await load(kind, firstName))).toContain('CLOCK-ROLLBACK-NEW-ASSET')
})

it('世界书抢救在 99 个占位和旧时间戳均存在时仍创建独立副本，既有库书保持原样', async () => {
  const originals = await seed('lorebook', true)
  const card = await state.createCharacter('等待抢救的角色')
  await state.saveCharacterLorebook(card.cardId, value('lorebook', base, '需要保留的内嵌正文'))
  await state.archiveCharacter(card.cardId)
  vi.spyOn(Date, 'now').mockReturnValue(clock)
  const result = await state.deleteCharacter(card.cardId)
  expect(result.salvagedLorebook).toBeTruthy()
  expect(originals.has(result.salvagedLorebook!)).toBe(false)
  expect(JSON.stringify(await state.loadLorebookJson(result.salvagedLorebook!))).toContain('需要保留的内嵌正文')
  for (const [id, body] of originals) expect(await readFile(file('lorebook', id), 'utf8')).toBe(body)
  expect(await state.loadCharacter(card.cardId)).toBeNull()
})
