/** 单会话导出快照：真实剧情文件与模拟宿主持久化共同验证隔离、WAL 和并发失败边界。 */
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as persistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { deriveLegacyLineage, snapshotSessionArchive } from '../src/node/sessionArchiveSnapshot.js'
import { importSessionArchive } from '../src/node/sessionArchiveImport.js'
import { parseSessionArchive, SESSION_ARCHIVE_MAX_FILES } from '../src/node/sessionArchiveFormat.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import * as backupFiles from '../src/node/backupFiles.js'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

let root: string, state: TavernState, ctx: Context, fake: Context, cardId: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-session-export-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('导出角色')).cardId
  for (const sessionId of ['session-one', 'session-two']) await state.saveBinding({ sessionId, cardId, presetId: null, personaId: null,
    lorebookIds: [], characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  ctx = new Context(); new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId('session-one'))
  session.append('agent-preset/selected', { agentPreset: 'tavern' })
  const persistence = { open: async () => ({ header: session.header, inheritedEventCount: 0, read: async () => ({ events: session.snapshotEvents() }), close: async () => {} }) }
  fake = { sessions: { get: () => session, flush: async () => true }, get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
})
afterEach(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

/** 数量压力使用虚拟目录清单和正文，剧情元数据、绑定与宿主历史仍取真实临时文件，避免创建两万文件拖慢双平台 CI。 */
it.each([0, 1])('会话文件恰好到数量上限可导出，超限 %s 个时在读取大量正文前拒绝', async extra => {
  const baseline = await snapshotSessionArchive(fake, state, 'session-one')
  const ws = await state.storyWorkspace(cardId, baseline.binding.storyId)
  const originalPaths = baseline.files.filter(file => file.area === 'story').map(file => file.path)
  const virtualPaths = Array.from({ length: SESSION_ARCHIVE_MAX_FILES - baseline.files.length + extra }, (_, index) => `memory/count-budget-${index}.md`)
  const absolute = new Set(virtualPaths.map(path => join(ws.fs.root, ...path.split('/'))))
  const list = WorkspaceFs.prototype.list, read = backupFiles.boundedBytes
  let reads = 0
  vi.spyOn(WorkspaceFs.prototype, 'list').mockImplementation(function (this: WorkspaceFs, ...args) {
    return this.root === ws.fs.root && !args[0] ? Promise.resolve([...originalPaths, ...virtualPaths]) : list.apply(this, args)
  })
  vi.spyOn(backupFiles, 'boundedBytes').mockImplementation(async (path, limit) => {
    if (absolute.has(path)) { reads++; return Buffer.from('synthetic memory') }
    return read(path, limit)
  })
  if (extra) {
    await expect(snapshotSessionArchive(fake, state, 'session-one')).rejects.toThrow(/文件数量.*全量备份/)
    expect(reads).toBe(0)
  } else {
    const archive = await snapshotSessionArchive(fake, state, 'session-one')
    expect(archive.files).toHaveLength(SESSION_ARCHIVE_MAX_FILES)
    expect(reads).toBe(virtualPaths.length)
    expect(archive.files.some(file => file.path === virtualPaths.at(-1))).toBe(true)
  }
})

it('附件数量超限时明确提示全量备份，不启动附件正文读取', async () => {
  const attachmentId = `sha256:${createHash('sha256').update('').digest('hex')}` as const
  const content = Array.from({ length: SESSION_ARCHIVE_MAX_FILES + 1 }, (_, index) => ({
    type: 'file' as const, attachment: { attachmentId, bytes: 0, name: `file-${index}.txt` },
  }))
  ctx.sessions.get(SessionId('session-one'))!.append('user/message', createUserMessage({ source: { kind: 'user' }, content }), { surfaceOp: 'append' })
  const readFileStream = vi.fn(async function* () { throw new Error('不应读取超限附件正文') })
  const sourceCtx = { sessions: fake.sessions, get: (name: string) => name === 'attachments' ? { readFileStream } : fake.get(name) } as unknown as Context
  await expect(snapshotSessionArchive(sourceCtx, state, 'session-one')).rejects.toThrow(/附件数量.*全量备份/)
  expect(readFileStream).not.toHaveBeenCalled()
})

/** 模拟剧情写入在持有剧情锁时再获取绑定锁；超时后释放剧情锁，避免错误锁序挂死整个测试。 */
async function storyWriter(story: string) {
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
  const result = withWorkspaceLock(story, async () => {
    entered.resolve()
    await proceed.promise
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        withWorkspaceLock(state.paths.sessions, async () => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  })
  await entered.promise
  return { proceed, result }
}

it('导出与剧情写入并发时不会倒置剧情和绑定锁', async () => {
  const binding = (await state.loadBinding('session-one'))!, ws = await state.storyWorkspace(cardId, binding.storyId)
  const writer = await storyWriter(ws.fs.root)
  const preflight = Promise.withResolvers<void>(), load = state.loadBinding.bind(state)
  vi.spyOn(state, 'loadBinding').mockImplementation(async (...args) => {
    const result = await load(...args); preflight.resolve(); return result
  })
  const pending = snapshotSessionArchive(fake, state, 'session-one')
  await preflight.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  writer.proceed.resolve()
  const unblocked = await writer.result
  const archive = await pending
  expect(unblocked).toBe(true)
  expect(archive.binding.storyId).toBe(binding.storyId)
})

it('导入冲突剧情时也不会与剧情写入互锁', async () => {
  const archive = await snapshotSessionArchive(fake, state, 'session-one')
  const ws = await state.storyWorkspace(cardId, archive.binding.storyId)
  const writer = await storyWriter(ws.fs.root)
  const persistence = { stat: vi.fn(async () => undefined) }
  const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
    : name === 'workspaceRegistry' ? { list: () => [{ id: 'workspace', path: root, attachSession: async () => {} }] } : undefined } as unknown as Context
  const pending = importSessionArchive(destCtx, state, archive, 'workspace').then(() => null, error => error as Error)
  await new Promise<void>(resolve => setImmediate(resolve))
  writer.proceed.resolve()
  const unblocked = await writer.result
  const error = await pending
  expect(unblocked).toBe(true)
  expect(error?.message).toContain('目标会话绑定已存在')
})

it('导出只包含当前剧情、共享卡片和真实 WAL，不包含同卡另一剧情', async () => {
  const first = (await state.loadBinding('session-one'))!, second = (await state.loadBinding('session-two'))!
  const one = await state.storyWorkspace(cardId, first.storyId), two = await state.storyWorkspace(cardId, second.storyId)
  await one.wal.beginFloor('session-one#t1')
  await one.fs.withFloor('session-one#t1').writeText('memory/fact.md', '当前剧情事实')
  await one.wal.commitFloor('session-one#t1')
  await two.fs.writeText('memory/secret.md', '另一剧情秘密')
  const archive = await snapshotSessionArchive(fake, state, 'session-one')
  expect(archive.binding.storyId).toBe(first.storyId)
  expect(archive.files.some(file => file.area === 'story' && file.path === 'memory/fact.md')).toBe(true)
  expect(archive.files.some(file => file.area === 'story' && file.path.startsWith('state/wal/'))).toBe(true)
  expect(JSON.stringify(archive)).not.toContain('另一剧情秘密')
  expect(archive.files.some(file => file.path.includes('secret.md'))).toBe(false)
})

it('未结束轮次禁止导出', async () => {
  state.openFloors.set('session-one', { cardId, storyId: (await state.loadBinding('session-one'))!.storyId, floor: 'open' })
  await expect(snapshotSessionArchive(fake, state, 'session-one')).rejects.toThrow('生成进行中')
})

it('导出前拒绝损坏的 WAL，不能生成事后无法恢复的会话文件', async () => {
  const binding = (await state.loadBinding('session-one'))!, ws = await state.storyWorkspace(cardId, binding.storyId)
  await ws.wal.beginFloor('session-one#t1')
  await ws.fs.withFloor('session-one#t1').writeText('memory/fact.md', '保留的事实')
  await ws.wal.commitFloor('session-one#t1')
  const directory = (await readdir(join(ws.fs.root, 'state/wal'), { withFileTypes: true })).find(entry => entry.isDirectory())!
  await appendFile(join(ws.fs.root, 'state/wal', directory.name, 'records.jsonl'), '{bad json}\n')
  await expect(snapshotSessionArchive(fake, state, 'session-one')).rejects.toThrow(/WAL.*损坏/)
})

it('导出前拒绝游离 assistant 消息，不能生成宿主无法重载的历史', async () => {
  const session = ctx.sessions.get(SessionId('session-one'))!
  const message = createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '旧消息' }] })
  session.append('assistant/message', { turn: 0, step: 0, message, stream: [] }, { surfaceOp: 'append' })
  await expect(snapshotSessionArchive(fake, state, session.id)).rejects.toThrow(/无效|损坏/)
})

it('导入时先拒绝轮次关系损坏的历史，不能发布剧情或宿主会话', async () => {
  const archive = await snapshotSessionArchive(fake, state, 'session-one')
  const session = ctx.sessions.get(SessionId('session-one'))!
  const message = createAssistantMessage({ source: { provider: 'factory', model: 'factory' }, content: [{ type: 'text', text: '游离消息' }] })
  session.append('assistant/message', { turn: 0, step: 0, message, stream: [] }, { surfaceOp: 'append' })
  const { manifestSha256: _oldDigest, ...body } = structuredClone(archive)
  body.session.events = [...session.snapshotEvents()]
  const damaged = { ...body, manifestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
  const targetRoot = join(root, 'invalid-history-target')
  const target = new TavernState({ root: targetRoot, characters: join(targetRoot, 'characters'), lorebooks: join(targetRoot, 'library/lorebooks'),
    presets: join(targetRoot, 'library/presets'), personas: join(targetRoot, 'personas'), regexDir: join(targetRoot, 'regex'), sessions: join(targetRoot, 'sessions') }, () => resolveConfig({}))
  await target.init()
  const persistenceContext = new Context()
  try {
    await persistenceJsonl.apply(persistenceContext, { root: join(targetRoot, 'host-sessions'), compression: 'none' })
    const persistence = persistenceContext.get('sessionPersistence')!
    const attachSession = vi.fn(async () => {})
    const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
      : name === 'workspaceRegistry' ? { list: () => [{ id: 'target', path: root, attachSession }] } : undefined } as unknown as Context
    await expect(importSessionArchive(destCtx, target, damaged, 'target')).rejects.toThrow(/无效|损坏/)
    expect(await target.loadBinding(session.id)).toBeNull()
    expect(await readdir(target.paths.characters)).not.toContain(cardId)
    expect(await persistence.stat(session.id)).toBeFalsy()
    expect(attachSession).not.toHaveBeenCalled()
  } finally { await persistenceContext.fiber.dispose() }
})

it('导入后宿主历史、独立记忆和楼层回滚都能往返，重复导入不会覆盖', async () => {
  const source = (await state.loadBinding('session-one'))!, ws = await state.storyWorkspace(cardId, source.storyId)
  await ws.wal.beginFloor('session-one#t1')
  await ws.fs.withFloor('session-one#t1').writeText('memory/fact.md', '可回滚的事实')
  await ws.wal.commitFloor('session-one#t1')
  const sourceAttachments = new LocalAttachmentStore(ctx, { dshHome: join(root, 'source-attachments') })
  const image = await sourceAttachments.saveImage({ mediaType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNYffY9AASOAmiAObbZAAAAAElFTkSuQmCC', 'base64') })
  const file = await sourceAttachments.saveFile({ name: 'note.txt', data: Buffer.from('测试附件') })
  ctx.sessions.get(SessionId('session-one'))!.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }] }), { surfaceOp: 'append' })
  const sourceCtx = { sessions: fake.sessions, get: (name: string) => name === 'attachments' ? sourceAttachments : fake.get(name) } as unknown as Context
  const archive = await snapshotSessionArchive(sourceCtx, state, 'session-one')
  expect(archive.attachments).toHaveLength(2)
  const omitted = structuredClone(archive); omitted.attachments.pop()
  expect(() => parseSessionArchive(omitted)).toThrow('无效或已损坏')
  const damaged = structuredClone(archive); damaged.attachments[0]!.data = damaged.attachments[0]!.data.replace(/^./, 'A')
  expect(() => parseSessionArchive(damaged)).toThrow('无效或已损坏')
  const targetRoot = join(root, 'destination')
  const target = new TavernState({ root: targetRoot, characters: join(targetRoot, 'characters'), lorebooks: join(targetRoot, 'library/lorebooks'),
    presets: join(targetRoot, 'library/presets'), personas: join(targetRoot, 'personas'), regexDir: join(targetRoot, 'regex'), sessions: join(targetRoot, 'sessions') }, () => resolveConfig({}))
  await target.init()
  // 曾经查询过同 ID 的缺失卡时，导入后必须刷新缺失缓存，不能让新绑定仍被当作坏卡。
  expect(await target.loadCharacter(cardId)).toBeNull()
  const persistenceContext = new Context()
  await persistenceJsonl.apply(persistenceContext, { root: join(targetRoot, 'host-sessions'), compression: 'none' })
  const persistence = persistenceContext.get('sessionPersistence')!
  const createStored = persistence.create.bind(persistence)
  vi.spyOn(persistence, 'create').mockImplementationOnce(async (header, options) => {
    const handle = await createStored(header, options), append = handle.append.bind(handle)
    vi.spyOn(handle, 'append').mockImplementationOnce(async events => {
      await append(events.slice(0, 1))
      throw new Error('模拟日志只写入前缀')
    })
    return handle
  })
  const targetAttachments = new LocalAttachmentStore(persistenceContext, { dshHome: join(targetRoot, 'host-attachments') })
  let failAttach = true
  const attachment = { id: 'destination', path: root, attachSession: async (_id: string) => {
    if (failAttach) { failAttach = false; throw new Error('模拟工作区登记故障') }
  } }
  const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
    : name === 'workspaceRegistry' ? { list: () => [attachment] } : name === 'attachments' ? targetAttachments : undefined } as unknown as Context
  await expect(importSessionArchive(destCtx, target, archive, 'destination')).rejects.toThrow('使用同一文件和工作区重试')
  await expect(target.loadBinding('session-one')).rejects.toThrow('导入尚未完成')
  const partial = await persistence.open(SessionId('session-one'), 'read')
  expect((await partial.read()).events).toHaveLength(1)
  await partial.close()
  await expect(importSessionArchive(destCtx, target, archive, 'destination')).rejects.toThrow('使用同一文件和工作区重试')
  await expect(target.loadBinding('session-one')).rejects.toThrow('导入尚未完成')
  expect(await importSessionArchive(destCtx, target, archive, 'destination')).toEqual({ sessionId: 'session-one' })
  const stored = await persistence.open(SessionId('session-one'), 'read')
  expect((await stored.read()).events).toEqual(archive.session.events)
  await stored.close()
  expect((await targetAttachments.readImage(image)).data).toEqual((await sourceAttachments.readImage(image)).data)
  const fileChunks: Uint8Array[] = []
  for await (const chunk of targetAttachments.readFileStream(file)) fileChunks.push(chunk)
  expect(Buffer.concat(fileChunks).toString()).toBe('测试附件')
  const imported = (await target.loadBinding('session-one'))!, importedWs = await target.storyWorkspace(cardId, imported.storyId)
  expect(await importedWs.fs.readText('memory/fact.md')).toBe('可回滚的事实')
  await importedWs.wal.rollbackFloor('session-one#t1', importedWs.fs.root)
  expect(await importedWs.fs.readText('memory/fact.md')).toBeNull()
  expect(await ws.fs.readText('memory/fact.md')).toBe('可回滚的事实')
  await expect(importSessionArchive(destCtx, target, archive, 'destination')).rejects.toThrow('已存在')
  await persistenceContext.fiber.dispose()
})

it('目标图片策略会改变附件身份时不发布剧情，调整策略后可重新导入', async () => {
  const sourceAttachments = new LocalAttachmentStore(ctx, { dshHome: join(root, 'source-policy'), normalizedImageMaxDimension: 8 })
  const image = await sourceAttachments.saveImage({ mediaType: 'image/png', name: 'factory.png', data: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64') })
  ctx.sessions.get(SessionId('session-one'))!.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'image', attachment: image }] }), { surfaceOp: 'append' })
  const sourceCtx = { sessions: fake.sessions, get: (name: string) => name === 'attachments' ? sourceAttachments : fake.get(name) } as unknown as Context
  const archive = await snapshotSessionArchive(sourceCtx, state, 'session-one')
  const targetRoot = join(root, 'policy-target')
  const target = new TavernState({ root: targetRoot, characters: join(targetRoot, 'characters'), lorebooks: join(targetRoot, 'library/lorebooks'),
    presets: join(targetRoot, 'library/presets'), personas: join(targetRoot, 'personas'), regexDir: join(targetRoot, 'regex'), sessions: join(targetRoot, 'sessions') }, () => resolveConfig({}))
  await target.init()
  const persistenceContext = new Context(), strictContext = new Context(), compatibleContext = new Context()
  try {
    await persistenceJsonl.apply(persistenceContext, { root: join(targetRoot, 'host-sessions'), compression: 'none' })
    const persistence = persistenceContext.get('sessionPersistence')!
    const attachmentHome = join(targetRoot, 'host-attachments')
    let attachments = new LocalAttachmentStore(strictContext, { dshHome: attachmentHome, normalizedImageMaxDimension: 1 })
    const workspace = { id: 'destination', path: root, attachSession: async () => {} }
    const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
      : name === 'workspaceRegistry' ? { list: () => [workspace] } : name === 'attachments' ? attachments : undefined } as unknown as Context

    await expect(importSessionArchive(destCtx, target, archive, 'destination')).rejects.toThrow('附件恢复后的身份与原会话不一致')
    expect(await target.loadBinding('session-one')).toBeNull()
    expect(await readdir(target.paths.characters)).not.toContain(cardId)
    expect((await readdir(join(targetRoot, 'session-imports'))).filter(name => name.endsWith('.json'))).toEqual([])
    expect(await persistence.stat(SessionId('session-one'))).toBeFalsy()

    attachments = new LocalAttachmentStore(compatibleContext, { dshHome: attachmentHome, normalizedImageMaxDimension: 8 })
    await expect(importSessionArchive(destCtx, target, archive, 'destination')).resolves.toEqual({ sessionId: 'session-one' })
    expect((await target.loadBinding('session-one'))?.storyId).toBe(archive.binding.storyId)
    expect((await attachments.readImage(image)).data).toEqual((await sourceAttachments.readImage(image)).data)
  } finally {
    await strictContext.fiber.dispose(); await compatibleContext.fiber.dispose(); await persistenceContext.fiber.dispose()
  }
})

it('目标已有不同共享卡时在导入前拒绝，保留已有剧情和会话', async () => {
  const archive = await snapshotSessionArchive(fake, state, 'session-one')
  const targetRoot = join(root, 'conflict-target')
  const target = new TavernState({ root: targetRoot, characters: join(targetRoot, 'characters'), lorebooks: join(targetRoot, 'library/lorebooks'),
    presets: join(targetRoot, 'library/presets'), personas: join(targetRoot, 'personas'), regexDir: join(targetRoot, 'regex'), sessions: join(targetRoot, 'sessions') }, () => resolveConfig({}))
  await target.init()
  const card = archive.files.find(file => file.area === 'card' && file.path === 'card.json')!
  const changed = JSON.parse(Buffer.from(card.data, 'base64').toString()) as Record<string, unknown>
  changed.name = '另一张卡'
  await mkdir(join(targetRoot, 'characters', cardId), { recursive: true })
  await writeFile(join(targetRoot, 'characters', cardId, 'card.json'), JSON.stringify(changed))
  const persistence = { stat: vi.fn(async () => undefined) }
  const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
    : name === 'workspaceRegistry' ? { list: () => [{ id: 'workspace', path: root, attachSession: async () => {} }] } : undefined } as unknown as Context
  await expect(importSessionArchive(destCtx, target, archive, 'workspace')).rejects.toThrow('角色资产不同')
  expect(await target.loadBinding('session-one')).toBeNull()
  expect((await state.loadBinding('session-one'))?.storyId).toBe(archive.binding.storyId)
})

it('旧分支的祖先楼层边界取自实际继承历史；缺失祖先不能猜测', async () => {
  const base = ctx.sessions.get(SessionId('session-one'))!, original = base.header
  const turn = (n: number) => ({ type: 'turn/start', data: { turn: n } })
  const root = { header: { ...original, id: SessionId('child'), isSeeded: true, parentSession: SessionId('parent') },
    inheritedEventCount: 2, events: [turn(1), turn(3)] } as unknown as Parameters<typeof deriveLegacyLineage>[1]
  const parents = new Map<string, typeof root>([
    ['parent', { ...root, header: { ...root.header, id: SessionId('parent'), parentSession: SessionId('grandparent') }, inheritedEventCount: 1 }],
    ['grandparent', { ...root, header: { ...original, id: SessionId('grandparent'), isSeeded: false }, inheritedEventCount: 0 }],
  ])
  const persistence = { open: async (id: string) => {
    const value = parents.get(id); if (!value) throw new Error('missing ancestor')
    return { ...value, read: async () => ({ events: value.events }), close: async () => {} }
  } } as unknown as SessionPersistence
  expect(await deriveLegacyLineage(persistence, root)).toEqual([{ sessionId: 'grandparent', throughTurn: 1 }, { sessionId: 'parent', throughTurn: 3 }])
  parents.delete('grandparent')
  await expect(deriveLegacyLineage(persistence, root)).rejects.toThrow('missing ancestor')
})

it('导出读取旧祖先期间历史变化时拒绝发布陈旧快照', async () => {
  const parent = ctx.sessions.get(SessionId('session-one'))!
  parent.append('turn/start', { turn: 1 }); parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const child = ctx.sessions.fork(parent, undefined, SessionId('session-race'))
  await state.saveBinding({ sessionId: child.id, cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const persistence = { open: async (id: string) => {
    if (id === parent.id) { entered.resolve(); await release.promise }
    const session = ctx.sessions.get(SessionId(id))!
    return { header: session.header, inheritedEventCount: session.inheritedEventCount, read: async () => ({ events: session.snapshotEvents() }), close: async () => {} }
  } }
  const sourceCtx = { sessions: { get: (id: string) => ctx.sessions.get(SessionId(id)), flush: async () => true },
    get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
  const result = snapshotSessionArchive(sourceCtx, state, child.id)
  await entered.promise
  child.append('agent-preset/selected', { agentPreset: 'tavern' })
  release.resolve()
  await expect(result).rejects.toThrow('导出期间会话历史已变化')
})

it('真实 fork 会话的继承边界和祖先 WAL 在新宿主中保留', async () => {
  const parent = ctx.sessions.get(SessionId('session-one'))!
  parent.append('turn/start', { turn: 1 }); parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const child = ctx.sessions.fork(parent, undefined, SessionId('session-child'))
  await state.saveBinding({ sessionId: child.id, cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const childBinding = (await state.loadBinding(child.id))!, childWs = await state.storyWorkspace(cardId, childBinding.storyId)
  await childWs.wal.beginFloor('session-one#t1')
  await childWs.fs.withFloor('session-one#t1').writeText('memory/fact.md', '继承的记忆')
  await childWs.wal.commitFloor('session-one#t1')
  const sourcePersistence = { open: async (id: string) => {
    const session = ctx.sessions.get(SessionId(id)); if (!session) throw new Error('missing ancestor')
    return { header: session.header, inheritedEventCount: session.inheritedEventCount, read: async () => ({ events: session.snapshotEvents() }), close: async () => {} }
  } }
  const sourceCtx = { sessions: { get: (id: string) => ctx.sessions.get(SessionId(id)), flush: async () => true },
    get: (name: string) => name === 'sessionPersistence' ? sourcePersistence : undefined } as unknown as Context
  const archive = await snapshotSessionArchive(sourceCtx, state, child.id)
  expect(archive.binding.walLineage).toEqual([{ sessionId: parent.id, throughTurn: 1 }])
  expect(archive.session.inheritedEventCount).toBe(child.inheritedEventCount)
  const targetRoot = join(root, 'fork-target')
  const target = new TavernState({ root: targetRoot, characters: join(targetRoot, 'characters'), lorebooks: join(targetRoot, 'library/lorebooks'),
    presets: join(targetRoot, 'library/presets'), personas: join(targetRoot, 'personas'), regexDir: join(targetRoot, 'regex'), sessions: join(targetRoot, 'sessions') }, () => resolveConfig({}))
  await target.init()
  const targetCtx = new Context()
  await persistenceJsonl.apply(targetCtx, { root: join(targetRoot, 'host-sessions'), compression: 'none' })
  const persistence = targetCtx.get('sessionPersistence')!
  const destCtx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? persistence
    : name === 'workspaceRegistry' ? { list: () => [{ id: 'target', path: root, attachSession: async () => {} }] } : undefined } as unknown as Context
  await importSessionArchive(destCtx, target, archive, 'target')
  const imported = await persistence.open(child.id, 'read')
  expect(imported.inheritedEventCount).toBe(child.inheritedEventCount)
  expect((await imported.read()).events).toEqual(archive.session.events)
  await imported.close()
  expect((await target.loadBinding(child.id))!.walLineage).toEqual(archive.binding.walLineage)
  await targetCtx.fiber.dispose()
})
