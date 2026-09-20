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
 * - 收纳箱 service 契约：收纳/列举/恢复可逆，历史绑定在收纳后仍可读，永久删除明确拒绝引用；
 * - getAvatar 指纹缓存：同 mtime+size 指纹不重读 card.png，文件变更后指纹失效重读，
 *   无头像缓存 null 结果。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { greetingMessage } from '../src/node/greetingSeed.js'
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
import { CHARACTER_ARCHIVE_FILE, importCard } from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let paths: TavernPaths
let state: TavernState
let service: TavernService
let settingsRaw: TavernConfigRaw
const sessions = new Map<string, Session>()

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
  sessions.clear()
  const ctx = { reflect: { provide: () => {} }, get: () => undefined,
    sessions: { get: (id: string) => sessions.get(id) }, agents: { get: () => undefined },
  } as unknown as Context
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

describe('角色卡局部保存', () => {
  it('只修改描述时保留其它字段，重新读取和导出仍得到完整角色卡', async () => {
    const original = makeCard({ name: '局部编辑', personality: '谨慎', firstMes: '初次见面',
      alternateGreetings: ['另一个开场'], tags: ['标签'], depthPrompt: { prompt: '深度设定', depth: 2, role: 'system' } })
    const { cardId, root: cardRoot } = await importCard(paths.characters, original)
    await expect(service.saveCharacter({ cardId, description: '新描述' })).resolves.toEqual({ cardId, name: original.name, revision: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const stored = JSON.parse(await readFile(join(cardRoot, 'card.json'), 'utf8'))
    const { pngBytes: _png, raw: _raw, ...persistedFields } = original
    expect(stored).toMatchObject({ ...persistedFields, description: '新描述' })
    const fresh = new TavernState(paths, () => resolveConfig({}))
    await fresh.init()
    expect((await fresh.loadCharacter(cardId))?.card).toMatchObject({ name: original.name, description: '新描述',
      personality: original.personality, firstMes: original.firstMes, alternateGreetings: original.alternateGreetings,
      tags: original.tags, depthPrompt: original.depthPrompt })
    expect((await fresh.exportCharacter(cardId)).json).toMatchObject({ data: { name: original.name,
      description: '新描述', first_mes: original.firstMes, alternate_greetings: original.alternateGreetings,
      extensions: { depth_prompt: original.depthPrompt } } })

    // 显式空值仍表示用户清空字段；缺省字段继续保留。
    await service.saveCharacter({ cardId, description: '', alternateGreetings: [], tags: [], depthPrompt: null })
    expect((await state.loadCharacter(cardId))?.card).toMatchObject({ name: original.name, description: '',
      firstMes: original.firstMes, alternateGreetings: [], tags: [], depthPrompt: null })
  })
})

describe('角色收纳箱 service 契约', () => {
  it('收纳后从活动列表隐藏，历史绑定仍可读并能恢复', async () => {
    const { cardId } = await importCard(paths.characters, makeCard({ name: '灯塔守望者' }))
    await state.saveBinding(makeBinding({ cardId }))
    const before = await state.loadBinding('s1')
    const story = await state.storyWorkspace(cardId, before!.storyId)
    await story.fs.writeText('journal.md', '已有剧情笔记')

    const directDeleteError = await service.deleteCharacter({ cardId }).then(
      () => null,
      (error: unknown) => error as { code: string; message: string; details: unknown; isDSHRemoteError: boolean },
    )
    expect(directDeleteError).toMatchObject({
      code: 'tavern/character-not-archived', details: {}, isDSHRemoteError: true,
    })
    expect(directDeleteError?.message).not.toContain(cardId)
    expect(JSON.stringify(directDeleteError?.details)).not.toContain(cardId)

    await expect(service.archiveCharacter({ cardId })).resolves.toEqual({ archived: true })
    expect((await service.listCharacters({})).items).toEqual([])
    expect((await service.listArchivedCharacters({})).items).toEqual([
      expect.objectContaining({ cardId, name: '灯塔守望者', archivedAt: expect.any(String) }),
    ])
    expect(await state.loadBinding('s1')).toEqual(before)
    expect(await (await state.storyWorkspace(cardId, before!.storyId)).fs.readText('journal.md')).toBe('已有剧情笔记')

    await expect(service.restoreCharacter({ cardId })).resolves.toEqual({ restored: true })
    expect((await service.listCharacters({})).items[0]?.cardId).toBe(cardId)
    expect((await service.listArchivedCharacters({})).items).toEqual([])
    expect(await (await state.storyWorkspace(cardId, before!.storyId)).fs.readText('journal.md')).toBe('已有剧情笔记')
    // 模拟收纳箱中打开的旧确认框：恢复后迟到的 delete RPC 必须在引用检查前被拒绝。
    await expect(service.deleteCharacter({ cardId })).rejects.toMatchObject({
      code: 'tavern/character-not-archived', details: {}, isDSHRemoteError: true,
    })
  })

  it('永久删除保留被引用的卡、绑定与内嵌书，不产生抢救副本', async () => {
    const { cardId } = await importCard(paths.characters, makeCard({
      characterBook: { name: '不应抢救', entries: [{ keys: ['k'], content: 'v' }] },
    }))
    await state.saveBinding(makeBinding({ cardId }))
    await service.archiveCharacter({ cardId })

    await expect(service.deleteCharacter({ cardId })).rejects.toMatchObject({
      code: 'tavern/character-in-use',
      details: { sessionCount: 1, storyCount: 1, corruptBindingCount: 0 },
      isDSHRemoteError: true,
    })
    expect((await state.loadCharacter(cardId))?.card.name).toBe('测试角色')
    expect((await loadBinding(paths, 's1'))?.cardId).toBe(cardId)
    expect(await state.listLorebooks()).toEqual([])
  })

  it('语法合法但日期无效的收纳标记不是永久删除凭证', async () => {
    const { cardId, root: cardRoot } = await importCard(paths.characters, makeCard({ name: '损坏收纳凭证' }))
    await writeFile(join(cardRoot, CHARACTER_ARCHIVE_FILE), JSON.stringify({ version: 1, archivedAt: 'invalid-date' }))

    await expect(service.deleteCharacter({ cardId })).rejects.toMatchObject({
      code: 'tavern/character-not-archived', details: {}, isDSHRemoteError: true,
    })
    expect(await state.loadCharacter(cardId)).not.toBeNull()
  })
})

describe('开场白开始状态（真实存储 + 宿主 Session）', () => {
  async function setup(firstMes = '你好') {
    const { cardId } = await importCard(paths.characters, makeCard({ firstMes }))
    const session = Session.create('session-greeting-test' as Session['id'])
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({ sessionId: session.id, cardId }))
    return session
  }

  it('首次开始写入一轮，重复点击成功识别已开始且不重复写入', async () => {
    const session = await setup()
    const request = { sessionId: session.id }
    expect((await service.getSessionBinding(request)).conversationStarted).toBe(false)
    const results = await Promise.all([service.ensureGreeting(request), service.ensureGreeting(request)])
    expect(results).toEqual([{ created: true, conversationStarted: true }, { created: false, conversationStarted: true }])
    expect(session.snapshotEvents().filter((e) => e.type === 'assistant/message')).toHaveLength(1)
    expect(session.snapshotEvents().filter((e) => e.type === 'turn/start')).toHaveLength(1)
    expect((await service.getSessionBinding(request)).conversationStarted).toBe(true)
    expect(await state.loadBinding(session.id)).not.toBeNull()
  })

  it('旧 turn 0 开场白也视为已开始；再次进入补齐 turn 而不复制正文', async () => {
    const session = await setup()
    session.append('assistant/message', {stream: [],  turn: 0, step: 0, message: greetingMessage('旧开场白') }, { surfaceOp: 'append' })
    expect((await service.getSessionBinding({ sessionId: session.id })).conversationStarted).toBe(true)
    expect(await service.ensureGreeting({ sessionId: session.id })).toEqual({ created: false, conversationStarted: true })
    expect(session.snapshotEvents().filter((e) => e.type === 'assistant/message')).toHaveLength(1)
    expect(session.snapshotEvents().some((e) => e.type === 'turn/start')).toBe(true)
  })

  it('空开场白与未绑定会话不能假报开始成功', async () => {
    const session = await setup('')
    expect(await service.ensureGreeting({ sessionId: session.id })).toEqual({ created: false, conversationStarted: false })
    expect(await service.ensureGreeting({ sessionId: 'missing' })).toEqual({ created: false, conversationStarted: false })
    expect(session.snapshotEvents().some((e) => e.type === 'turn/start')).toBe(false)
  })
})

describe('内联 HTML 卡面服务展示（真实剧情存储）', () => {
  it.each(['正文里有一个 ` 符号。','正文里有 ~~~ 波浪线。'])('普通标点不能使展示正则生成的卡面永久回退，重复刷新只读：%s',async prefix=>{
    const {cardId}=await importCard(paths.characters,makeCard())
    const session=Session.create('session-render-markers' as Session['id'])
    sessions.set(session.id,session)
    await state.saveBinding(makeBinding({sessionId:session.id,cardId}))
    const html='<div class="status"><strong>状态栏已加载</strong></div>',text=prefix+'\n\nSTATUS\n\n后续正文'
    await service.saveRegexRules({rules:[{id:'status',name:'状态栏',find:'STATUS',replace:html,enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}]})
    const message=session.append('assistant/message',{stream:[],turn:0,step:0,message:greetingMessage(text)},{surfaceOp:'append'})
    const binding=(await state.loadBinding(session.id))!,workspace=await state.storyWorkspace(cardId,binding.storyId)
    const before=await workspace.fs.readText('state/template.json'),history=session.snapshotEvents()
    for(let index=0;index<2;index++){
      const rendered=await service.renderOutputText({sessionId:session.id,messageId:message.seq,text})
      expect(rendered.htmls).toEqual([html])
      expect(rendered.parts).toEqual([{kind:'markdown',text:prefix},{kind:'html',text:html},{kind:'markdown',text:'后续正文'}])
    }
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
    expect(session.snapshotEvents()).toEqual(history)
  })

  it.each([false,true])('展示规则失败返回诊断且保留成功卡面，普通与缓存模板路径只读：cached=%s',async cached=>{
    const {loadTemplateState,templateTextHash}=await import('../src/state/template.js')
    const {cardId}=await importCard(paths.characters,makeCard())
    const session=Session.create(`session-render-errors-${cached}` as Session['id'])
    sessions.set(session.id,session)
    await state.saveBinding(makeBinding({sessionId:session.id,cardId}))
    const html='<div>有效状态栏</div>',text='正文\nSTATUS'
    await service.saveRegexRules({rules:[
      {id:'broken',name:'损坏的展示规则',find:'[',replace:'不会执行',enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'},
      {id:'status',name:'状态栏',find:'STATUS',replace:html,enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'},
    ]})
    const message=session.append('assistant/message',{stream:[],turn:0,step:0,message:greetingMessage(text)},{surfaceOp:'append'})
    const binding=(await state.loadBinding(session.id))!,workspace=await state.storyWorkspace(cardId,binding.storyId)
    if(cached){
      const snapshot=await loadTemplateState(workspace.fs)
      snapshot.outputs[String(message.seq)]={hash:templateTextHash(text),text,parts:[{kind:'markdown',text:'正文'},{kind:'markdown',text:'STATUS'}]}
      await workspace.fs.writeText('state/template.json',JSON.stringify(snapshot))
    }
    const before=await workspace.fs.readText('state/template.json'),history=session.snapshotEvents()
    for(let index=0;index<2;index++){
      const result=await service.renderOutputText({sessionId:session.id,messageId:message.seq,text})
      expect(result.htmls).toEqual([html])
      expect(result.regexDiagnostics).toMatchObject({total:1,errors:[{ruleId:'broken',ruleName:'损坏的展示规则',message:expect.any(String)}]})
      expect(result.regexDiagnostics!.errors[0]!.message.length).toBeGreaterThan(0)
    }
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
    expect(session.snapshotEvents()).toEqual(history)
  })

  it('普通回复和展示正则生成的裸 div 保留正文顺序，重复刷新不修改消息与模板文件', async () => {
    const {cardId} = await importCard(paths.characters, makeCard())
    const session = Session.create('session-fragment' as Session['id'])
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({sessionId:session.id,cardId}))
    const html = '<div style="display:flex"><span>好感度</span><div style="width:5%">5</div></div>'
    const text = '开头台词\n'+html+'\n后续台词'
    const message = session.append('assistant/message', {stream: [], turn:0,step:0,message:greetingMessage(text)}, {surfaceOp:'append'})
    const request = {sessionId:session.id,text,messageId:message.seq}
    const binding = (await state.loadBinding(session.id))!, workspace = await state.storyWorkspace(cardId,binding.storyId)
    const before = await workspace.fs.readText('state/template.json'), history = session.snapshotEvents()
    const expected = [{kind:'markdown',text:'开头台词'},{kind:'html',text:html},{kind:'markdown',text:'后续台词'}]
    for(let i=0;i<2;i++) {
      const rendered = await service.renderOutputText(request)
      expect(rendered.parts).toEqual(expected);expect(rendered.htmls).toEqual([html])
      expect(rendered.helper?.storyId).toBe(binding.storyId)
    }
    await service.saveRegexRules({rules:[{id:'fragment',name:'状态栏',find:'STATUS',replace:html,enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}]})
    expect((await service.renderOutputText({sessionId:session.id,text:'开头台词\nSTATUS\n后续台词'})).parts).toEqual(expected)
    settingsRaw.interactiveCards=false
    const disabled = await service.renderOutputText(request)
    expect(disabled.htmls).toEqual([]);expect(disabled.parts).toBeUndefined()
    settingsRaw.interactiveCards=true
    await state.saveBinding({...binding,interactiveCards:false})
    const sessionDisabled = await service.renderOutputText({...request,text:html})
    expect(sessionDisabled.htmls).toEqual([]);expect(sessionDisabled.text).toBe('```html\n'+html+'\n```')
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
    expect(session.snapshotEvents()).toEqual(history)
  })
})

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

it('原生 MVU 补出卡片原有状态栏，重复展示不改写历史或剧情文件，关闭后恢复正文',async()=>{
  const html='<div class="mvu-status">Status panel</div>'
  const {cardId}=await importCard(paths.characters,makeCard({regexScripts:[{id:'status',scriptName:'Status',findRegex:'<StatusPlaceHolderImpl/>',replaceString:html,placement:[2],disabled:false,markdownOnly:true,promptOnly:false}]}))
  const session=Session.create('session-mvu-status' as Session['id']);sessions.set(session.id,session)
  await state.saveBinding(makeBinding({sessionId:session.id,cardId,helperMvu:true}))
  const message=session.append('assistant/message',{stream: [], turn:0,step:0,message:greetingMessage('正文')},{surfaceOp:'append'})
  const binding=(await state.loadBinding(session.id))!,workspace=await state.storyWorkspace(cardId,binding.storyId)
  const before=await workspace.fs.readText('state/helper.json'),history=session.snapshotEvents()
  const request={sessionId:session.id,messageId:message.seq,text:'正文'}
  for(let i=0;i<2;i++){const result=await service.renderOutputText(request);expect(result.htmls).toEqual([html]);expect(result.parts).toEqual([{kind:'markdown',text:'正文'},{kind:'html',text:html}]);expect(result.helper?.storyId).toBe(binding.storyId)}
  expect((await service.renderOutputText({...request,text:'正文<StatusPlaceHolderImpl/>'})).htmls).toEqual([html])
  expect(session.snapshotEvents()).toEqual(history);expect(await workspace.fs.readText('state/helper.json')).toBe(before)
  await state.saveBinding({...binding,helperMvu:false});expect((await service.renderOutputText(request)).htmls).toEqual([])
})

/** 纯文本只提供选项/显示事件所需的紧凑身份，不按气泡重复回传整段历史。 */
it('纯文本回复只携带当前剧情读上下文，HTML 仍携带完整快照',async()=>{
  const {cardId}=await importCard(paths.characters,makeCard())
  const session=Session.create('session-plain-helper' as Session['id']);sessions.set(session.id,session)
  await state.saveBinding(makeBinding({sessionId:session.id,cardId}))
  const message=session.append('assistant/message',{stream: [], turn:0,step:0,message:greetingMessage('请选择【开门】')},{surfaceOp:'append'})
  const request={sessionId:session.id,messageId:message.seq,text:'请选择【开门】'}
  const result=await service.renderOutputText(request)
  expect(result.htmls).toEqual([])
  expect(result.helper).toBeUndefined()
  expect(result.helperContext).toEqual({storyId:expect.any(String),historyRevision:expect.stringMatching(/^[a-f0-9]{64}$/),currentMessageId:0,currentMessageRole:'assistant'})
  expect(JSON.stringify(result.helperContext)).not.toContain(request.text)
  expect(result.helperScripts).toBeUndefined()
  const preview=await service.renderOutputText({sessionId:session.id,text:request.text})
  expect(preview.helper).toBeUndefined();expect(preview.helperContext).toBeUndefined()

  const html='<div class="choice-card">请选择</div>'
  const htmlResult=await service.renderOutputText({...request,text:html})
  expect(htmlResult.htmls).toEqual([html])
  expect(htmlResult.helper?.messages[htmlResult.helper.currentMessageId]?.message).toBe(request.text)
  expect(htmlResult.helperContext).toBeUndefined()
  const binding=(await state.loadBinding(session.id))!
  await state.saveBinding({...binding,interactiveCards:false})
  const disabled=await service.renderOutputText(request)
  expect(disabled.helper).toBeUndefined();expect(disabled.helperContext).toBeUndefined()
})


/** 审查修复回归：版本检查与写入在同一锁内，模板回退不能改动任何剧情快照。 */
describe('审查修复回归：服务边界', () => {
  it('身份名称中的嵌套宏不在展示清理后再次展开注入机读块', async () => {
    const { cardId } = await state.createCharacter('{{user}}')
    const persona = await service.savePersona({ persona: { id: 'nested-macro-user', name: '<think>SECRET</think>VISIBLE', description: '', avatar: null } })
    const session = Session.create('session-review-nested-identity' as Session['id'])
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({ sessionId: session.id, cardId, personaId: persona.id }))

    const result = await service.renderOutputText({ sessionId: session.id, text: '{{char}}' })
    expect(result.text).toBe('{{user}}')
    expect(JSON.stringify({ parts: result.parts, html: result.html, htmls: result.htmls, text: result.text })).not.toContain('SECRET')
  })
  it('陈旧的全字段保存被拒绝，重新读取版本后可以保存且不丢另一编辑器的正文', async () => {
    const { cardId } = await state.createCharacter('并发角色')
    const baseline = await service.getCharacterDetail({ cardId })
    expect(baseline.revision).toMatch(/^[a-f0-9]{64}$/)
    const first = await service.saveCharacter({ cardId, description: 'A 的新描述', expectedRevision: baseline.revision })
    const before = await readFile(join(paths.characters, cardId, 'card.json'), 'utf8')
    await expect(service.saveCharacter({ ...baseline, name: 'B 的名字', expectedRevision: baseline.revision })).rejects.toThrow('其他编辑器')
    expect(await readFile(join(paths.characters, cardId, 'card.json'), 'utf8')).toBe(before)
    const fresh = await service.getCharacterDetail({ cardId })
    expect(fresh.revision).toBe(first.revision); expect(fresh.revision).not.toBe(baseline.revision)
    await service.saveCharacter({ cardId, name: 'B 的名字', expectedRevision: fresh.revision })
    expect(await service.getCharacterDetail({ cardId })).toMatchObject({ name: 'B 的名字', description: 'A 的新描述' })
  })
  it('并发提交相同基线恰好一次成功', async () => {
    const { cardId } = await state.createCharacter('并行版本')
    const { revision } = await service.getCharacterDetail({ cardId })
    const results = await Promise.allSettled(['A', 'B'].map(name => service.saveCharacter({ cardId, name, expectedRevision: revision })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  it('只修改世界书不产生正文冲突，正文保存保留世界书', async () => {
    const { cardId } = await state.createCharacter('共享资产')
    const { revision } = await service.getCharacterDetail({ cardId })
    await state.saveCharacterLorebook(cardId, { entries: [{ keys: ['钥匙'], content: '在柜子里' }] })
    await service.saveCharacter({ cardId, name: '新名字', expectedRevision: revision })
    expect((await state.loadCharacter(cardId))?.card.characterBook?.entries[0]?.content).toBe('在柜子里')
  })
  it.each([false, true])('关闭交互卡保留模板缓存中的 HTML 段，原始快照不变：cached=%s', async cached => {
    const { loadTemplateState, templateTextHash } = await import('../src/state/template.js')
    const { cardId } = await state.createCharacter('模板回退')
    const session = Session.create(`session-review-display-${cached}` as Session['id'])
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({ sessionId: session.id, cardId, interactiveCards: false }))
    const binding = (await state.loadBinding(session.id))!, workspace = await state.storyWorkspace(cardId, binding.storyId)
    const html = '<div class="hint-box">钥匙在柜子里</div>', text = `前文\n${html}\n后文`
    const message = session.append('assistant/message', { stream: [], turn: 0, step: 0, message: greetingMessage(text) }, { surfaceOp: 'append' })
    if (cached) {
      const snapshot = await loadTemplateState(workspace.fs)
      snapshot.outputs[String(message.seq)] = { hash: templateTextHash(text), text, parts: [
        { kind: 'markdown', text: '前文' }, { kind: 'html', text: html }, { kind: 'markdown', text: '后文' },
      ] }
      // 手写已提交快照作为测试输入；展示本身必须只读。
      await workspace.fs.writeText('state/template.json', JSON.stringify(snapshot))
    }
    const before = await workspace.fs.readText('state/template.json'), history = session.snapshotEvents()
    for (let i = 0; i < 2; i++) {
      const result = await service.renderOutputText({ sessionId: session.id, messageId: message.seq, text })
      expect(result.htmls).toEqual([]); expect(result.text).toContain('钥匙在柜子里')
      expect(result.text.indexOf('前文')).toBeLessThan(result.text.indexOf('钥匙'))
      expect(result.text.indexOf('钥匙')).toBeLessThan(result.text.indexOf('后文'))
      if (cached) expect(result.parts?.map(part => part.kind)).toEqual(['markdown', 'markdown', 'markdown'])
    }
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
    expect(session.snapshotEvents()).toEqual(history)
  })
  it('无版本旧缓存只有合法 HTML 注释时保留原卡面投影', async () => {
    const { loadTemplateState, templateTextHash } = await import('../src/state/template.js')
    const { cardId } = await state.createCharacter('旧注释卡面')
    const session = Session.create('session-review-legacy-comment' as Session['id'])
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({ sessionId: session.id, cardId, interactiveCards: true }))
    const binding = (await state.loadBinding(session.id))!, workspace = await state.storyWorkspace(cardId, binding.storyId)
    const text = '<div><!--marker--><span>可见卡面</span></div>'
    const message = session.append('assistant/message', { stream: [], turn: 0, step: 0, message: greetingMessage(text) }, { surfaceOp: 'append' })
    const snapshot = await loadTemplateState(workspace.fs)
    snapshot.outputs[String(message.seq)] = { hash: templateTextHash(text), text, parts: [{ kind: 'html', text }] }
    await workspace.fs.writeText('state/template.json', JSON.stringify(snapshot))
    const before = await workspace.fs.readText('state/template.json')

    const result = await service.renderOutputText({ sessionId: session.id, messageId: message.seq, text })
    expect(result.htmls).toEqual([text])
    expect(result.parts).toEqual([{ kind: 'html', text }])
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
  })
  it.each([
    { label: 'think 保留孤儿闭标签', tag: 'think', oldTail: '尾部秘密</think>中间', broken: undefined },
    { label: 'UpdateVariable 连闭标签也已丢失', tag: 'UpdateVariable', oldTail: '尾部秘密中间', broken: undefined },
    { label: '前置未闭合脚本不能遮蔽 think', tag: 'think', oldTail: '尾部秘密</think>中间', broken: '<script>window.x=1' },
    { label: '前置未闭合注释不能遮蔽 think', tag: 'think', oldTail: '尾部秘密</think>中间', broken: '<!-- unclosed' },
  ].flatMap(sample => [true, false].map(interactiveCards => ({ ...sample, interactiveCards }))))(
  '旧缓存真实损坏片段从完整文本只读重建：$label，interactiveCards=$interactiveCards', async ({ tag, oldTail, broken, interactiveCards }) => {
    const { loadTemplateState, templateTextHash } = await import('../src/state/template.js')
    const { cardId } = await state.createCharacter('模板隐私边界')
    const session = Session.create(`session-review-hidden-parts-${tag}-${interactiveCards}` as Session['id'])
    sessions.set(session.id, session)
    await state.saveBinding(makeBinding({ sessionId: session.id, cardId, interactiveCards }))
    const binding = (await state.loadBinding(session.id))!, workspace = await state.storyWorkspace(cardId, binding.storyId)
    const text = `${broken ? `${broken}\n` : ''}前文<${tag}><div>隐藏卡面</div>尾部秘密</${tag}>中间<div>可见卡面</div>后文`
    const message = session.append('assistant/message', { stream: [], turn: 0, step: 0, message: greetingMessage(text) }, { surfaceOp: 'append' })
    const snapshot = await loadTemplateState(workspace.fs)
    // 模拟旧版本真实落盘结果：逐片清理已丢 opener，部分协议连 closer 也已丢失，且没有投影版本。
    snapshot.outputs[String(message.seq)] = { hash: templateTextHash(text), text, parts: [
      ...(broken ? [{ kind: 'html' as const, text: broken }] : []),
      { kind: 'markdown', text: '前文' },
      { kind: 'html', text: '<div>隐藏卡面</div>' },
      { kind: 'markdown', text: oldTail },
      { kind: 'html', text: '<div>可见卡面</div>' },
      { kind: 'markdown', text: '后文' },
    ] }
    await workspace.fs.writeText('state/template.json', JSON.stringify(snapshot))
    const before = await workspace.fs.readText('state/template.json'), history = session.snapshotEvents()

    const result = await service.renderOutputText({ sessionId: session.id, messageId: message.seq, text })
    const brokenComment = broken?.startsWith('<!--') ?? false
    expect(result.htmls).toEqual(!broken && interactiveCards ? ['<div>可见卡面</div>'] : [])
    expect(result.parts?.map(part => part.kind)).toEqual(brokenComment ? [] : broken ? ['markdown'] : interactiveCards
      ? ['markdown', 'html', 'markdown'] : ['markdown', 'markdown', 'markdown'])
    if (!brokenComment) {
      expect(result.text).toContain('前文')
      expect(result.text).toContain('中间')
      expect(JSON.stringify(result)).toContain('<div>可见卡面</div>')
      expect(result.text).toContain('后文')
    }
    const projection = JSON.stringify({ parts: result.parts, html: result.html, htmls: result.htmls, text: result.text })
    expect(projection).not.toContain('隐藏卡面')
    expect(projection).not.toContain('尾部秘密')
    expect(await workspace.fs.readText('state/template.json')).toBe(before)
    expect(session.snapshotEvents()).toEqual(history)
  })
})
