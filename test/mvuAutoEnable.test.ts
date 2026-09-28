/**
 * 自带官方 MVU 框架脚本的角色卡在首次绑定时自动开启原生 MVU：
 * 否则变量永不初始化、卡面脚本一直等待，用户看到的是「MVU 不能用」。
 * 客户端显式关闭时保持关闭；没有 MVU 框架的卡片不受影响。真实文件存储 + 真实服务。
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mvu-auto-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'), presets: join(root, 'library/presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const ctx = { reflect: { provide: () => {} }, sessions: { get: () => undefined }, get: () => undefined } as unknown as Context
  service = new TavernService(ctx, state, { get: () => ({}) } as unknown as TavernSettingsScope)
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
