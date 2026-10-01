/** 原生分支尚未完成的接管计划：私有根状态持久化来源身份，冷恢复不能改用父会话的新角色。 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { readStory } from '../state/story.js'
import { parseSessionBinding, type SessionBinding } from './bindings.js'
import type { TavernPaths } from './paths.js'

export interface HostForkAdoptionPlan {
  version: 1
  status: 'unverified' | 'checkpoint' | 'ready' | 'skipped'
  sessionId: string
  parentId: Session['id']
  inheritedCount: number
  seedHash: string
  sourceCheckpoint?: string | null
  sourceUncertain?: boolean
  binding?: SessionBinding
  rollbackFromTurn?: number
}

const DIRECTORY = 'state/host-fork-adoptions'
const MAX_PLAN_BYTES = 1024 * 1024
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const hostForkAdoptionFile = (sessionId: string): string => `${DIRECTORY}/${digest(sessionId)}.json`

export function hostForkSeedHash(prefix: readonly SessionEvent[]): string {
  return digest(JSON.stringify(prefix))
}

/** 服务已在绑定锁内验证合法 current 后保存明确解除意图；未知接管失败不能调用此入口绕过屏障。 */
export async function writeHostForkSkipped(paths: TavernPaths, child: Session): Promise<void> {
  const parentId = child.header.parentSession
  if (!parentId || child.header.isSeeded !== true || (child.header.delegationDepth ?? 0) > 0) return
  await writeHostForkAdoption(paths, { version: 1, status: 'skipped', sessionId: child.id, parentId,
    inheritedCount: child.inheritedEventCount, seedHash: hostForkSeedHash(child.snapshotEvents().slice(0, child.inheritedEventCount)) })
}

function invalidPlan(): never {
  throw new Error('原生分支接管记录损坏或与原始继承历史不符，请保留数据并重新创建分支')
}

/** 记录按原始会话 ID 哈希定位；字段、来源绑定与种子指纹全部验证，不按宽松 null 处理损坏。 */
export async function readHostForkAdoption(paths: TavernPaths, child: Session, prefix: readonly SessionEvent[]): Promise<HostForkAdoptionPlan | null> {
  const fs = new WorkspaceFs(paths.root, null), file = hostForkAdoptionFile(child.id)
  const info = await fs.stat(file)
  if (info && info.size > MAX_PLAN_BYTES) invalidPlan()
  const text = await fs.readText(file)
  if (text === null) return null
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) invalidPlan()
  let input: unknown
  try { input = JSON.parse(text) } catch { invalidPlan() }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidPlan()
  const raw = input as Record<string, unknown>
  if (raw.version !== 1 || raw.sessionId !== child.id || raw.parentId !== child.header.parentSession
    || raw.inheritedCount !== child.inheritedEventCount || raw.seedHash !== hostForkSeedHash(prefix)) invalidPlan()
  if (Object.keys(raw).some(key => !['version', 'status', 'sessionId', 'parentId', 'inheritedCount', 'seedHash', 'sourceCheckpoint', 'sourceUncertain', 'binding', 'rollbackFromTurn'].includes(key))) invalidPlan()
  if (typeof raw.status !== 'string' || !['unverified', 'checkpoint', 'ready', 'skipped'].includes(raw.status)) invalidPlan()
  if (raw.sourceCheckpoint !== undefined && raw.sourceCheckpoint !== null
    && (typeof raw.sourceCheckpoint !== 'string' || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(raw.sourceCheckpoint))) invalidPlan()
  if (raw.sourceUncertain !== undefined && typeof raw.sourceUncertain !== 'boolean') invalidPlan()
  const result: HostForkAdoptionPlan = { version: 1, status: raw.status as HostForkAdoptionPlan['status'], sessionId: child.id, parentId: child.header.parentSession!,
    inheritedCount: child.inheritedEventCount, seedHash: raw.seedHash as string }
  if (raw.status === 'skipped') {
    if (['sourceCheckpoint', 'sourceUncertain', 'binding', 'rollbackFromTurn'].some(key => raw[key] !== undefined)) invalidPlan()
    return result
  }
  if (raw.sourceCheckpoint !== undefined) result.sourceCheckpoint = raw.sourceCheckpoint as string | null
  if (raw.sourceUncertain !== undefined) result.sourceUncertain = raw.sourceUncertain as boolean
  if (raw.binding !== undefined) {
    let binding: SessionBinding
    try { binding = parseSessionBinding(raw.binding) } catch { invalidPlan() }
    const through = prefix.reduce<number | null>((last, event) => event.type === 'turn/start'
      && Number.isSafeInteger(event.data.turn) && event.data.turn >= 0 ? Math.max(last ?? event.data.turn, event.data.turn) : last, null)
    const closed = through !== null && prefix.some(event => event.type === 'turn/end' && event.data.turn === through)
    const boundaries = through === null ? [1] : closed ? [through + 1] : [through, through + 1]
    if (raw.status !== 'ready' || binding.sessionId !== result.parentId || !binding.storyId || raw.sourceCheckpoint === undefined || typeof raw.rollbackFromTurn !== 'number'
      || !Number.isSafeInteger(raw.rollbackFromTurn) || !boundaries.includes(raw.rollbackFromTurn) || raw.sourceUncertain === true) invalidPlan()
    await assertHostForkSource(paths, binding)
    result.binding = binding
    result.rollbackFromTurn = raw.rollbackFromTurn
  } else if (raw.rollbackFromTurn !== undefined || raw.status === 'ready'
    || (raw.status === 'checkpoint' && (raw.sourceCheckpoint === undefined || raw.sourceUncertain !== false))
    || (raw.status === 'unverified' && raw.sourceUncertain !== true)) invalidPlan()
  return result
}

/** 来源卡与剧情目录都在 characters 锚点内预检，不能先经 cardRoot 链接准备副本再到发布时拒绝。 */
export async function assertHostForkSource(paths: TavernPaths, binding: SessionBinding): Promise<void> {
  if (!binding.storyId) invalidPlan()
  await new WorkspaceFs(paths.characters, null).assertSafePath(`${binding.cardId}/stories/${binding.storyId}/story.json`)
  if ((await readStory(join(paths.characters, binding.cardId), binding.storyId)).sessionId !== binding.sessionId) invalidPlan()
}

/** 首次记录未验证身份；只有已保存检查点/来源的后续原子记录才允许冷恢复继续准备。 */
export async function writeHostForkAdoption(paths: TavernPaths, plan: HostForkAdoptionPlan): Promise<void> {
  const { version, sessionId, parentId, inheritedCount, seedHash, sourceCheckpoint, binding, rollbackFromTurn } = plan
  const sourceUncertain = plan.sourceUncertain ?? (plan.sourceCheckpoint === undefined && !plan.binding)
  const status = plan.status === 'skipped' ? 'skipped' : binding ? 'ready' : sourceUncertain ? 'unverified' : 'checkpoint'
  const persisted = status === 'skipped' ? { version, status, sessionId, parentId, inheritedCount, seedHash }
    : { version, status, sessionId, parentId, inheritedCount, seedHash, sourceCheckpoint, binding, rollbackFromTurn, sourceUncertain }
  const text = JSON.stringify(persisted, null, 2) + '\n'
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw new Error('原生分支接管记录超限，请保留来源并重新创建分支')
  await new WorkspaceFs(paths.root, null).writeText(hostForkAdoptionFile(plan.sessionId), text)
}

export async function deleteHostForkAdoption(paths: TavernPaths, sessionId: string): Promise<void> {
  await new WorkspaceFs(paths.root, null).delete(hostForkAdoptionFile(sessionId))
}
