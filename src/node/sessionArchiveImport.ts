/** 会话迁移导入：预检冲突并准备独立剧情，持久化可重试标记后发布，绝不覆盖已有会话或共享资产。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { Wal } from '../state/wal.js'
import { storyRoot } from '../state/story.js'
import { loadCharacter } from '../state/workspace.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { atomicWrite, sweepOrphanTemps } from '../state/atomicWrite.js'
import { renameWithRetry } from '../state/rename.js'
import { assertBindingFileIdentity, loadBinding, saveBinding } from './bindings.js'
import { sessionFile } from './paths.js'
import { assertDirectory, boundedBytes, boundedJson } from './backupFiles.js'
import { sessionArchiveMarkerPath } from './sessionArchiveMarker.js'
import { assertArchiveWalComplete } from './sessionArchiveWal.js'
import { parseSessionArchive, SESSION_ARCHIVE_MAX_BYTES, type SessionArchiveFile } from './sessionArchiveFormat.js'
import { TavernState } from './state.js'

interface ImportWorkspace { id: string; path: string; attachSession(id: Session['id']): Promise<void> }
interface ImportWorkspaceRegistry { list(): ImportWorkspace[] }
interface ImportMarker { version: 1; sessionId: string; cardId: string; storyId: string; workspaceId: string; workspacePath: string; digest: string }

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function bytes(file: SessionArchiveFile): Buffer { return Buffer.from(file.data, 'base64') }
async function sameFile(root: string, file: SessionArchiveFile): Promise<boolean> {
  try { return (await boundedBytes(join(root, ...file.path.split('/')), SESSION_ARCHIVE_MAX_BYTES)).equals(bytes(file)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function writeFiles(root: string, files: readonly SessionArchiveFile[]): Promise<void> {
  const fs = new WorkspaceFs(root, null)
  for (const file of files) {
    const slash = file.path.lastIndexOf('/')
    if (slash !== -1) await fs.ensureDir(file.path.slice(0, slash))
    await fs.writeBytes(file.path, bytes(file))
  }
}
async function cardFiles(root: string): Promise<string[]> {
  const fs = new WorkspaceFs(root, null)
  return ['card.json', ...(await fs.exists('card.png') ? ['card.png'] : []),
    ...(await fs.list('assets', { rejectLinks: true })).map(path => `assets/${path}`).filter(path => path.toLowerCase() !== 'assets/chat-lorebook.json')].sort()
}
async function sameFiles(root: string, files: readonly SessionArchiveFile[], actualPaths: readonly string[]): Promise<boolean> {
  const expected = files.map(file => file.path).sort()
  if (JSON.stringify(expected) !== JSON.stringify([...actualPaths].sort())) return false
  for (const file of files) if (!(await sameFile(root, file))) return false
  return true
}

/** 清理仅限本次生成的点号草稿；正式剧情和角色始终不在失败清理范围。 */
async function cleanupStage(stage: string, parent: string): Promise<void> {
  if (!resolve(stage).startsWith(resolve(parent) + sep) || dirname(resolve(stage)) !== resolve(parent)) throw new Error('迁移草稿路径越界')
  const info = await lstat(stage).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('迁移草稿身份无效')
    await rm(stage, { recursive: true, force: true })
  }
}

/** 在专用草稿核对全部共享文件均由绑定引用；不能通过归档注入与该会话无关的库资产。 */
async function validateSharedAssets(parent: string, state: TavernState, archive: ReturnType<typeof parseSessionArchive>): Promise<void> {
  const stage = join(parent, `.validating-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  try {
    const cardRoot = join(stage, 'characters', archive.binding.cardId)
    await writeFiles(cardRoot, archive.files.filter(file => file.area === 'card'))
    if (!(await loadCharacter(join(stage, 'characters'), archive.binding.cardId))) throw new Error('迁移文件中的角色卡无效')
    const globals = archive.files.filter(file => file.area === 'global')
    await writeFiles(stage, globals)
    const paths = { root: stage, characters: join(stage, 'characters'), lorebooks: join(stage, 'library/lorebooks'),
      presets: join(stage, 'library/presets'), personas: join(stage, 'personas'), regexDir: join(stage, 'regex'), sessions: join(stage, 'sessions') }
    const probe = new TavernState(paths, () => state.config)
    const expected = await probe.sessionArchiveAssetPaths(archive.binding)
    if (JSON.stringify(expected) !== JSON.stringify(globals.map(file => file.path).sort())) throw new Error('迁移文件包含无关或缺失的共享资产')
    if (archive.binding.presetId && !(await probe.loadPreset(archive.binding.presetId))) throw new Error('迁移文件中的预设无效')
    if (archive.binding.personaId && !(await probe.loadPersona(archive.binding.personaId))) throw new Error('迁移文件中的人设无效')
    if (expected.includes('regex/rules.json')) await probe.getRegexRulesSnapshot()
    if (expected.includes('library/helper-scripts.json')) await probe.getHelperScriptLibrary({ type: 'global' })
  } finally { await cleanupStage(stage, parent) }
}

/** 导入失败后保留绑定到归档摘要的回执；相同文件可重试，不能借回执覆盖其它会话。 */
export async function importSessionArchive(ctx: Context, state: TavernState, input: unknown, workspaceId: string): Promise<{ sessionId: string }> {
  const archive = parseSessionArchive(input), binding = archive.binding, storyId = binding.storyId!
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry') as ImportWorkspaceRegistry | undefined
  const workspace = registry?.list().find(item => item.id === workspaceId)
  if (!persistence || !workspace) throw new Error('目标工作区或会话持久化服务不可用')
  const targetHeader = { ...archive.session.header, cwd: workspace.path, delegationDepth: archive.session.header.delegationDepth ?? 0 }
  // 宿主自身在任何文件发布前复核 surface、seed 标记与注册的消息投影；光靠 JSON schema 不足以证明历史可恢复。
  Session.fromRestore(targetHeader.id, archive.session.events, targetHeader, SessionLogOffset(archive.session.inheritedEventCount),
    'shared-frozen', ctx.sessions.messageProjections)
  const digest = createHash('sha256').update(JSON.stringify(archive)).digest('hex')
  const cardRoot = join(state.paths.characters, binding.cardId), story = storyRoot(cardRoot, storyId)
  const markers = join(state.paths.root, 'session-imports')
  const markerPath = sessionArchiveMarkerPath(state.paths, binding.sessionId)
  const marker: ImportMarker = { version: 1, sessionId: binding.sessionId, cardId: binding.cardId, storyId,
    workspaceId: workspace.id, workspacePath: workspace.path, digest }
  const card = archive.files.filter(file => file.area === 'card'), storyFiles = archive.files.filter(file => file.area === 'story')
  const globals = archive.files.filter(file => file.area === 'global')
  // 与已有剧情写路径保持相同锁序，即使导入最终因剧情冲突而拒绝也不能造成互锁。
  return withWorkspaceLock(story, () => withWorkspaceLock(state.paths.sessions, () => withWorkspaceLock(cardRoot,
    () => withWorkspaceLock(state.paths.root, async () => {
      await mkdir(markers, { recursive: true })
      await assertDirectory(markers)
      await sweepOrphanTemps(markers, { draftPrefixes: ['.validating-'], recursive: false })
      await validateSharedAssets(markers, state, archive)
      const previous = await present(markerPath) ? await boundedJson(markerPath, 64 * 1024) : null
      if (previous !== null && JSON.stringify(previous) !== JSON.stringify(marker)) throw new Error('已有不同的会话迁移任务，不能覆盖')
      const retry = previous !== null
      await assertBindingFileIdentity(state.paths, binding.sessionId)
      const existingBinding = await loadBinding(state.paths, binding.sessionId, true)
      if (await present(sessionFile(state.paths, binding.sessionId)) && (!retry || JSON.stringify(existingBinding) !== JSON.stringify(binding))) throw new Error('目标会话绑定已存在，不能覆盖')
      const existingSession = await persistence.stat(binding.sessionId as Session['id'])
      if ((ctx.sessions.get(binding.sessionId as Session['id']) || existingSession) && !retry) throw new Error('目标会话已存在，不能覆盖')
      if (ctx.sessions.get(binding.sessionId as Session['id'])) throw new Error('目标会话正在运行，不能导入')
      const cardExists = await present(cardRoot)
      if (cardExists && !(await sameFiles(cardRoot, card, await cardFiles(cardRoot)))) throw new Error('同 ID 的角色资产不同，不能覆盖')
      if (await present(story)) {
        if (!retry || !(await sameFiles(story, storyFiles, await new WorkspaceFs(story, null).list('', { rejectLinks: true })))) throw new Error('目标剧情已存在，不能覆盖')
      }
      const rootFs = new WorkspaceFs(state.paths.root, null), missingGlobals: SessionArchiveFile[] = []
      for (const file of globals) {
        if (await rootFs.exists(file.path)) {
          if (!(await sameFile(state.paths.root, file))) throw new Error('同名共享资产内容不同，不能覆盖')
        } else missingGlobals.push(file)
      }
      if (missingGlobals.some(file => file.path === 'regex/rules.json' || file.path === 'library/helper-scripts.json')) {
        const others = (await readdir(state.paths.sessions)).filter(name => name.endsWith('.json'))
        if (others.length && !(retry && others.length === 1 && existingBinding)) throw new Error('导入全局正则或脚本会影响已有会话，请先处理共享设置冲突')
      }
      const store = ctx.get('attachments')
      if (archive.attachments.length && !store) throw new Error('宿主附件服务不可用')
      for (const attachment of archive.attachments) if (attachment.kind === 'image') {
        await store!.validateImage({ data: Buffer.from(attachment.data, 'base64'), mediaType: attachment.ref.mediaType, name: attachment.ref.name })
      }
      const stageParent = cardExists ? join(cardRoot, 'stories') : state.paths.characters
      await mkdir(stageParent, { recursive: true })
      await assertDirectory(stageParent)
      const stage = join(stageParent, `.preparing-${randomUUID()}`)
      try {
        await mkdir(stage, { mode: 0o700 })
        const stagedStory = cardExists ? stage : storyRoot(stage, storyId)
        if (!cardExists) await writeFiles(stage, card)
        await writeFiles(stagedStory, storyFiles)
        const wal = new Wal(join(stagedStory, 'state', 'wal'))
        await assertArchiveWalComplete(wal)
        // 附件服务保存的是不可变内容寻址对象；先核对实际保存身份，再发布剧情或恢复标记。
        // 目标策略可能把校验通过的图片缩小或重编码，若现在才发现即可拒绝，避免留下无法完成的导入。
        for (const attachment of archive.attachments) {
          const data = Buffer.from(attachment.data, 'base64')
          const saved = attachment.kind === 'image'
            ? await store!.saveImage({ data, mediaType: attachment.ref.mediaType, name: attachment.ref.name })
            : await store!.saveFile({ data, name: attachment.ref.name })
          if (saved.attachmentId !== attachment.ref.attachmentId || saved.bytes !== attachment.ref.bytes
            || (attachment.kind === 'file' && saved.name !== attachment.ref.name)) {
            throw new Error('附件恢复后的身份与原会话不一致，请检查目标宿主的附件策略后重试')
          }
          if (attachment.kind === 'image') await store!.readImage(attachment.ref)
        }
        if (!retry) await atomicWrite(markerPath, JSON.stringify(marker) + '\n')
        // 若共享文件写到一半失败，已落盘的条目同样不能继续命中旧的缺失缓存。
        try { await writeFiles(state.paths.root, missingGlobals) }
        finally { state.invalidateSessionArchiveAssets(missingGlobals.map(file => file.path)) }
        if (!(await present(story))) await renameWithRetry(stage, cardExists ? story : cardRoot)
        state.invalidateSessionArchiveCard(binding.cardId)
        if (!existingBinding) await saveBinding(state.paths, binding)
        const handle = existingSession ? await persistence.open(binding.sessionId as Session['id'], 'write')
          : await persistence.create(targetHeader, targetHeader.isSeeded
            ? { inheritedEventCount: SessionLogOffset(archive.session.inheritedEventCount) } : undefined)
        try {
          const prior = (await handle.read()).events
          if (!isDeepStrictEqual(handle.header, targetHeader) || handle.inheritedEventCount !== archive.session.inheritedEventCount
            || prior.length > archive.session.events.length
            || !isDeepStrictEqual(prior, archive.session.events.slice(0, prior.length))) throw new Error('已有会话与恢复任务不一致')
          if (prior.length < archive.session.events.length) await handle.append(archive.session.events.slice(prior.length))
          await handle.flush()
        } finally { await handle.close() }
        await workspace.attachSession(binding.sessionId as Session['id'])
        await rm(markerPath)
        return { sessionId: binding.sessionId }
      } catch (error) {
        if (await present(markerPath)) throw new Error('会话导入尚未完成，请使用同一文件和工作区重试', { cause: error })
        throw error
      } finally { await cleanupStage(stage, stageParent) }
    }))))
}
