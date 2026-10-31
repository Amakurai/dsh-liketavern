/** 会话迁移快照：锁住绑定、共享资产和剧情，读取宿主持久历史及其附件，并复核历史未变化。 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { readStory, storyRoot } from '../state/story.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { boundedBytes } from './backupFiles.js'
import { sessionAttachmentReferences } from './sessionArchiveAttachments.js'
import { archiveFile, sealSessionArchive, SESSION_ARCHIVE_MAX_BYTES, SESSION_ARCHIVE_MAX_JSON_BYTES, type SessionArchive, type SessionArchiveAttachment, type SessionArchiveFile } from './sessionArchiveFormat.js'
import type { TavernState } from './state.js'
import type { WalLineageEntry } from './bindings.js'
import { assertArchiveWalComplete } from './sessionArchiveWal.js'

function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  const open = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/start') open.add(event.data.turn)
    else if (event.type === 'turn/end') open.delete(event.data.turn)
  }
  return open.size > 0
}

/** 旧分支未保存 WAL 世系时，从真实祖先的持久化继承边界重建；缺失祖先不能猜测。 */
export async function deriveLegacyLineage(persistence: SessionPersistence, root: SessionArchive['session']): Promise<WalLineageEntry[]> {
  const reverse: WalLineageEntry[] = [], seen = new Set<string>([root.header.id])
  let child = root, maxTurn = Number.POSITIVE_INFINITY
  while (child.header.parentSession) {
    const parentId = child.header.parentSession
    if (seen.has(parentId)) throw new Error('会话祖先关系循环，不能导出')
    seen.add(parentId)
    let inheritedTurn: number | undefined
    for (const event of child.events.slice(0, child.inheritedEventCount)) if (event.type === 'turn/start'
      && Number.isSafeInteger(event.data.turn) && event.data.turn >= 0) inheritedTurn = Math.max(inheritedTurn ?? 0, event.data.turn)
    if (inheritedTurn === undefined) break
    maxTurn = Math.min(maxTurn, inheritedTurn)
    reverse.push({ sessionId: parentId, throughTurn: maxTurn })
    const handle = await persistence.open(parentId, 'read')
    try { child = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: [...(await handle.read()).events] } }
    finally { await handle.close() }
  }
  return reverse.reverse()
}

/** 导出期间拒绝正在生成或未完成的轮次；返回的是校验过的、无兄弟剧情的完整快照。 */
export async function snapshotSessionArchive(ctx: Context, state: TavernState, sessionId: string): Promise<SessionArchive> {
  if (!sessionId || sessionId.length > 256) throw new Error('会话 ID 无效')
  await state.waitForSessionTasks(sessionId)
  const initial = await state.loadBinding(sessionId, true)
  if (!initial?.storyId) throw new Error('会话尚未绑定剧情')
  const cardRoot = join(state.paths.characters, initial.cardId)
  const story = storyRoot(cardRoot, initial.storyId)
  // 与剧情编辑、工具写入一致，先锁剧情再锁绑定；反序会与持剧情锁的写入互相等待。
  return withWorkspaceLock(story, () => withWorkspaceLock(state.paths.sessions, () => withWorkspaceLock(cardRoot,
    () => withWorkspaceLock(state.paths.root, async () => {
      const binding = await state.loadBindingUnwaited(sessionId, true)
      if (!binding?.storyId || binding.cardId !== initial.cardId || binding.storyId !== initial.storyId) throw new Error('导出期间剧情绑定已变化')
      if ((await readStory(cardRoot, binding.storyId)).sessionId !== sessionId) throw new Error('剧情不属于此会话')
      const workspace = await state.storyWorkspace(binding.cardId, binding.storyId)
      await assertArchiveWalComplete(workspace.wal)
      if (state.openFloors.has(sessionId)) throw new Error('生成进行中，不能导出会话')
      const persistence = ctx.get('sessionPersistence')
      if (!persistence) throw new Error('宿主未提供会话持久化服务')
      const live = ctx.sessions.get(sessionId as Session['id'])
      if (live) await ctx.sessions.flush(live)
      const handle = await persistence.open(sessionId as Session['id'], 'read')
      let session: SessionArchive['session']
      try {
        const read = await handle.read()
        session = { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: [...read.events] }
      } finally { await handle.close() }
      const history = JSON.stringify(session.events)
      if (session.header.id !== sessionId || hasOpenTurn(session.events) || state.openFloors.has(sessionId)
        || (live && JSON.stringify(live.snapshotEvents()) !== history)) throw new Error('会话正在生成或历史尚未稳定，请稍后重试')
      let remaining = SESSION_ARCHIVE_MAX_BYTES - Buffer.byteLength(history)
      const files: SessionArchiveFile[] = []
      const add = async (area: SessionArchiveFile['area'], root: string, path: string) => {
        if (remaining < 0) throw new Error('会话迁移文件超过大小上限')
        const bytes = await boundedBytes(join(root, ...path.split('/')), remaining)
        remaining -= bytes.length
        files.push(archiveFile(area, path, bytes))
      }
      const cardFs = new WorkspaceFs(cardRoot, null)
      for (const path of ['card.json', ...(await cardFs.exists('card.png') ? ['card.png'] : []),
        ...(await cardFs.list('assets', { rejectLinks: true })).map(path => `assets/${path}`).filter(path => path.toLowerCase() !== 'assets/chat-lorebook.json')]) {
        await add('card', cardRoot, path)
      }
      const storyFs = new WorkspaceFs(story, null)
      for (const path of await storyFs.list('', { rejectLinks: true })) await add('story', story, path)
      for (const path of await state.sessionArchiveAssetPaths(binding)) await add('global', state.paths.root, path)
      const refs = sessionAttachmentReferences(session.events), attachments: SessionArchiveAttachment[] = []
      const store = ctx.get('attachments')
      if ((refs.images.size || refs.files.size) && !store) throw new Error('宿主附件服务不可用')
      for (const ref of refs.images.values()) {
        if (ref.bytes > remaining) throw new Error('会话迁移文件超过大小上限')
        const image = await store!.readImage(ref)
        remaining -= image.data.byteLength
        attachments.push({ kind: 'image', ref, data: Buffer.from(image.data).toString('base64') })
      }
      for (const ref of refs.files.values()) {
        if (ref.bytes > remaining) throw new Error('会话迁移文件超过大小上限')
        const chunks: Uint8Array[] = []; let bytes = 0
        for await (const chunk of store!.readFileStream(ref)) {
          bytes += chunk.byteLength
          if (bytes > remaining || bytes > ref.bytes) throw new Error('附件超过迁移大小上限')
          chunks.push(chunk)
        }
        remaining -= bytes
        attachments.push({ kind: 'file', ref, data: Buffer.concat(chunks, bytes).toString('base64') })
      }
      const preservedBinding = binding.walLineage === undefined && session.header.parentSession
        ? { ...binding, walLineage: await deriveLegacyLineage(persistence, session) } : binding
      const archive = sealSessionArchive({ format: 'dsh-tavern-session', version: 1, binding: preservedBinding, session, files, attachments })
      if (Buffer.byteLength(JSON.stringify(archive)) > SESSION_ARCHIVE_MAX_JSON_BYTES) throw new Error('会话迁移文件超过 JSON 大小上限')
      if (!live) {
        const fresh = await persistence.open(sessionId as Session['id'], 'read')
        try { if (JSON.stringify((await fresh.read()).events) !== history) throw new Error('导出期间会话历史已变化') }
        finally { await fresh.close() }
      }
      // 祖先读取也可能等待磁盘；所有异步工作结束后再复核，避免最后阶段悄悄导出陈旧历史。
      const current = ctx.sessions.get(sessionId as Session['id'])
      if (state.openFloors.has(sessionId) || current !== live || (live && JSON.stringify(live.snapshotEvents()) !== history)) throw new Error('导出期间会话历史已变化')
      return archive
    }))))
}
