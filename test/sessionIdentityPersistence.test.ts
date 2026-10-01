/** 会话绑定持久化身份回归：净化/大小写别名不能改写其它会话，换绑失败不遗留孤儿剧情。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deleteBinding, loadBinding, saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'

const fault = vi.hoisted(() => ({ bindingFile: '', afterRename: false, failReadback: false, readFile: '', readFailures: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (fault.readFailures && String(args[0]) === fault.readFile) {
      fault.readFailures--
      throw new Error('测试：绑定暂不可读')
    }
    return actual.readFile(...args)
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.bindingFile && String(args[1]) === fault.bindingFile) {
      fault.bindingFile = ''
      if (fault.afterRename) {
        fault.afterRename = false
        await actual.rename(...args)
        if (fault.failReadback) { fault.readFile = String(args[1]); fault.readFailures = 2 }
      }
      throw new Error('测试：绑定替换失败')
    }
    return actual.rename(...args)
  } }
})

let root: string, paths: TavernPaths, state: TavernState
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-identity-'))
  paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
})
afterEach(async () => {
  Object.assign(fault, { bindingFile: '', afterRename: false, failReadback: false, readFile: '', readFailures: 0 })
  vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
})

function binding(sessionId: string, cardId = 'card-test'): SessionBinding {
  return { sessionId, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: '2026-01-01T00:00:00.000Z' }
}

it.each([['s/session', 's_session'], ['s:session', 's?session']])('净化同名会话 %s / %s 不能覆盖或删除已存在的绑定', async (owner, alias) => {
  const original = binding(owner)
  await saveBinding(paths, original)
  await expect(deleteBinding(paths, alias)).rejects.toThrow(/身份|另一会话/)
  expect(await loadBinding(paths, owner)).toEqual(original)
  await expect(saveBinding(paths, binding(alias, 'other-card'))).rejects.toThrow(/身份|另一会话/)
  expect(await loadBinding(paths, owner)).toEqual(original)
  expect(await loadBinding(paths, alias)).toBeNull()
})

it.skipIf(process.platform !== 'win32')('Windows 会话 ID 大小写别名不能覆盖或删除原绑定', async () => {
  const original = binding('CaseSession')
  await saveBinding(paths, original)
  await expect(deleteBinding(paths, 'casesession')).rejects.toThrow(/身份|另一会话/)
  await expect(saveBinding(paths, binding('casesession', 'other-card'))).rejects.toThrow(/身份|另一会话/)
  expect(await loadBinding(paths, 'CaseSession')).toEqual(original)
})

it('净化同名会话并发首次保存只有一份绑定成功，失败方不覆盖成功方', async () => {
  const candidates = [binding('s/session'), binding('s_session', 'other-card')]
  const results = await Promise.allSettled(candidates.map(value => saveBinding(paths, value)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = candidates[results.findIndex(result => result.status === 'fulfilled')]!
  expect(await loadBinding(paths, winner.sessionId)).toEqual(winner)
})

it.skipIf(process.platform !== 'win32')('同一卡片大小写别名只更新绑定字段，保留剧情与事实', async () => {
  const cardId = (await state.createCharacter('会话身份角色')).cardId
  await state.saveBinding(binding('session', cardId))
  const original = (await state.loadBinding('session'))!
  const ws = await state.storyWorkspace(cardId, original.storyId)
  await ws.memory.write({ body: '这条剧情的已知事实' })
  await state.saveBinding({ ...original, cardId: cardId.toUpperCase(), storyId: undefined, presetId: 'changed' })

  const changed = (await state.loadBinding('session'))!
  expect(changed.cardId).toBe(original.cardId)
  expect(changed.storyId).toBe(original.storyId)
  expect(changed.presetId).toBe('changed')
  expect((await (await state.storyWorkspace(changed.cardId, changed.storyId)).memory.list()).map(entry => entry.body)).toEqual(['这条剧情的已知事实'])
  expect(await state.listStories(cardId)).toHaveLength(1)
})

it('换卡绑定落盘失败保留原绑定，并清理本次新建的未绑定剧情', async () => {
  const cardId = (await state.createCharacter('原角色')).cardId
  const otherCardId = (await state.createCharacter('新角色')).cardId
  await state.saveBinding(binding('session', cardId))
  const original = (await state.loadBinding('session'))!
  fault.bindingFile = sessionFile(paths, 'session')

  await expect(state.saveBinding({ ...original, cardId: otherCardId, storyId: undefined })).rejects.toThrow('绑定替换失败')
  expect(await state.loadBinding('session')).toEqual(original)
  expect(await state.listStories(otherCardId)).toEqual([])
})

it('绑定替换实际成功后才报错时读回确认完成，保留已绑定的新剧情', async () => {
  const cardId = (await state.createCharacter('原角色')).cardId
  const otherCardId = (await state.createCharacter('新角色')).cardId
  await state.saveBinding(binding('session', cardId))
  const original = (await state.loadBinding('session'))!
  fault.bindingFile = sessionFile(paths, 'session')
  fault.afterRename = true

  await expect(state.saveBinding({ ...original, cardId: otherCardId, storyId: undefined })).resolves.toBeUndefined()
  const changed = (await state.loadBinding('session'))!
  expect(changed.cardId).toBe(otherCardId)
  expect(changed.storyId).not.toBe(original.storyId)
  expect((await state.listStories(otherCardId)).map(story => story.id)).toEqual([changed.storyId])
})

it('绑定已替换但读回连续失败时，不能把不可读绑定当作未绑定而删除新剧情', async () => {
  const cardId = (await state.createCharacter('原角色')).cardId
  const otherCardId = (await state.createCharacter('新角色')).cardId
  await state.saveBinding(binding('session', cardId))
  const original = (await state.loadBinding('session'))!
  fault.bindingFile = sessionFile(paths, 'session')
  fault.afterRename = true
  fault.failReadback = true

  await expect(state.saveBinding({ ...original, cardId: otherCardId, storyId: undefined })).rejects.toThrow('绑定替换失败')
  const changed = (await state.loadBinding('session'))!
  expect(changed.cardId).toBe(otherCardId)
  expect((await state.listStories(otherCardId)).map(story => story.id)).toEqual([changed.storyId])
})

it('非法新绑定在准备剧情前拒绝，不发布无法归属的剧情', async () => {
  const cardId = (await state.createCharacter('非法绑定角色')).cardId
  await expect(state.saveBinding({ ...binding('session', cardId), greetingIndex: -1 })).rejects.toThrow()
  expect(await state.listStories(cardId)).toEqual([])
})
