/**
 * 世界状态变化层存储（WorldDeltaStore，plan 3.12.4）。
 * state/world-delta.jsonl，每行一个 WorldDelta JSON；文件小，整体读改写（经 WorkspaceFs 事务层）。
 * 「单条撤销」为行内 revoked 标记，不物理删除；toEngineEntries 把变化层归一化为世界书引擎的
 * 额外条目源（source='delta'），update/invalidate 紧随原条目之后并显式标注「当前状态」。
 */

import type { WorldDelta, WorldInfoEntry } from '../core/types.js'
import type { WorkspaceFs } from './workspaceFs.js'

const DELTA_FILE = 'state/world-delta.jsonl'

export class WorldDeltaStore {
  constructor(private readonly fs: WorkspaceFs) {}

  /** 读出全部非空原始行（保留原文，重写时不丢无法解析的行）。 */
  private async readRawLines(): Promise<string[]> {
    const text = await this.fs.readText(DELTA_FILE)
    if (!text) return []
    return text.split('\n').filter((line) => line.trim())
  }

  private static parseLine(line: string): WorldDelta | null {
    try {
      const value = JSON.parse(line) as WorldDelta
      return value && typeof value.id === 'string' ? value : null
    } catch {
      return null
    }
  }

  /** 追加一条变化：id = `d-<行号>`（现有行数 + 1，4 位补零）；ts 默认当前 ISO。 */
  async append(input: Omit<WorldDelta, 'id' | 'ts'> & { ts?: string }): Promise<WorldDelta> {
    const lines = await this.readRawLines()
    const delta: WorldDelta = {
      ...input,
      id: `d-${String(lines.length + 1).padStart(4, '0')}`,
      ts: input.ts ?? new Date().toISOString(),
    }
    await this.fs.writeText(DELTA_FILE, `${[...lines, JSON.stringify(delta)].join('\n')}\n`)
    return delta
  }

  /** 列出变化；默认过滤 revoked 与 expires 已过期（expires ISO < now），坏行跳过。 */
  async list(options?: { includeRevoked?: boolean; now?: Date }): Promise<WorldDelta[]> {
    const now = options?.now ?? new Date()
    const out: WorldDelta[] = []
    for (const line of await this.readRawLines()) {
      const delta = WorldDeltaStore.parseLine(line)
      if (!delta) continue
      if (!options?.includeRevoked && delta.revoked) continue
      if (delta.expires) {
        const expires = Date.parse(delta.expires)
        if (!Number.isNaN(expires) && expires < now.getTime()) continue
      }
      out.push(delta)
    }
    return out
  }

  /** 单条撤销：重写该行为 revoked: true（不物理删除）；未找到返回 false。 */
  async revoke(id: string): Promise<boolean> {
    const lines = await this.readRawLines()
    let found = false
    const next = lines.map((line) => {
      const delta = WorldDeltaStore.parseLine(line)
      if (!delta || delta.id !== id) return line
      found = true
      return JSON.stringify({ ...delta, revoked: true })
    })
    if (!found) return false
    await this.fs.writeText(DELTA_FILE, `${next.join('\n')}\n`)
    return true
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
