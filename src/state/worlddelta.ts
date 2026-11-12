/**
 * 世界状态变化层存储（WorldDeltaStore，plan 3.12.4）。
 * state/world-delta.jsonl，每行一个 WorldDelta JSON；文件小，整体读改写（经 WorkspaceFs 事务层）。
 * 「单条撤销」为行内 revoked 标记，不物理删除；toEngineEntries 把变化层归一化为世界书引擎的
 * 额外条目源（source='delta'），update/invalidate 紧随原条目之后并显式标注「当前状态」。
 *
 * 读改写与回退共用工作区锁：所有实例串行执行，防止工具与设置面板并发修改丢行。
 * id 用毫秒时间戳 + 随机后缀而不按行数推导：WAL 回滚把 jsonl 恢复到更短状态后，
 * 行数推导会让新 append 复用旧 id，revoke 可能误撤。
 */

import { randomBytes } from 'node:crypto'
import { array, boolean, enum as enum_, looseObject, minLength, nullable, number, optional, safeParse, string } from 'zod/mini'
import type { WorldDelta, WorldInfoEntry } from '../core/types.js'
import { rootIdentity, sameFileStat, type FileStatStamp } from './pathIdentity.js'
import type { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'
import { openLedger, writtenSince, type WriteLedger } from './writeLedger.js'

const DELTA_FILE = 'state/world-delta.jsonl'
const MAX_DELTA_CACHE_ROOTS = 64

interface CachedWorldDeltas {
  stat: FileStatStamp | null
  revision: number
  epoch: number
  parsed: readonly WorldDelta[]
}

const worldDeltaCache = new Map<string, CachedWorldDeltas>()

function rememberWorldDeltas(key: string, entry: CachedWorldDeltas): void {
  worldDeltaCache.delete(key)
  worldDeltaCache.set(key, entry)
  if (worldDeltaCache.size > MAX_DELTA_CACHE_ROOTS) {
    worldDeltaCache.delete(worldDeltaCache.keys().next().value!)
  }
}

/** 磁盘 JSON 必须满足实际业务形状，不能仅凭 id 就把错型字段送入引擎或编辑器。 */
const deltaSchema = looseObject({
  id: string().check(minLength(1)), ts: string(), type: enum_(['add', 'update', 'invalidate']),
  ref: nullable(string()), content: string(), keys: array(string()), order: number(),
  sourceRange: string(), expires: nullable(string()), revoked: optional(boolean()),
})

/**
 * 同一角色工作区可能同时存在共享句柄、楼层派生句柄和多个 plainWorkspace 实例。
 * 队列必须按工作区根共享；放在实例字段里会让两个「读全部行 → 全量重写」互相覆盖。
 */

export class WorldDeltaStore {
  private readonly ledger: WriteLedger
  private readonly cacheKey: string

  constructor(private readonly fs: WorkspaceFs) {
    this.ledger = openLedger(fs.root)
    this.cacheKey = rootIdentity(fs.root)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return withWorkspaceLock(this.fs.root, task)
  }

  /** 读出全部非空原始行（保留原文，重写时不丢无法解析的行）。 */
  private async readRawLines(): Promise<string[]> {
    const text = await this.fs.readText(DELTA_FILE)
    if (!text) return []
    return text.split('\n').filter((line) => line.trim())
  }

  private static parseLine(line: string): WorldDelta | null {
    try {
      const result = safeParse(deltaSchema, JSON.parse(line))
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  private async readParsedDeltas(): Promise<readonly WorldDelta[]> {
    const revision = this.ledger.counter
    const epoch = this.ledger.epoch
    const stat = await this.fs.stat(DELTA_FILE)
    const cached = worldDeltaCache.get(this.cacheKey)
    if (
      cached &&
      cached.epoch === epoch &&
      !writtenSince(this.ledger, DELTA_FILE, cached.revision) &&
      sameFileStat(cached.stat, stat)
    ) {
      rememberWorldDeltas(this.cacheKey, cached)
      return cached.parsed
    }
    if (stat === null) {
      if (!writtenSince(this.ledger, DELTA_FILE, revision) && this.ledger.epoch === epoch) {
        rememberWorldDeltas(this.cacheKey, { stat: null, revision, epoch, parsed: [] })
      }
      return []
    }
    const parsed: WorldDelta[] = []
    for (const line of await this.readRawLines()) {
      const delta = WorldDeltaStore.parseLine(line)
      if (delta) parsed.push(delta)
    }
    const afterStat = await this.fs.stat(DELTA_FILE)
    if (sameFileStat(stat, afterStat) && !writtenSince(this.ledger, DELTA_FILE, revision) && this.ledger.epoch === epoch) {
      rememberWorldDeltas(this.cacheKey, { stat, revision, epoch, parsed })
    }
    return parsed
  }

  /** 追加一条变化：id = `d-<36 进制毫秒>-<随机 6 hex>`（不依赖行数，回滚后不复用旧 id）；ts 默认当前 ISO。 */
  async append(input: Omit<WorldDelta, 'id' | 'ts'> & { ts?: string }): Promise<WorldDelta> {
    return this.enqueue(async () => {
      const lines = await this.readRawLines()
      const delta: WorldDelta = {
        ...input,
        id: `d-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
        ts: input.ts ?? new Date().toISOString(),
      }
      deltaSchema.parse(delta)
      await this.fs.writeText(DELTA_FILE, `${[...lines, JSON.stringify(delta)].join('\n')}\n`)
      return delta
    })
  }

  /** 列出变化；默认过滤 revoked 与 expires 已过期（expires ISO <= now），坏行跳过。 */
  async list(options?: { includeRevoked?: boolean; now?: Date }): Promise<WorldDelta[]> {
    // 读也排进同一工作区队列，避免读到另一个实例正在覆盖写入时的半截文件。
    return this.enqueue(() => this.listNow(options))
  }

  private async listNow(options?: { includeRevoked?: boolean; now?: Date }): Promise<WorldDelta[]> {
    const now = options?.now ?? new Date()
    const out: WorldDelta[] = []
    for (const delta of await this.readParsedDeltas()) {
      if (!options?.includeRevoked && delta.revoked) continue
      if (delta.expires) {
        const expires = Date.parse(delta.expires)
        if (!Number.isNaN(expires) && expires <= now.getTime()) continue
      }
      out.push({ ...delta, keys: [...delta.keys] })
    }
    return out
  }

  /** 单条撤销：重写该行为 revoked: true（不物理删除）；未找到返回 false。同样在互斥队列内。 */
  async revoke(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const lines = await this.readRawLines()
      let found = false
      const next = lines.map((line) => {
        const delta = WorldDeltaStore.parseLine(line)
        if (!delta || delta.id !== id || delta.revoked) return line
        found = true
        return JSON.stringify({ ...delta, revoked: true })
      })
      if (!found) return false
      await this.fs.writeText(DELTA_FILE, `${next.join('\n')}\n`)
      return true
    })
  }

  /**
   * 变化层 → 世界书引擎条目（plan 3.12.4）：
   * ref 命中时 order = resolveRefOrder(ref) + 0.5（紧随原条目之后），否则用 delta.order；
   * update/invalidate 的 content 显式标注「当前状态」。空 keys 且 constant=false → 永不命中。
   */
  toEngineEntries(
    deltas: WorldDelta[],
    resolveRefOrder: (ref: string) => number | null,
  ): WorldInfoEntry[] {
    return deltas.map((delta): WorldInfoEntry => {
      const refOrder = delta.ref === null ? null : resolveRefOrder(delta.ref)
      let content = delta.content
      if (delta.type === 'update') content = `【当前状态·更新】${delta.content}`
      else if (delta.type === 'invalidate') content = `【当前状态·已失效】${delta.content}`
      return {
        key: `delta:world-delta:${delta.id}`,
        uid: delta.id,
        source: 'delta',
        sourceRef: 'world-delta',
        keys: delta.keys,
        secondaryKeys: [],
        selective: false,
        selectiveLogic: 0,
        comment: `变化层 ${delta.type}`,
        content,
        constant: false,
        enabled: true,
        order: refOrder === null ? delta.order : refOrder + 0.5,
        position: 1, // afterCharDefs
        depth: 4,
        role: 0, // system
        outletName: '',
        probability: 100,
        useProbability: false,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ignoreBudget: false,
        group: '',
        groupWeight: 100,
        groupOverride: false,
        automationId: '',
        deltaType: delta.type,
        deltaRef: delta.ref,
      }
    })
  }
}
