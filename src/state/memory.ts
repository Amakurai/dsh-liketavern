/**
 * 记忆存储（MemoryStore）。
 * 每条记忆一个 md 文件：memory/<id>.md（YAML frontmatter + 正文），压缩归档移入 memory/archive/。
 * frontmatter 手写解析（零依赖，不引入 yaml 库）：字段行 `key: value`，数组用 JSON 行内式
 * （`tags: ["a","b"]`）。一切文件读写经 WorkspaceFs（事务层）；检索复用核心 BM25
 * （keys 权重 ×2 已在索引侧内建），search 支持半衰期时间衰减（ts 取 updated）。
 */

import { randomBytes } from 'node:crypto'
import { Bm25Index } from '../core/bm25.js'
import { estimateTokens } from '../core/tokenize.js'
import type { MemoryEntry } from '../core/types.js'
import type { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'

/** 正文软上限（字）：超过不拒绝，write 返回值带 overLength: true，治理提示由工具层做。 */
export const MEMORY_BODY_SOFT_LIMIT = 200

const MEMORY_DIR = 'memory'
const ARCHIVE_PREFIX = 'archive/'

/** 落盘的 frontmatter 元数据；id 由文件名推导、archived 由路径推导，均不写入文件。 */
export interface MemoryMeta {
  created: string
  updated: string
  sourceRange: string
  tags: string[]
  keys: string[]
}

/** write 返回值：完整条目 + 超长软提示标记。 */
export type MemoryWriteResult = MemoryEntry & { overLength: boolean }

export interface MemoryStoreOptions {
  /** findSimilar 的默认返回条数（写入前去重提示用），默认 3。 */
  similarTopK?: number
}

export interface MemoryUpdateOptions {
  /** merge 供模型工具追加标签；replace 供设置面板把编辑结果完整覆盖（含清空）。 */
  listMode?: 'merge' | 'replace'
}

// ---------------------------------------------------------------------------
// frontmatter 序列化 / 解析（手写；解析失败抛错，由 list/get 容错跳过坏文件）
// ---------------------------------------------------------------------------

/** 序列化为 md 文本：frontmatter 字段行 + 空行 + 正文，文件以单个换行结尾。 */
export function serializeMemory(meta: MemoryMeta, body: string): string {
  // 标量值内的换行会破坏行式解析，序列化时压平
  const scalar = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim()
  return (
    [
      '---',
      `created: ${scalar(meta.created)}`,
      `updated: ${scalar(meta.updated)}`,
      `source_range: ${scalar(meta.sourceRange)}`,
      `tags: ${JSON.stringify(meta.tags)}`,
      `keys: ${JSON.stringify(meta.keys)}`,
      '---',
      '',
      body,
    ].join('\n') + '\n'
  )
}

/**
 * 解析 md 文本为 MemoryEntry。file 为相对 memory/ 目录的路径（如 `m-x.md`、`archive/m-x.md`）。
 * 缺少 frontmatter、created 缺失/非法、数组字段非 JSON 字符串数组时抛错。
 */
export function parseMemory(file: string, text: string): MemoryEntry {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') throw new Error(`记忆文件缺少 frontmatter: ${file}`)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`记忆文件 frontmatter 未闭合: ${file}`)

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!match) throw new Error(`frontmatter 字段行无法解析: ${file}: ${line}`)
    fields.set(match[1]!, match[2]!)
  }

  const created = fields.get('created') ?? ''
  if (!created || Number.isNaN(Date.parse(created))) {
    throw new Error(`记忆文件 created 缺失或非法: ${file}`)
  }
  const updatedRaw = fields.get('updated')
  const updated = updatedRaw && !Number.isNaN(Date.parse(updatedRaw)) ? updatedRaw : created

  const parseArray = (raw: string | undefined): string[] => {
    if (raw === undefined || raw.trim() === '') return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`frontmatter 数组字段非法: ${file}: ${raw}`)
    }
    return value
  }

  const base = file.split('/').pop()!.replace(/\.md$/i, '')
  if (!base) throw new Error(`记忆文件名非法: ${file}`)
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')

  return {
    id: base,
    file,
    created,
    updated,
    sourceRange: fields.get('source_range') ?? '',
    tags: parseArray(fields.get('tags')),
    keys: parseArray(fields.get('keys')),
    body,
    archived: file.startsWith(ARCHIVE_PREFIX),
  }
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly similarTopK: number
  /**
   * 解析结果与 BM25 索引缓存，按目录指纹（文件名 + mtime + size）失效。
   *
   * 为什么不用进程内修订号（对比 TavernState 的 presetCache / loreCache）：记忆文件除了本类
   * 还会被 WAL 回滚直接写回磁盘（楼层回退撤销本轮 memory_write），修订号捕获不到那条路径，
   * 会让检索一直用回滚前的索引。指纹是 N 次 stat（不读数据），比 N 次全文读 + 分词便宜一个量级。
   *
   * 缓存的收益点：一次 memory_write 要连着跑 findSimilar → stats → write，
   * 一个 turn 里 search 也可能被工具重复调用；没有缓存的话每次都全量重读 + 重建索引。
   */
  private cache: { fingerprint: string; entries: MemoryEntry[]; index?: Bm25Index<MemoryEntry> } | null = null

  constructor(
    private readonly fs: WorkspaceFs,
    options?: MemoryStoreOptions,
  ) {
    this.similarTopK = options?.similarTopK ?? 3
  }

  private pathOf(id: string, archived = false): string {
    return `${MEMORY_DIR}/${archived ? ARCHIVE_PREFIX : ''}${id}.md`
  }

  /**
   * 作废缓存。本类的写路径会自动调用；**楼层 WAL 回滚后调用方必须手动调一次**——
   * 回滚直接把旧内容写回磁盘，绕过本类，且「撤销一次 update」可能既不改文件大小
   * 也落在同一个 mtime 刻度内（`updated` 是定长 ISO 串），指纹兜不住这种情况。
   */
  invalidate(): void {
    this.cache = null
  }

  /** 解析 memory/*.md（不含 archive/），坏文件容错跳过；按 created 升序（并列按 id 字典序）。 */
  async list(): Promise<MemoryEntry[]> {
    return withWorkspaceLock(this.fs.root, () => this.listNow())
  }

  private async listNow(): Promise<MemoryEntry[]> {
    // 非递归列举：archive/ 只增不查，递归会让每次检索的成本随归档量增长。
    const stats = await this.fs.listStats(MEMORY_DIR)
    const files = stats.filter((f) => f.name.endsWith('.md'))
    const fingerprint = files.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`).join('\n')
    const cached = this.cache
    if (cached && cached.fingerprint === fingerprint) return cached.entries
    // 并行读取：记忆库上限几百条，串行 await 会让每次检索/写入前的全量 list 线性放大 I/O 等待。
    const parsed = await Promise.all(
      files.map(async (file) => {
        const text = await this.fs.readText(`${MEMORY_DIR}/${file.name}`)
        if (text === null) return null
        try {
          return parseMemory(file.name, text)
        } catch {
          return null // 坏文件跳过
        }
      }),
    )
    const entries = parsed.filter((e): e is MemoryEntry => e !== null)
    entries.sort((a, b) =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    this.cache = { fingerprint, entries }
    return entries
  }

  /** 按 id 取单条（不含 archive/）；不存在或坏文件返回 null。 */
  async get(id: string): Promise<MemoryEntry | null> {
    return withWorkspaceLock(this.fs.root, () => this.getNow(id))
  }

  private async getNow(id: string): Promise<MemoryEntry | null> {
    const text = await this.fs.readText(this.pathOf(id))
    if (text === null) return null
    try {
      return parseMemory(`${id}.md`, text)
    } catch {
      return null
    }
  }

  /** 写入新记忆；正文超过 200 字时返回值带 overLength: true（软提示，不拒绝）。 */
  async write(input: {
    body: string
    tags?: string[]
    keys?: string[]
    sourceRange?: string
  }): Promise<MemoryWriteResult> {
    const now = new Date().toISOString()
    // id = `m-<36 进制毫秒>-<随机 6 hex>`（对齐 worlddelta）：同毫秒只留 2 位 base36
    // 会碰撞静默覆盖（同轮连写两条记忆不罕见），随机段必须够宽。
    const id = `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const meta: MemoryMeta = {
      created: now,
      updated: now,
      sourceRange: input.sourceRange ?? '',
      tags: input.tags ?? [],
      keys: input.keys ?? [],
    }
    await this.fs.writeText(this.pathOf(id), serializeMemory(meta, input.body))
    this.invalidate()
    return {
      id,
      file: `${id}.md`,
      ...meta,
      body: input.body,
      archived: false,
      overLength: input.body.length > MEMORY_BODY_SOFT_LIMIT,
    }
  }

  /** 更新正文与 tags/keys、刷新 updated；默认合并列表，replace 模式允许 UI 删除或清空列表项。 */
  async update(
    id: string,
    patch: { body?: string; tags?: string[]; keys?: string[] },
    options?: MemoryUpdateOptions,
  ): Promise<MemoryEntry | null> {
    return withWorkspaceLock(this.fs.root, () => this.updateNow(id, patch, options))
  }

  private async updateNow(id: string, patch: { body?: string; tags?: string[]; keys?: string[] }, options?: MemoryUpdateOptions): Promise<MemoryEntry | null> {
    const existing = await this.get(id)
    if (!existing) return null
    const lists = options?.listMode ?? 'merge'
    const updateList = (current: string[], next: string[] | undefined): string[] => {
      if (next === undefined) return current
      return [...new Set(lists === 'replace' ? next : [...current, ...next])]
    }
    const meta: MemoryMeta = {
      created: existing.created,
      updated: new Date().toISOString(),
      // 面板明确改写摘要后，它成为人工修订，不再被来源回滚自动展开。
      sourceRange: lists === 'replace' && /^(?:compress|merge):/.test(existing.sourceRange) ? '' : existing.sourceRange,
      tags: updateList(existing.tags, patch.tags),
      keys: updateList(existing.keys, patch.keys),
    }
    const body = patch.body ?? existing.body
    await this.fs.writeText(this.pathOf(id), serializeMemory(meta, body))
    this.invalidate()
    return { ...existing, ...meta, body }
  }

  /** 事务删除（经 fs.delete）；不存在返回 false。 */
  async delete(id: string): Promise<boolean> {
    return withWorkspaceLock(this.fs.root, async () => {
      if ((await this.fs.readText(this.pathOf(id))) === null) return false
      await this.fs.delete(this.pathOf(id))
      this.invalidate()
      return true
    })
  }

  /** 移入 memory/archive/（读原文件 → 写 archive 路径 → 删原路径，全经 fs）；返回移动条数。 */
  async archive(ids: string[]): Promise<number> {
    return withWorkspaceLock(this.fs.root, () => this.archiveNow(ids))
  }

  private async archiveNow(ids: string[]): Promise<number> {
    let moved = 0
    for (const id of ids) {
      const text = await this.fs.readText(this.pathOf(id))
      if (text === null) continue
      await this.fs.writeText(this.pathOf(id, true), text)
      await this.fs.delete(this.pathOf(id))
      moved++
    }
    if (moved > 0) this.invalidate()
    return moved
  }

  /** 归并使用乐观校验：等待 LLM 时来源被编辑、删除或回滚，就放弃旧摘要。 */
  async mergeBatch(batch: readonly MemoryEntry[], body: string, kind: 'compress' | 'merge'): Promise<number> {
    return withWorkspaceLock(this.fs.root, async () => {
      for (const source of batch) {
        const current = await this.get(source.id)
        if (!current || serializeMemory(current, current.body) !== serializeMemory(source, source.body)) return 0
      }
      if (!batch.length) return 0
      await this.write({
        body,
        tags: [...new Set([kind === 'compress' ? 'compressed' : 'merged', ...batch.flatMap((entry) => entry.tags)])],
        keys: [...new Set(batch.flatMap((entry) => entry.keys))],
        sourceRange: `${kind}:${batch.map((entry) => entry.id).join(',')}`,
      })
      return this.archive(batch.map((entry) => entry.id))
    })
  }

  /**
   * 以当前活跃记忆构建 BM25 索引。
   * 与 list 共用指纹缓存：记忆没变过就复用上次的索引，不重读也不重分词
   * （分词是 CJK bigram，重建成本与库体量成正比，一个 turn 里可能被调多次）。
   */
  private async buildIndex(): Promise<Bm25Index<MemoryEntry>> {
    const entries = await this.list()
    const cached = this.cache
    if (cached?.index) return cached.index
    const index = new Bm25Index<MemoryEntry>()
    for (const entry of entries) {
      index.add({
        id: entry.id,
        text: entry.body,
        keys: entry.keys,
        ts: Date.parse(entry.updated),
        data: entry,
      })
    }
    // list 刚刚按当前指纹填过 cache，这里把索引挂上去；指纹变化时整条缓存会被换掉。
    // 引用相等校验：await list 期间若另一任务 write → invalidate → list（缓存被换成新指纹对象），
    // 不能把「旧 entries 建出的索引」挂到新缓存上，否则检索会一直用旧索引直到下次指纹变化。
    if (this.cache && this.cache.entries === entries) this.cache.index = index
    return index
  }

  /**
   * 写入前去重检索：query = text + keys，BM25（keys 加权内建），不做时间衰减。
   * 工具层据此提示 agent 改用 update 合并，而不是重复 write。
   */
  async findSimilar(
    text: string,
    keys: string[],
    topK?: number,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const index = await this.buildIndex()
    return index
      .search([text, ...keys].join(' '), { topK: topK ?? this.similarTopK })
      .map((hit) => ({ entry: hit.data!, score: hit.score }))
  }

  /** 检索：BM25 + 可选半衰期时间衰减（ts 用 updated；now/halfLifeMs 可注入以便测试）。 */
  async search(
    query: string,
    options?: { topK?: number; halfLifeMs?: number; now?: number },
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const index = await this.buildIndex()
    return index.search(query, options).map((hit) => ({ entry: hit.data!, score: hit.score }))
  }

  /** 容量统计：条数与正文 token 粗估累加。 */
  async stats(): Promise<{ count: number; tokens: number }> {
    const entries = await this.list()
    return {
      count: entries.length,
      tokens: entries.reduce((sum, entry) => sum + estimateTokens(entry.body), 0),
    }
  }

  /** 最旧的 n 条（created 升序），压缩取批次用。 */
  async oldest(n: number): Promise<MemoryEntry[]> {
    return (await this.list()).slice(0, Math.max(0, n))
  }
}
