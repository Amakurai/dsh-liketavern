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

  constructor(
    private readonly fs: WorkspaceFs,
    options?: MemoryStoreOptions,
  ) {
    this.similarTopK = options?.similarTopK ?? 3
  }

  private pathOf(id: string, archived = false): string {
    return `${MEMORY_DIR}/${archived ? ARCHIVE_PREFIX : ''}${id}.md`
  }

  /** 解析 memory/*.md（不含 archive/），坏文件容错跳过；按 created 升序（并列按 id 字典序）。 */
  async list(): Promise<MemoryEntry[]> {
    // 并行读取：记忆库上限几百条，串行 await 会让每次检索/写入前的全量 list 线性放大 I/O 等待。
    const files = (await this.fs.list(MEMORY_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith(ARCHIVE_PREFIX))
    const parsed = await Promise.all(
      files.map(async (file) => {
        const text = await this.fs.readText(`${MEMORY_DIR}/${file}`)
        if (text === null) return null
        try {
          return parseMemory(file, text)
        } catch {
          return null // 坏文件跳过
        }
      }),
    )
    const entries = parsed.filter((e): e is MemoryEntry => e !== null)
    entries.sort((a, b) =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    return entries
  }

  /** 按 id 取单条（不含 archive/）；不存在或坏文件返回 null。 */
  async get(id: string): Promise<MemoryEntry | null> {
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
      sourceRange: existing.sourceRange,
      tags: updateList(existing.tags, patch.tags),
      keys: updateList(existing.keys, patch.keys),
    }
    const body = patch.body ?? existing.body
    await this.fs.writeText(this.pathOf(id), serializeMemory(meta, body))
    return { ...existing, ...meta, body }
  }

  /** 事务删除（经 fs.delete）；不存在返回 false。 */
  async delete(id: string): Promise<boolean> {
    if ((await this.fs.readText(this.pathOf(id))) === null) return false
    await this.fs.delete(this.pathOf(id))
    return true
  }

  /** 移入 memory/archive/（读原文件 → 写 archive 路径 → 删原路径，全经 fs）；返回移动条数。 */
  async archive(ids: string[]): Promise<number> {
    let moved = 0
    for (const id of ids) {
      const text = await this.fs.readText(this.pathOf(id))
      if (text === null) continue
      await this.fs.writeText(this.pathOf(id, true), text)
      await this.fs.delete(this.pathOf(id))
      moved++
    }
    return moved
  }

  /** 以当前活跃记忆构建临时 BM25 索引（记忆规模小，每次重建即可）。 */
  private async buildIndex(): Promise<Bm25Index<MemoryEntry>> {
    const index = new Bm25Index<MemoryEntry>()
    for (const entry of await this.list()) {
      index.add({
        id: entry.id,
        text: entry.body,
        keys: entry.keys,
        ts: Date.parse(entry.updated),
        data: entry,
      })
    }
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
