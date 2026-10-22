/**
 * 绑定自愈不能把「卡不可读」当成「卡已删除」：card.json 损坏时，旧实现会按
 * 「只剩一张卡」把会话静默改绑到另一角色并新建剧情，或在多卡时直接删除绑定。
 * 对照 SillyTavern #5941（读失败被当成空聊天后写回覆盖）。真实文件系统，重新构造
 * TavernState 模拟重启后读取，避免进程内解析缓存掩盖磁盘状态。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'

let root: string, paths: TavernPaths
const open = async (): Promise<TavernState> => {
  const state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  return state
}
const bind = (state: TavernState, sessionId: string, cardId: string) => state.saveBinding({ sessionId, cardId, presetId: null, personaId: null,
  lorebookIds: [], characterLorebookId: null, greetingIndex: 0, interactiveCards: false, helperMvu: false, createdAt: new Date(0).toISOString() })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-corrupt-card-'))
  paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('card.json 损坏且库里只剩另一张卡时，不把会话改绑到那张卡', async () => {
  const state = await open()
  const { cardId: broken } = await state.createCharacter('甲')
  const { cardId: other } = await state.createCharacter('乙')
  await bind(state, 's-a', broken)
  const before = await readFile(sessionFile(paths, 's-a'), 'utf8')
  await writeFile(join(paths.characters, broken, 'card.json'), '{"name": "甲",', 'utf8')

  const restarted = await open()
  await expect(restarted.loadBinding('s-a')).rejects.toThrow(/角色卡.*无法读取/)
  expect(await readFile(sessionFile(paths, 's-a'), 'utf8')).toBe(before)
  expect(other).not.toBe(broken)
})

it('card.json 损坏且库里有多张卡时，不删除绑定文件', async () => {
  const state = await open()
  const { cardId: broken } = await state.createCharacter('甲')
  await state.createCharacter('乙')
  await state.createCharacter('丙')
  await bind(state, 's-b', broken)
  await rm(join(paths.characters, broken, 'card.json'))

  const restarted = await open()
  await expect(restarted.loadBinding('s-b')).rejects.toThrow(/角色卡.*无法读取/)
  expect(JSON.parse(await readFile(sessionFile(paths, 's-b'), 'utf8')).cardId).toBe(broken)
})

it('卡目录真正被删除时仍按唯一同名卡自愈接回', async () => {
  const state = await open()
  const { cardId: gone } = await state.createCharacter('甲')
  await bind(state, 's-c', gone)
  const { cardId: again } = await state.createCharacter('甲')
  await rm(join(paths.characters, gone), { recursive: true, force: true })

  const restarted = await open()
  expect((await restarted.loadBinding('s-c'))?.cardId).toBe(again)
})
