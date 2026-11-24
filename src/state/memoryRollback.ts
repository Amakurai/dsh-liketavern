/** 回滚前展开受影响的归并谱系：摘要可重建，来源事实随原楼层撤销，旧格式同样适用。 */
import { isMemoryId, memorySourceIds, parseMemory } from './memory.js'
import { caseIdentity } from './pathIdentity.js'
import { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'

/** Windows 的同名文件不区分大小写；只规范图节点身份，旧来源正文与 WAL 镜像保持原样。 */
const memoryIdentity = caseIdentity

export interface MemoryExpansionPlan {
  readonly fs: WorkspaceFs
  readonly restore: Map<string, string>
  readonly sourcesToUnarchive: Set<string>
  readonly archivedTexts: Map<string, string>
  readonly activePresent: Set<string>
  readonly postorder: string[]
}

/** 批量回滚预检用的内存只读镜像：整批只扫描磁盘一次，并支持在内存中推进较新楼层的展开与回滚过渡。 */
export interface MemoryRollbackOverlay {
  readonly fs: WorkspaceFs
  readonly active: Map<string, { id: string; text: string }>
  readonly archived: Map<string, { id: string; text: string }>
}

/** 一次性只读加载 memory/ 与 memory/archive/ 的全部有效 Markdown 条目。 */
export async function loadMemoryRollbackOverlay(root: string): Promise<MemoryRollbackOverlay> {
  return withWorkspaceLock(root, async () => {
    const fs = new WorkspaceFs(root, null)
    const active = new Map<string, { id: string; text: string }>()
    const archived = new Map<string, { id: string; text: string }>()
    // 摘要图必须完整：跳过链接来源会把相关摘要误判为独立事实，回滚应在写入前明确失败。
    const validFiles: Array<{ file: string; id: string; identity: string; archived: boolean }> = []
    for (const file of await fs.list('memory', { rejectLinks: true })) {
      const fileMatch = /^(?:archive\/)?([^/]+)\.md$/.exec(file)
      if (!fileMatch || !isMemoryId(fileMatch[1])) continue
      const isArchived = file.startsWith('archive/')
      const identity = memoryIdentity(fileMatch[1])
      validFiles.push({ file, id: fileMatch[1], identity, archived: isArchived })
    }
    const texts = validFiles.length > 0
      ? await fs.readTextMany(validFiles.map((item) => `memory/${item.file}`))
      : []
    for (let i = 0; i < validFiles.length; i++) {
      const { id, identity, archived: isArchived } = validFiles[i]!
      const text = texts[i] ?? null
      if (text === null) continue
      if (isArchived) archived.set(identity, { id, text })
      else active.set(identity, { id, text })
    }
    return { fs, active, archived }
  })
}

/** 基于当前记忆镜像规划受影响摘要展开；缺失来源、损坏来源或任意长度环均在首次落盘前拒绝。 */
export function planMemoryExpansionFromOverlay(
  overlay: MemoryRollbackOverlay,
  paths: readonly string[],
): MemoryExpansionPlan | null {
  const changed = new Set(paths.flatMap((path) => {
    const match = /^memory\/([^/]+)\.md$/.exec(memoryIdentity(path))
    return match && isMemoryId(match[1]) ? [memoryIdentity(match[1])] : []
  }))
  if (!changed.size) return null
  const names = new Map<string, string>()
  const rawEntries = new Map<string, { id: string; sources: string[] }>()
  const corrupted = new Set<string>()
  const activePresent = new Set<string>()
  const archivedTexts = new Map<string, string>()
  const inspect = (identity: string, id: string, text: string, isArchived: boolean) => {
    const file = isArchived ? `archive/${id}.md` : `${id}.md`
    // 比较使用磁盘身份，实际读写仍用现存文件的拼写；活跃副本优先于归档副本。
    if (!names.has(identity) || !isArchived) names.set(identity, id)
    if (isArchived) archivedTexts.set(identity, text)
    else activePresent.add(identity)
    let entry
    try { entry = parseMemory(file, text) }
    catch {
      if (!isArchived) {
        corrupted.delete(identity)
        rawEntries.set(identity, { id, sources: [] })
      } else if (!rawEntries.has(identity)) {
        corrupted.add(identity)
      }
      return /* 损坏条目交由既有读取容错处理。 */
    }
    if (!isArchived) corrupted.delete(identity)
    // 来源损坏必须在展开写入之前失败，不能把摘要误作独立事实后继续撤销来源。
    const sources = memorySourceIds(entry.sourceRange)
    // 归档删除中断可能留下双份。活跃副本即使已被人工修订为无来源，也必须覆盖
    // 归档旧链；只收非空来源会让旧链重新把人工正文当作派生摘要删除。
    if (!rawEntries.has(identity) || !entry.archived) rawEntries.set(identity, { id: entry.id, sources })
  }
  for (const [identity, item] of overlay.archived) inspect(identity, item.id, item.text, true)
  for (const [identity, item] of overlay.active) inspect(identity, item.id, item.text, false)
  const canonicalId = (id: string) => names.get(memoryIdentity(id)) ?? id
  const summaries = new Map([...rawEntries.values()].filter(entry => entry.sources.length)
    .map(({ id, sources }) => [canonicalId(id), sources.map(canonicalId)]))
  const dependents = new Map<string, string[]>()
  for (const [id, sources] of summaries) {
    if (sources.some(source => memoryIdentity(source) === memoryIdentity(id))) throw new Error('记忆归并来源存在循环，已停止回滚')
    const broken = sources.find(source => corrupted.has(memoryIdentity(source)))
    if (broken) throw new Error(`记忆归并来源 ${broken} 损坏，已停止回滚`)
    for (const source of sources) {
      const sourceId = memoryIdentity(source)
      let list = dependents.get(sourceId)
      if (!list) {
        list = []
        dependents.set(sourceId, list)
      }
      list.push(id)
    }
  }
  const invalid = new Set<string>()
  const queue: string[] = []
  for (const sourceId of changed) {
    for (const dependent of dependents.get(sourceId) ?? []) {
      if (!invalid.has(dependent)) {
        invalid.add(dependent)
        queue.push(dependent)
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    for (const dependent of dependents.get(memoryIdentity(id)) ?? []) {
      if (!invalid.has(dependent)) {
        invalid.add(dependent)
        queue.push(dependent)
      }
    }
  }
  const visiting = new Set<string>()
  const expanded = new Set<string>()
  const restore = new Map<string, string>()
  const sourcesToUnarchive = new Set<string>()
  const postorder: string[] = []
  // 先只读规划整张受影响来源图。共享中间摘要只能展开一次，不能处理完一个父摘要就删掉
  // 另一个父摘要仍需读取的来源；缺失与循环也必须在第一次正文修改之前拒绝。
  for (const rootId of invalid) {
    if (!activePresent.has(memoryIdentity(rootId))) continue
    const pending = [{ id: rootId, exit: false }]
    while (pending.length) {
      const next = pending.pop()!
      if (next.exit) {
        visiting.delete(next.id)
        expanded.add(next.id)
        postorder.push(next.id)
        continue
      }
      if (expanded.has(next.id)) continue
      if (visiting.has(next.id)) throw new Error('记忆归并来源存在循环，已停止回滚')
      visiting.add(next.id)
      pending.push({ id: next.id, exit: true })
      for (const source of summaries.get(next.id) ?? []) {
        if (!sourcesToUnarchive.has(source)) {
          const sourceIdentity = memoryIdentity(source)
          if (!activePresent.has(sourceIdentity)) {
            const original = archivedTexts.get(sourceIdentity) ?? null
            if (original === null) throw new Error(`记忆归并来源 ${source} 缺失，已停止回滚`)
            restore.set(source, original)
          }
          sourcesToUnarchive.add(source)
        }
        if (invalid.has(source)) pending.push({ id: source, exit: false })
      }
    }
  }
  return { fs: overlay.fs, restore, sourcesToUnarchive, archivedTexts, activePresent, postorder }
}

/** 在内存镜像上推进一次摘要展开，供多楼层批量预检继续验证更旧楼层。 */
export function simulateMemoryExpansionOnOverlay(overlay: MemoryRollbackOverlay, plan: MemoryExpansionPlan | null): void {
  if (!plan) return
  for (const [id, original] of plan.restore) {
    overlay.active.set(memoryIdentity(id), { id, text: original })
  }
  for (const id of plan.sourcesToUnarchive) {
    overlay.archived.delete(memoryIdentity(id))
  }
  for (const id of plan.postorder) {
    overlay.active.delete(memoryIdentity(id))
  }
}

/** 在内存镜像上推进单个记忆文件的回滚目标（正文恢复或删除）。 */
export function applyMemoryFileToOverlay(overlay: MemoryRollbackOverlay, relPath: string, text: string | null): void {
  const match = /^memory\/(archive\/)?([^/]+)\.md$/.exec(relPath)
  if (!match || !isMemoryId(match[2]!)) return
  const target = match[1] ? overlay.archived : overlay.active
  const id = match[2]!
  const identity = memoryIdentity(id)
  if (text === null) target.delete(identity)
  else target.set(identity, { id, text })
}

/** 读取内存镜像中某个记忆文件的当前文本（用于推演 WAL rollbackTarget）。 */
export function readMemoryFileFromOverlay(overlay: MemoryRollbackOverlay, relPath: string): string | null {
  const match = /^memory\/(archive\/)?([^/]+)\.md$/.exec(relPath)
  if (!match || !isMemoryId(match[2]!)) return null
  const target = match[1] ? overlay.archived : overlay.active
  return target.get(memoryIdentity(match[2]!))?.text ?? null
}

/** 只读扫描并验证受影响的记忆归并谱系；缺失或循环会在写入与持久化游标前拒绝。 */
export async function planExpandAffectedMemories(root: string, paths: readonly string[]): Promise<MemoryExpansionPlan | null> {
  const hasMemoryPath = paths.some((path) => {
    const match = /^memory\/([^/]+)\.md$/.exec(memoryIdentity(path))
    return Boolean(match && isMemoryId(match[1]))
  })
  if (!hasMemoryPath) return null
  const overlay = await loadMemoryRollbackOverlay(root)
  return planMemoryExpansionFromOverlay(overlay, paths)
}

/** 执行已规划好的记忆归并展开：全部来源恢复后才删除归档与父摘要。 */
export async function applyExpandAffectedMemories(root: string, plan: MemoryExpansionPlan | null): Promise<void> {
  if (!plan) return
  const { fs, restore, sourcesToUnarchive, archivedTexts, activePresent, postorder } = plan
  return withWorkspaceLock(root, async () => {
    // 全部来源恢复后才删除归档；I/O 失败时保留摘要和原文，重试可从活跃副本继续。
    for (const [id, original] of restore) {
      await fs.writeText(`memory/${id}.md`, original)
      activePresent.add(memoryIdentity(id))
    }
    for (const id of sourcesToUnarchive) {
      if (archivedTexts.has(memoryIdentity(id))) await fs.delete(`memory/archive/${id}.md`)
    }
    // 逆后序确保所有父摘要先于共享子摘要删除，避免中途失败留下指向已删除子摘要的父级。
    for (const id of [...postorder].reverse()) {
      const idIdentity = memoryIdentity(id)
      if (activePresent.has(idIdentity)) await fs.delete(`memory/${id}.md`)
      if (archivedTexts.has(idIdentity)) await fs.delete(`memory/archive/${id}.md`)
    }
  })
}

export async function expandAffectedMemories(root: string, paths: readonly string[]): Promise<void> {
  const plan = await planExpandAffectedMemories(root, paths)
  if (plan) await applyExpandAffectedMemories(root, plan)
}
