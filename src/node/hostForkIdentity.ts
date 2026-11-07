/** 普通宿主分支的插件侧来源凭据；绑定子会话及继承历史，不改写宿主保留给子代理的会话头。 */
import { createHash } from 'node:crypto'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import type { TavernPaths } from './paths.js'

const DIRECTORY = 'state/host-fork-identities'
const MAX_BYTES = 4096
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const identityFile = (sessionId: string): string => `${DIRECTORY}/${digest(sessionId)}.json`
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256

interface ForkIdentity {
  version: 1
  sessionId: string
  parentId: string | null
  inheritedCount: number
  seedHash: string
  skipped?: true
}

/** 读取来源时只需要会话头与不可变的继承前缀，持久化快照也可提供相同视图。 */
export type HostForkIdentitySource = Pick<Session, 'id' | 'header' | 'snapshotEvents'> & { inheritedEventCount: number }

function identity(sessionId: string, parentId: string, prefix: readonly unknown[]): ForkIdentity {
  if (!validId(sessionId) || !validId(parentId) || sessionId === parentId) throw new Error('宿主分支来源身份无效')
  return { version: 1, sessionId, parentId, inheritedCount: prefix.length, seedHash: digest(JSON.stringify(prefix)) }
}

async function read(fs: WorkspaceFs, sessionId: string): Promise<ForkIdentity | null> {
  const path = identityFile(sessionId)
  const info = await fs.stat(path)
  if (info && info.size > MAX_BYTES) throw new Error('宿主分支来源记录损坏')
  const text = await fs.readText(path)
  if (text === null) return null
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('宿主分支来源记录损坏')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('宿主分支来源记录损坏') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('宿主分支来源记录损坏')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['version', 'sessionId', 'parentId', 'inheritedCount', 'seedHash', 'skipped'].includes(key))
    || raw.version !== 1 || raw.sessionId !== sessionId || (raw.skipped !== undefined && raw.skipped !== true)
    || (raw.parentId === null ? raw.skipped !== true : !validId(raw.parentId) || raw.parentId === sessionId)
    || !Number.isSafeInteger(raw.inheritedCount) || (raw.inheritedCount as number) < 0
    || typeof raw.seedHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.seedHash)) throw new Error('宿主分支来源记录损坏')
  return raw as unknown as ForkIdentity
}

/** 写入须在宿主持久化子会话之前完成；同一 ID 重试只能复用完全相同的来源和前缀。 */
export async function writeHostForkIdentity(paths: TavernPaths, sessionId: string, parentId: string, prefix: readonly unknown[]): Promise<void> {
  const next = identity(sessionId, parentId, prefix)
  await withWorkspaceLock(paths.root, async () => {
    const fs = new WorkspaceFs(paths.root, null), previous = await read(fs, sessionId)
    if (previous && (previous.skipped || previous.parentId !== next.parentId || previous.inheritedCount !== next.inheritedCount
      || previous.seedHash !== next.seedHash)) throw new Error('宿主分支来源记录冲突')
    if (!previous) await fs.writeText(identityFile(sessionId), JSON.stringify(next) + '\n')
  })
}

/** 冷恢复只接受会话 ID、继承长度和前缀摘要均一致的持久凭据。 */
export async function readHostForkIdentity(paths: TavernPaths, child: HostForkIdentitySource): Promise<{ parentId: Session['id'] | null; skipped: boolean } | null> {
  const saved = await read(new WorkspaceFs(paths.root, null), child.id)
  if (!saved) return null
  const prefix = child.snapshotEvents().slice(0, child.inheritedEventCount)
  if (saved.inheritedCount !== child.inheritedEventCount || saved.seedHash !== digest(JSON.stringify(prefix))
    || (child.header.parentSession !== undefined && child.header.parentSession !== saved.parentId)) {
    throw new Error('宿主分支来源记录与继承历史不符')
  }
  return { parentId: saved.parentId === null ? null : SessionId(saved.parentId), skipped: saved.skipped === true }
}

/** 合法绑定经用户明确解除时，即使迁入的旧分支没有来源凭据，也持久保存不再接管的决定。 */
export async function skipHostForkIdentity(paths: TavernPaths, child: Session): Promise<Session['id'] | null> {
  const events = child.snapshotEvents(), count = child.inheritedEventCount
  if (!validId(child.id) || !Number.isSafeInteger(count) || count < 0 || count > events.length) throw new Error('宿主分支继承历史无效')
  const seedHash = digest(JSON.stringify(events.slice(0, count)))
  return withWorkspaceLock(paths.root, async () => {
    const fs = new WorkspaceFs(paths.root, null), previous = await read(fs, child.id)
    if (previous && (previous.inheritedCount !== count || previous.seedHash !== seedHash
      || (child.header.parentSession !== undefined && child.header.parentSession !== previous.parentId))) {
      throw new Error('宿主分支来源记录与继承历史不符')
    }
    const parentId = child.header.parentSession ?? previous?.parentId ?? null
    if (parentId !== null && (!validId(parentId) || parentId === child.id)) throw new Error('宿主分支来源身份无效')
    const skipped: ForkIdentity = { version: 1, sessionId: child.id, parentId, inheritedCount: count, seedHash, skipped: true }
    await fs.writeText(identityFile(child.id), JSON.stringify(skipped) + '\n')
    return parentId === null ? null : SessionId(parentId)
  })
}

/** 仅在宿主确认会话已删除后清理；普通卸载或重启须保留凭据。 */
export async function deleteHostForkIdentity(paths: TavernPaths, sessionId: string): Promise<void> {
  await new WorkspaceFs(paths.root, null).delete(identityFile(sessionId))
}
