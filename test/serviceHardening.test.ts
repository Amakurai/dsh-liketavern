/**
 * TavernService 加固测试（真实临时目录；ctx/settingsScope 用最小桩——
 * cordis Service 基类构造只触 ctx.reflect.provide，被测方法不碰其余 ctx 面）。
 * 覆盖（对应评审问题 3/4/5/7/8 的 service 侧）：
 * - 面板写路径（saveMemory/deleteMemory/compressMemories/addWorldDelta/revokeWorldDelta）
 *   走 plainWorkspace：turn 进行中（共享句柄 floor 非 null）也不记 WAL，回退楼层不撤销面板编辑；
 * - compressMemories 与 memoryMaintenance 同序：先落合并条目再归档——合并写失败时原批次
 *   原样保留（不丢事实），成功时合并为一条且标签/键归并；
 * - save 与 import 系列回显存储层返回的实际净化 id（savePreset/importPreset/saveLorebook/
 *   importLorebook/savePersona），savePersona 写默认页也用同一 id；
 * - savePreset 宽松传输严格校验：非对象 / entries 缺失 / 条目缺或重复 identifier 一律
 *   invalid-preset 抛错且不写盘；带 regexScripts 的合法预设照常通过；
 * - setSessionBinding 经 parseSessionBinding 整体验证：非对象/缺字段抛 invalid-binding，
 *  合法绑定落盘，且客户端自报的 walLineage 不被信任（无同卡既有绑定时丢弃）；
 * - getAvatar 指纹缓存：同 mtime+size 指纹不重读 card.png，文件变更后指纹失效重读，
 *   无头像缓存 null 结果。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { defaultPreset } from '../src/core/assemble.js'
import type { CharacterCard, PromptPreset } from '../src/core/types.js'
import { loadBinding, type SessionBinding } from '../src/node/bindings.js'
import { TavernConfigSchema, resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { MemoryStore } from '../src/state/memory.js'
import { exportStPreset } from '../src/state/presetStore.js'
import { importCard } from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let paths: TavernPaths
let state: TavernState
let service: TavernService
let settingsRaw: TavernConfigRaw

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'service-hardening-test-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
  settingsRaw = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
  const settingsScope = {
    get: () => settingsRaw,
    update: async (patch: object) => {
      settingsRaw = { ...settingsRaw, ...(patch as Partial<TavernConfigRaw>) }
    },
  } as unknown as SettingsScope<TavernConfigRaw>
  const ctx = { reflect: { provide: () => {} } } as unknown as Context
  service = new TavernService(ctx, state, settingsScope)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '测试角色',
    description: '描述',
    personality: '',
    scenario: '',
    firstMes: '你好',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    characterVersion: '1',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: {},
    depthPrompt: null,
    ...overrides,
  }
}

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sessionId: 's1',
    cardId: 'c1',
    cardName: '测试角色',
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('面板写路径不记 WAL（plainWorkspace）', () => {
  it('turn 进行中（共享句柄 floor 非 null）面板写不记楼层快照，回退不撤销', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    // 楼层开始前的既有数据（不涉 WAL）
    const m1 = await service.saveMemory({ cardId, body: '旧记忆一' })
    const m2 = await service.saveMemory({ cardId, body: '旧记忆二' })

    // 模拟 turn/start～turn/end 之间：共享句柄 floor 非 null（host 侧 beginFloor）
    const shared = await state.workspace(cardId)
    await shared.fs.beginFloor('s1#t1')

    // 面板操作：增/改/删记忆、加/撤世界状态
    const m3 = await service.saveMemory({ cardId, body: '面板新增记忆', tags: ['面板'] })
    expect(m3.id).toBeTruthy()
    await service.saveMemory({ cardId, id: m1.id, body: '面板改写记忆' })
    expect(await service.deleteMemory({ cardId, id: m2.id })).toEqual({ deleted: true })
    const d = await service.addWorldDelta({ cardId, type: 'add', content: '面板新增世界状态' })
    expect(await service.revokeWorldDelta({ cardId, id: d.id })).toEqual({ revoked: true })

    // 写入照常落盘
    expect((await service.getMemories({ cardId })).items.map((e) => e.body).sort()).toEqual(['面板改写记忆', '面板新增记忆'])
    expect((await service.getWorldDeltas({ cardId })).items[0]?.revoked).toBe(true)

    // 但 state/wal/ 下没有任何快照（一旦误记 WAL，record 会 append 出 records.jsonl）
    const walDir = join(root, 'characters', cardId, 'state', 'wal')
    await expect(readFile(join(walDir, 's1_t1', 'records.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // 提交并回滚该楼层：无记录可回放，面板编辑原样保留
    await shared.fs.commitFloor()
    expect(await shared.wal.rollbackFloor('s1#t1', join(root, 'characters', cardId))).toEqual([])
    expect((await service.getMemories({ cardId })).items.map((e) => e.body).sort()).toEqual(['面板改写记忆', '面板新增记忆'])
  })
})

describe('compressMemories 先写合并条目再归档', () => {
  it('最旧批次无损归并为一条并归档，标签/键归并', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    await service.saveMemory({ cardId, body: '记忆一', tags: ['a'], keys: ['k1'] })
    await service.saveMemory({ cardId, body: '记忆二', tags: ['b'], keys: ['k2'] })

    expect(await service.compressMemories({ cardId })).toEqual({ merged: 2 })

    const items = (await service.getMemories({ cardId })).items
    expect(items).toHaveLength(1)
    expect(items[0]!.body).toContain('记忆一')
    expect(items[0]!.body).toContain('记忆二')
    expect(items[0]!.tags).toEqual(expect.arrayContaining(['merged', 'a', 'b']))
    expect(items[0]!.keys).toEqual(expect.arrayContaining(['k1', 'k2']))
  })

  it('合并条目写失败时原批次不归档、原样保留可重试（不丢事实）', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    await service.saveMemory({ cardId, body: '旧记忆一' })
    await service.saveMemory({ cardId, body: '旧记忆二' })

    // service 每次经 plainWorkspace 取新 MemoryStore，钉原型才能拦到本次合并写
    const spy = vi.spyOn(MemoryStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'))
    await expect(service.compressMemories({ cardId })).rejects.toThrow('disk full')
    spy.mockRestore()

    // 批次仍在活跃库、没有被归档（旧顺序「先归档后写」下这两条会整批消失）
    expect((await service.getMemories({ cardId })).items.map((e) => e.body).sort()).toEqual(['旧记忆一', '旧记忆二'])
  })
})

describe('回显实际净化 id', () => {
  it('savePreset/importPreset 返回落盘后的实际 id', async () => {
    const preset = { ...defaultPreset(), identifier: 'my preset!①', name: '测试预设' }
    await expect(service.savePreset({ preset })).resolves.toEqual({ id: 'my_preset__' })

    const json = exportStPreset({ ...defaultPreset(), identifier: 'imp preset!' })
    const r = await service.importPreset({ name: '导入名', json })
    expect(r.id).toBe('imp_preset_')

    expect((await state.listPresets()).sort()).toEqual(['imp_preset_', 'my_preset__'])
  })

  it('saveLorebook/importLorebook 返回落盘后的实际 id', async () => {
    await expect(service.saveLorebook({ name: 'my book!', json: { entries: [] } })).resolves.toEqual({ name: 'my_book_' })
    await expect(
      service.importLorebook({ name: 'other book', json: { entries: [{ keys: ['剑'], content: '断剑' }] } }),
    ).resolves.toEqual({ name: 'other_book', entryCount: 1 })
    expect((await state.listLorebooks()).sort()).toEqual(['my_book_', 'other_book'])
  })

  it('savePersona 返回实际净化 id，写默认页用同一 id；已有默认人设不覆盖', async () => {
    const r = await service.savePersona({ persona: { id: 'p 1!', name: '测试人设', description: '', avatar: null } })
    expect(r).toEqual({ id: 'p_1_' })
    // 默认页与磁盘 JSON 的 id 都是净化后的实际 id
    expect(settingsRaw.defaults.personaId).toBe('p_1_')
    const personas = await state.listPersonas()
    expect(personas).toHaveLength(1)
    expect(personas[0]!.id).toBe('p_1_')

    await service.savePersona({ persona: { id: 'p2', name: '第二', description: '', avatar: null } })
    expect(settingsRaw.defaults.personaId).toBe('p_1_')
  })
})

describe('宽松传输、严格校验', () => {
  it('savePreset 整体校验：结构非法抛 invalid-preset 且不写盘', async () => {
    await expect(service.savePreset({ preset: null as unknown as PromptPreset })).rejects.toMatchObject({ code: 'invalid-preset' })
    await expect(service.savePreset({ preset: 'nope' as unknown as PromptPreset })).rejects.toMatchObject({ code: 'invalid-preset' })
    // entries 缺失（往返解析过不了）
    await expect(service.savePreset({ preset: { identifier: 'x' } as unknown as PromptPreset })).rejects.toMatchObject({ code: 'invalid-preset' })
    // 条目 identifier 重复（往返会丢条目 → 拒绝而非静默丢数据）
    const dup = { ...defaultPreset(), identifier: 'dup' }
    dup.entries = [dup.entries[0]!, dup.entries[0]!]
    await expect(service.savePreset({ preset: dup })).rejects.toMatchObject({ code: 'invalid-preset' })
    // 条目 identifier 为空
    const blank = { ...defaultPreset(), identifier: 'blank' }
    blank.entries = [{ ...blank.entries[0]!, identifier: '' }]
    await expect(service.savePreset({ preset: blank })).rejects.toMatchObject({ code: 'invalid-preset' })

    expect(await state.listPresets()).toEqual([])
  })

  it('savePreset 接受带 regexScripts 的合法预设', async () => {
    const preset = {
      ...defaultPreset(),
      identifier: 'with-regex',
      regexScripts: [{ scriptName: 'r1', findRegex: '/a/g', replaceString: 'b' }],
    }
    await expect(service.savePreset({ preset })).resolves.toEqual({ id: 'with-regex' })
    const stored = await state.loadPreset('with-regex')
    expect(stored?.regexScripts).toHaveLength(1)
  })

  it('setSessionBinding 经 parseSessionBinding 整体验证，非法抛 invalid-binding 不落盘', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    await expect(service.setSessionBinding({ binding: 'nope' })).rejects.toMatchObject({ code: 'invalid-binding' })
    await expect(service.setSessionBinding({ binding: { sessionId: 's1' } })).rejects.toMatchObject({ code: 'invalid-binding' })
    await expect(service.setSessionBinding({ binding: null })).rejects.toMatchObject({ code: 'invalid-binding' })
    expect(await loadBinding(paths, 's1')).toBeNull()

    // 合法绑定落盘；客户端自报的 walLineage 不被信任（无同卡既有绑定时丢弃）
    const binding = makeBinding({ cardId, walLineage: [{ sessionId: 'ancestor', throughTurn: 3 }] })
    await expect(service.setSessionBinding({ binding })).resolves.toEqual({ saved: true })
    const saved = await loadBinding(paths, 's1')
    expect(saved?.cardId).toBe(cardId)
    expect(saved?.walLineage).toBeUndefined()
  })
})

describe('getAvatar 指纹缓存', () => {
  it('同指纹不重读盘，文件变更后指纹失效重读；无头像缓存 null', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    // 无头像：dataUrl=null（按 missing 指纹进缓存）
    expect(await service.getAvatar({ cardId })).toEqual({ dataUrl: null })

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const ws = await state.workspace(cardId)
    await ws.fs.writeBytes('card.png', png)
    const first = await service.getAvatar({ cardId })
    expect(first.dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)

    // 同指纹：拦死 readBytes 仍命中缓存（不再全文读盘 + Base64 编码）
    const spy = vi.spyOn(WorkspaceFs.prototype, 'readBytes')
    await expect(service.getAvatar({ cardId })).resolves.toEqual(first)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()

    // 内容变更（尺寸不同）→ 指纹失效重读
    const png2 = Buffer.from([9, 8, 7, 6, 5])
    await ws.fs.writeBytes('card.png', png2)
    expect((await service.getAvatar({ cardId })).dataUrl).toBe(`data:image/png;base64,${png2.toString('base64')}`)
  })
})
