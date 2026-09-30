/**
 * 自带官方 MVU 框架脚本的角色卡在首次绑定时自动开启原生 MVU：
 * 否则变量永不初始化、卡面脚本一直等待，用户看到的是「MVU 不能用」。
 * 客户端显式关闭时保持关闭；没有 MVU 框架的卡片不受影响。已有未表态的绑定由页面经 enableHelperMvu 跟随卡片开启，
 * 设置页的显式开启可覆盖此前的关闭；两者都需认领宿主空闲。真实文件存储 + 真实服务。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { TavernService, type TavernSettingsScope } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';"
let root: string, state: TavernState, service: TavernService
const settings = { get: () => ({}) } as unknown as TavernSettingsScope

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mvu-auto-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'), presets: join(root, 'library/presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const ctx = { reflect: { provide: () => {} }, sessions: { get: () => undefined }, get: () => undefined } as unknown as Context
  service = new TavernService(ctx, state, settings)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function card(content: string, enabled = true): Promise<string> {
  const { cardId } = await state.createCharacter('MVU 工厂')
  const library = await state.getHelperScriptLibrary({ type: 'character', cardId })
  await state.saveHelperScriptLibrary(library.target, library.revision, [{ type: 'script', value: { id: 'mvu', name: '[MVU]变量框架', enabled,
    content, info: '', button: { enabled: false, buttons: [] }, data: {} } }])
  return cardId
}
const bind = (sessionId: string, cardId: string, extra: Record<string, unknown> = {}) => service.setSessionBinding({ binding: {
  sessionId, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0,
  createdAt: new Date(0).toISOString(), ...extra } })

it('首次绑定自带官方 MVU 框架的卡片时开启原生 MVU', async () => {
  const cardId = await card(MVU_IMPORT)
  await bind('session-a', cardId)
  expect((await state.loadBinding('session-a'))?.helperMvu).toBe(true)
})

it('客户端显式关闭、禁用的框架脚本或普通卡片都不自动开启', async () => {
  const cardId = await card(MVU_IMPORT)
  await bind('session-off', cardId, { helperMvu: false })
  expect((await state.loadBinding('session-off'))?.helperMvu).toBe(false)
  await bind('session-disabled', await card(MVU_IMPORT, false))
  expect((await state.loadBinding('session-disabled'))?.helperMvu).toBeUndefined()
  await bind('session-plain', await card("console.log('plain')"))
  expect((await state.loadBinding('session-plain'))?.helperMvu).toBeUndefined()
})

it('同卡再次保存不覆盖用户之后的关闭选择', async () => {
  const cardId = await card(MVU_IMPORT)
  await bind('session-b', cardId)
  const saved = (await state.loadBinding('session-b'))!
  await service.setSessionBinding({ binding: { ...saved, helperMvu: undefined } })
  expect((await state.loadBinding('session-b'))?.helperMvu).toBeUndefined()
})

async function addMvuScript(cardId: string): Promise<void> {
  const library = await state.getHelperScriptLibrary({ type: 'character', cardId })
  await state.saveHelperScriptLibrary(library.target, library.revision, [{ type: 'script', value: { id: 'mvu', name: '[MVU]变量框架', enabled: true,
    content: MVU_IMPORT, info: '', button: { enabled: false, buttons: [] }, data: {} } }])
}
const storyOf = async (sessionId: string) => (await state.loadBinding(sessionId))!.storyId!

it('全局脚本库中的官方入口同样在首次绑定时开启', async () => {
  const global = await state.getHelperScriptLibrary({ type: 'global' })
  await state.saveHelperScriptLibrary(global.target, global.revision, [{ type: 'script', value: { id: 'global-mvu', name: 'MVU', enabled: true,
    content: MVU_IMPORT, info: '', button: { enabled: false, buttons: [] }, data: {} } }])
  await bind('session-global', await card("console.log('plain')"))
  expect((await state.loadBinding('session-global'))?.helperMvu).toBe(true)
})

it('绑定后才导入 MVU 脚本的旧会话由跟随模式开启，页面脚本包先给出跟随标记', async () => {
  const cardId = await card("console.log('plain')")
  await bind('session-late', cardId)
  expect((await state.loadBinding('session-late'))?.helperMvu).toBeUndefined()
  await addMvuScript(cardId)
  const storyId = await storyOf('session-late')
  const before = await service.getHelperScriptBundle({ sessionId: 'session-late' })
  expect(before).toMatchObject({ helperMvu: false, helperMvuFollow: true })
  expect(await service.enableHelperMvu({ sessionId: 'session-late', storyId, mode: 'follow' })).toEqual({ enabled: true, changed: true })
  const saved = (await state.loadBinding('session-late'))!
  expect(saved).toMatchObject({ helperMvu: true, storyId, cardId })
  expect(await service.enableHelperMvu({ sessionId: 'session-late', storyId, mode: 'follow' })).toEqual({ enabled: true, changed: false })
  expect(await service.getHelperScriptBundle({ sessionId: 'session-late' })).toMatchObject({ helperMvu: true, helperMvuFollow: false })
})

it('跟随模式尊重显式关闭，设置页显式开启可以覆盖', async () => {
  const cardId = await card(MVU_IMPORT)
  await bind('session-off', cardId, { helperMvu: false })
  const storyId = await storyOf('session-off')
  expect(await service.getHelperScriptBundle({ sessionId: 'session-off' })).toMatchObject({ helperMvu: false, helperMvuFollow: false })
  expect(await service.enableHelperMvu({ sessionId: 'session-off', storyId, mode: 'follow' })).toEqual({ enabled: false, changed: false })
  expect((await state.loadBinding('session-off'))?.helperMvu).toBe(false)
  expect(await service.enableHelperMvu({ sessionId: 'session-off', storyId, mode: 'explicit' })).toEqual({ enabled: true, changed: true })
  expect((await state.loadBinding('session-off'))?.helperMvu).toBe(true)
})

it('没有官方入口、交互卡关闭或剧情已改变时不开启', async () => {
  await bind('session-plain', await card("console.log('plain')"))
  const plainStory = await storyOf('session-plain')
  expect(await service.enableHelperMvu({ sessionId: 'session-plain', storyId: plainStory, mode: 'follow' })).toEqual({ enabled: false, changed: false })
  expect((await state.loadBinding('session-plain'))?.helperMvu).toBeUndefined()

  const cardId = await card(MVU_IMPORT)
  await bind('session-cards-off', cardId, { interactiveCards: false })
  const storyId = await storyOf('session-cards-off')
  expect(await service.enableHelperMvu({ sessionId: 'session-cards-off', storyId, mode: 'follow' })).toEqual({ enabled: false, changed: false })
  await expect(service.enableHelperMvu({ sessionId: 'session-cards-off', storyId, mode: 'explicit' })).rejects.toThrow('交互卡已关闭')
  expect((await state.loadBinding('session-cards-off'))?.helperMvu).toBeUndefined()

  await expect(service.enableHelperMvu({ sessionId: 'session-plain', storyId: 'other-story', mode: 'explicit' })).rejects.toThrow('剧情绑定已改变')
})

it('宿主正在生成时拒绝开启且不改绑定，空闲后跟随成功', async () => {
  const cardId = await card("console.log('plain')")
  await bind('session-busy', cardId)
  await addMvuScript(cardId)
  const storyId = await storyOf('session-busy')
  const agent = { status: 'running' as string, runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) }
  const busyCtx = { reflect: { provide: () => {} }, sessions: { get: () => undefined }, get: () => undefined, agents: { get: () => agent } } as unknown as Context
  const busy = new TavernService(busyCtx, state, settings)
  await expect(busy.enableHelperMvu({ sessionId: 'session-busy', storyId, mode: 'follow' })).rejects.toThrow('请等待当前生成')
  expect((await state.loadBinding('session-busy'))?.helperMvu).toBeUndefined()
  agent.status = 'idle'
  expect(await busy.enableHelperMvu({ sessionId: 'session-busy', storyId, mode: 'follow' })).toEqual({ enabled: true, changed: true })
  expect((await state.loadBinding('session-busy'))?.helperMvu).toBe(true)
})
