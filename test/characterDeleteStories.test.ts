/**
 * 永久删除玩过的角色：宿主没有会话删除事件，删除宿主会话或解除绑定后剧情残留。
 * 预检列出全部剧情并标注绑定状态；只有无绑定且出现在确认清单里的剧情随卡删除，
 * 仍被绑定、损坏绑定或预检之后新出现的剧情继续拒绝。真实文件系统。
 */
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { CharacterInUseError, TavernState } from '../src/node/state.js'

let root: string, state: TavernState
const bind = (sessionId: string, cardId: string) => state.saveBinding({ sessionId, cardId, presetId: null, personaId: null,
  lorebookIds: [], characterLorebookId: null, greetingIndex: 0, interactiveCards: false, helperMvu: false, createdAt: new Date(0).toISOString() })
const exists = (path: string) => access(path).then(() => true, () => false)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-delete-stories-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('解除绑定后残留的剧情经确认后随角色一并删除', async () => {
  const { cardId } = await state.createCharacter('玩过的角色')
  await bind('s-1', cardId)
  await bind('s-2', cardId)
  await state.clearBinding('s-1')
  await state.clearBinding('s-2')
  await state.archiveCharacter(cardId)

  const plan = await state.characterDeletePlan(cardId)
  expect(plan.boundSessionCount).toBe(0)
  expect(plan.stories).toHaveLength(2)
  expect(plan.stories.every(story => !story.bound)).toBe(true)

  // 未带确认清单：保持旧的保守行为。
  await expect(state.deleteCharacter(cardId)).rejects.toBeInstanceOf(CharacterInUseError)
  // 只确认一部分：其余剧情未经用户确认，整体拒绝且不删除任何东西。
  await expect(state.deleteCharacter(cardId, { discardStoryIds: [plan.stories[0]!.id] })).rejects.toBeInstanceOf(CharacterInUseError)
  expect(await exists(join(root, 'characters', cardId, 'card.json'))).toBe(true)

  await state.deleteCharacter(cardId, { discardStoryIds: plan.stories.map(story => story.id) })
  expect(await exists(join(root, 'characters', cardId))).toBe(false)
})

it('仍被会话绑定时预检标注绑定剧情，带全部剧情 ID 也拒绝删除', async () => {
  const { cardId } = await state.createCharacter('仍在玩')
  await bind('s-live', cardId)
  await bind('s-gone', cardId)
  await state.clearBinding('s-gone')
  await state.archiveCharacter(cardId)
  const liveStory = (await state.loadBinding('s-live'))!.storyId

  const plan = await state.characterDeletePlan(cardId)
  expect(plan.boundSessionCount).toBe(1)
  expect(plan.stories.map(story => [story.id === liveStory, story.bound])).toEqual(expect.arrayContaining([[true, true], [false, false]]))

  await expect(state.deleteCharacter(cardId, { discardStoryIds: plan.stories.map(story => story.id) })).rejects.toBeInstanceOf(CharacterInUseError)
  expect((await state.loadBinding('s-live'))?.storyId).toBe(liveStory)
  expect(await state.listStories(cardId)).toHaveLength(2)
})

it('预检之后新产生的剧情不在确认清单里，删除被拒绝', async () => {
  const { cardId } = await state.createCharacter('预检过期')
  await bind('s-old', cardId)
  await state.clearBinding('s-old')
  await state.archiveCharacter(cardId)
  const confirmed = (await state.characterDeletePlan(cardId)).stories.map(story => story.id)

  // 收纳中不能新建会话；确认框打开期间另一处恢复、再玩一局并重新收纳。
  await state.restoreCharacter(cardId)
  await bind('s-new', cardId)
  await state.clearBinding('s-new')
  await state.archiveCharacter(cardId)
  await expect(state.deleteCharacter(cardId, { discardStoryIds: confirmed })).rejects.toBeInstanceOf(CharacterInUseError)
  expect(await state.listStories(cardId)).toHaveLength(2)
})
