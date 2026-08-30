/**
 * Tavern 模型工具：记忆检索/写入/更新、世界书按条阅读、世界状态更新、资产清单/阅读。
 * 全部经 exec.agent 定位会话绑定与角色工作区；写操作经 WorkspaceFs（落入楼层 WAL）。
 *
 * WI/记忆检索按 turn 缓存（pipeline.ts），工具写入不重评世界书定时器——这是有意的。
 * 写入成功后经 agent.inject 发一条同轮确认（不当作用户台词、不扫世界书），
 * 下一步看得到，检索层仍从下一 turn 起生效。
 * 工具执行（含读工具）还会按 turn:nextStep 去重注入【Tavern 步骤】收口通知：
 * turn playbook 是固定文本（吃宿主快照去重），多步压力改由这条 inject 承载。
 * 记忆超容量压缩不在工具内同步执行：只标记 state.pendingMemoryCompress，
 * turn 结束后由 memoryMaintenance.ts 的 runMaintenance 合并（不记 WAL，不回滚）。
 * 所有读工具的结果都有条数与 token 预算上限（检索/目录一律截断并报告 omitted/truncated），
 * 不把整库正文或整棵工作区目录灌进上下文。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import {
  clipAssetText,
  findPresetEntry,
  isPresetCatalogToken,
  listPresetCatalog,
  resolveReadableAssetPath,
} from '../core/assetRead.js'
import { defaultPreset } from '../core/assemble.js'
import { TURN_WRITE_ACK_PREFIX, formatTurnStepNotice, neutralizeDshMustache } from '../core/dshPrompt.js'
import { memorySearchOptions } from '../core/memoryRetrieval.js'
import {
  LORE_CATALOG_MAX,
  clipLoreContents,
  isLoreCatalogQuery,
  selectLoreEntries,
  toLoreCatalogItem,
  type LoreReadQuery,
} from '../core/loreQuery.js'
import { clipToTokenBudget, estimateTokens } from '../core/tokenize.js'
import type { MemoryEntry } from '../core/types.js'
import { rebuildIndex } from '../state/workspace.js'
import type { WorkspaceFs } from '../state/workspaceFs.js'
import type { SessionBinding } from './bindings.js'
import { loadBoundLoreEntries } from './pipeline.js'
import type { TavernState } from './state.js'

/** 记忆检索一次返回的条数上限：对齐 tavern_lore_read 的 LORE_READ_MAX_TOPK，模型给的 topK 再大也不放行。 */
const MEMORY_SEARCH_MAX_TOPK = 20
/** 资产目录条数上限：对齐世界书目录的 LORE_CATALOG_MAX，工作区文件多了也不整棵树倾倒。 */
const ASSET_CATALOG_MAX = 200

interface ToolCtx {
  binding: SessionBinding
  ws: { fs: WorkspaceFs; memory: import('../state/memory.js').MemoryStore; deltas: import('../state/worlddelta.js').WorldDeltaStore }
  sessionId: string
}

type ToolResultValue = Record<string, unknown>

function text(value: ToolResultValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

async function resolveCtx(
  state: TavernState,
  exec: ToolRunContext,
  options?: { requireOpenFloor?: boolean },
): Promise<ToolCtx | { error: string }> {
  const agent = exec.agent
  if (!agent) return { error: 'no-agent：该工具只能在 Tavern 会话中使用' }
  const sessionId = agent.id
  // 确保 turn/start 已经 beginFloor；否则本 step 的工具写入会逃出楼层事务。
  await state.waitForSessionTasks(sessionId)
  // 写工具的事务性校验：beginFloor 失败时 host 只 warn（见 index.ts），turn 照常运行，
  // 但那之后的所有写入都不记 WAL、无法回滚——宁可在这里报错让模型稍后重试，
  // 也不要静默产生一个回退边界错乱的楼层。waitForSessionTasks 之后 openFloors 必然已定。
  if (options?.requireOpenFloor && !state.openFloors.has(sessionId)) {
    return { error: 'floor-not-open：本层写入事务未开启（楼层 beginFloor 失败或 turn 未开始），已拒绝写入以保住可回滚性；请稍后重试或告知用户' }
  }
  const binding = await state.loadBinding(sessionId)
  if (!binding) return { error: 'no-binding：当前会话未绑定 Tavern 角色卡' }
  const ws = await state.workspace(binding.cardId)
  // 7 个工具（含读工具）的统一收口通知注入点：走到这里说明本轮确实在做多步。
  maybeInjectStepNotice(state, exec)
  return { binding, ws, sessionId }
}

function injectWriteAck(exec: ToolRunContext, detail: string): void {
  const agent = exec.agent
  if (!agent) return
  try {
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: neutralizeDshMustache(`${TURN_WRITE_ACK_PREFIX}${detail}`) }],
        source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '同轮写入确认' },
      }),
    )
  } catch {
    // 注入失败不阻断工具结果
  }
}

/**
 * 工具执行时顺便注入步骤收口通知（【Tavern 步骤】）：turn playbook 已改成固定文本以吃满
 * 宿主 runtime context 快照去重，「第几步该收口」的压力只能从 playbook 挪到这条 inject。
 * 只能在工具执行里注入——pre-step 里 inject 要等下一步 preStep 才被认领（晚一步），
 * 且 turn 结束判定会把它当未消费的 nextStep 输入、强行多拉一步产生孤儿通知。
 * 按 turn:nextStep 去重；check-and-set 之间无 await，并行工具调用不会重复注入。
 */
function maybeInjectStepNotice(state: TavernState, exec: ToolRunContext): void {
  const agent = exec.agent
  if (!agent) return
  const sessionId = agent.id
  const turn = state.currentTurns.get(sessionId)
  const step = state.currentSteps.get(sessionId)
  if (turn === undefined || step === undefined) return
  const nextStep = step + 1
  const mark = `${turn}:${nextStep}`
  if (state.stepNoticeMarks.get(sessionId) === mark) return
  state.stepNoticeMarks.set(sessionId, mark)
  try {
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: neutralizeDshMustache(formatTurnStepNotice(nextStep)) }],
        source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '多步收口提示' },
      }),
    )
  } catch {
    // 注入失败不阻断工具结果
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

/** 对齐 clampLoreTopK：非法/非正数回退设置值，再统一压到 MEMORY_SEARCH_MAX_TOPK。 */
function clampMemoryTopK(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Math.floor(fallback)
  return Math.max(0, Math.min(MEMORY_SEARCH_MAX_TOPK, raw))
}

/** 记忆检索命中：正文在预算内裁剪，超预算的只留元数据（id 仍能用 tavern_asset_read 读 memory/<id>.md）。 */
interface MemoryHitItem {
  id: string
  score: number
  tags: string[]
  keys: string[]
  body: string
  truncated: boolean
  omitted?: boolean
}

/**
 * 对齐 clipLoreContents：按相关性顺序装入 token 预算，超预算的条目不再给正文。
 * 记忆库上限 200 条 / 20000 token，没有预算的话一次检索就能把整库灌进上下文。
 */
function clipMemoryHits(
  hits: readonly { entry: MemoryEntry; score: number }[],
  budget: number,
): { results: MemoryHitItem[]; tokensUsed: number; omitted: number } {
  const limit = Math.max(0, Math.floor(budget))
  const results: MemoryHitItem[] = []
  let used = 0
  let omitted = 0
  for (const hit of hits) {
    const meta = { id: hit.entry.id, score: hit.score, tags: hit.entry.tags, keys: hit.entry.keys }
    const remain = limit - used
    if (remain <= 0) {
      omitted += 1
      results.push({ ...meta, body: '', truncated: true, omitted: true })
      continue
    }
    const clipped = clipToTokenBudget(hit.entry.body, remain)
    results.push({ ...meta, body: clipped.text, truncated: clipped.truncated })
    used += clipped.tokens
  }
  return { results, tokensUsed: used, omitted }
}

export function registerTavernTools(ctx: Context, state: TavernState): void {
  // ── tavern_memory_search ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_memory_search',
      description: '检索当前角色的长期记忆（BM25）。仅当 runtime context 里的记忆不够、需要核对更早事实时调用；不要每轮例行检索。',
      parameters: {
        query: { type: 'string', required: true, description: '检索查询（自然语言或关键词）' },
        topK: { type: 'number', description: `返回条数上限（默认跟随设置，最大 ${MEMORY_SEARCH_MAX_TOPK}）` },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const config = state.config.memory
        const topK = clampMemoryTopK(args.topK, config.retrievalTopK)
        const hits = await resolved.ws.memory.search(args.query, memorySearchOptions(topK, config.halfLifeDays))
        const clipped = clipMemoryHits(hits, config.retrievalTokenBudget)
        return {
          ok: true,
          count: hits.length,
          tokensUsed: clipped.tokensUsed,
          omitted: clipped.omitted,
          results: clipped.results as unknown as JsonValue,
          ...(clipped.omitted > 0
            ? { hint: '超出 token 预算的条目只给了 id/标签/关键词；确需正文用 tavern_asset_read({ path: "memory/<id>.md" }) 按条读。' }
            : {}),
        }
      },
    }),
  )

  // ── tavern_memory_write ─────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_memory_write',
      description: '写入一条长期记忆。正文建议 200 字以内，只记事实与关系/状态变化。高度相似时应改用 tavern_memory_update。检索层下一轮才更新；同轮会注入写入确认，写完后仍须输出扮演正文。超出容量时最旧一批记忆会在本轮结束后自动压缩合并。',
      parameters: {
        body: { type: 'string', required: true, description: '记忆正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
        keys: { type: 'array', items: { type: 'string' }, description: '触发关键词（可选）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec, { requireOpenFloor: true })
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { ws } = resolved
        const config = state.config.memory

        const similar = await ws.memory.findSimilar(args.body, args.keys ?? [])
        const top = similar[0]
        if (top && top.score >= config.dedupScore) {
          return {
            ok: false,
            status: 'similar-found',
            similarId: top.entry.id,
            similarBody: top.entry.body,
            hint: '已存在高度相似的记忆，请改用 tavern_memory_update 更新该条目',
          }
        }

        // 超容量不再在本 step 同步压缩（避免多一次阻塞的 LLM 调用）：
        // 标记该工作区，turn 结束后由 runMaintenance 合并最旧批次（见 memoryMaintenance.ts）。
        const stats = await ws.memory.stats()
        const incomingTokens = estimateTokens(args.body)
        const compressScheduled = stats.count + 1 > config.maxEntries || stats.tokens + incomingTokens > config.maxTokens
        if (compressScheduled) state.pendingMemoryCompress.add(resolved.binding.cardId)

        const entry = await ws.memory.write({ body: args.body, tags: args.tags, keys: args.keys })
        await rebuildIndex(ws.fs, estimateTokens)
        injectWriteAck(exec, `记忆 id=${entry.id} 已落盘。下一轮才进入检索层；本轮把该事实视为已知，现在输出扮演正文。`)
        return {
          ok: true,
          id: entry.id,
          overLength: entry.overLength,
          ...(compressScheduled ? { compressScheduled: true } : {}),
        }
      },
    }),
  )

  // ── tavern_memory_update ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_memory_update',
      description: '更新一条已有记忆（正文/标签/关键词）。标签与关键词为并入语义（取并集）。检索层下一轮才更新；同轮会注入写入确认，改完后仍须输出扮演正文。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆条目 id' },
        body: { type: 'string', description: '新正文（可选）' },
        tags: { type: 'array', items: { type: 'string' }, description: '追加标签（可选）' },
        keys: { type: 'array', items: { type: 'string' }, description: '追加关键词（可选）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec, { requireOpenFloor: true })
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const entry = await resolved.ws.memory.update(args.id, { body: args.body, tags: args.tags, keys: args.keys })
        if (!entry) return { ok: false, error: `not-found：记忆 ${args.id} 不存在` }
        await rebuildIndex(resolved.ws.fs, estimateTokens)
        injectWriteAck(exec, `记忆 id=${entry.id} 已更新。下一轮才进入检索层；本轮把更新视为已知，现在输出扮演正文。`)
        return { ok: true, id: entry.id, updated: entry.updated }
      },
    }),
  )

  // ── tavern_lore_read ────────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_lore_read',
      description:
        '阅读世界书（全局/角色/会话/变化层）。不带参数返回目录（uid/键/摘要）；给 uid 或 query 再取正文。不要整本倾倒。仅当本轮 context 缺设定或长上下文遗忘时调用。',
      parameters: {
        uid: { type: 'string', description: '条目 uid 或完整 key；优先精确匹配' },
        query: { type: 'string', description: '关键词，匹配键/注释/正文' },
        source: { type: 'string', description: '限定来源：global / character / chat / delta' },
        topK: { type: 'number', description: 'query 模式返回条数（默认 6，最大 20）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const q: LoreReadQuery = {
          uid: asOptionalString(args.uid),
          query: asOptionalString(args.query),
          source: asOptionalString(args.source),
          topK: typeof args.topK === 'number' ? args.topK : undefined,
        }
        const { entries } = await loadBoundLoreEntries(state, resolved.binding)
        if (isLoreCatalogQuery(q)) {
          const source = q.source?.trim()
          const scoped = source ? entries.filter((e) => e.source === source) : entries
          const catalog = scoped.slice(0, LORE_CATALOG_MAX).map(toLoreCatalogItem)
          return {
            ok: true,
            mode: 'catalog',
            count: scoped.length,
            truncated: scoped.length > LORE_CATALOG_MAX,
            entries: catalog as unknown as JsonValue,
            hint: '用 uid 或 query 取正文；disabled 条目仍可读。',
          }
        }
        const selected = selectLoreEntries(entries, q)
        if (selected.length === 0) {
          return { ok: true, mode: 'content', entries: [], hint: '无匹配。先不带参数看目录。' }
        }
        const clipped = clipLoreContents(selected)
        return {
          ok: true,
          mode: 'content',
          tokensUsed: clipped.tokensUsed,
          omitted: clipped.omitted,
          entries: clipped.entries as unknown as JsonValue,
        }
      },
    }),
  )

  // ── tavern_worldstate_update ────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_worldstate_update',
      description:
        '记录一条世界状态变化（剧情中已确定发生的事实）。type：add=新增事实；update=更新某条世界书条目（需给 ref=条目 uid）；invalidate=宣告某条目失效（需给 ref）。下一轮起注入提示词；同轮会注入写入确认，写完后仍须输出扮演正文。',
      parameters: {
        type: { type: 'string', required: true, enum: ['add', 'update', 'invalidate'], description: '变化类型' },
        content: { type: 'string', required: true, description: '变化内容（当前状态描述）' },
        ref: { type: 'string', description: '指向的世界书条目 uid（update/invalidate 必填）' },
        keys: { type: 'array', items: { type: 'string' }, description: '触发关键词（可选）' },
        expiresAt: { type: 'string', description: '过期时间 ISO 字符串（可选，默认不过期）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec, { requireOpenFloor: true })
        if ('error' in resolved) return { ok: false, error: resolved.error }
        if ((args.type === 'update' || args.type === 'invalidate') && !args.ref) {
          return { ok: false, error: `invalid-args：type=${args.type} 需要提供 ref` }
        }
        const turn = state.currentTurns.get(resolved.sessionId) ?? 0
        const delta = await resolved.ws.deltas.append({
          type: args.type,
          ref: args.ref ?? null,
          content: args.content,
          keys: args.keys ?? [],
          order: 100,
          sourceRange: `t${turn}`,
          expires: args.expiresAt ?? null,
        })
        injectWriteAck(
          exec,
          `世界状态 id=${delta.id} type=${args.type} 已记录。下一轮才注入检索层；本轮视为已知，现在输出扮演正文。`,
        )
        return { ok: true, id: delta.id }
      },
    }),
  )

  // ── tavern_asset_list ───────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_asset_list',
      description: '列出当前角色工作区可读文本资产、绑定预设条目目录（与 tavern_asset_read 的白名单一致，不含 WAL/图片）。读取正文用 tavern_asset_read（path 或 preset）。不要每轮例行调用。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(_args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { binding, ws } = resolved
        const raw = await ws.fs.readText('index.json')
        // 坏文件（写盘截断等）按 index: null 返回，与 loadPreset / getChatLorebook 等
        // 读取路径同一容错——索引只是目录提示，不该让工具每次必抛。
        let index: JsonValue = null
        if (raw !== null) {
          try {
            index = JSON.parse(raw) as JsonValue
          } catch {
            // 损坏按无索引处理
          }
        }
        const memStats = await ws.memory.stats()
        const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset()
        // 目录必须与 tavern_asset_read 的可读白名单一致：同一个 resolveReadableAssetPath 过滤，
        // 否则会向模型广告 state/wal/*、回滚残留目录、card.png 这些 asset_read 一律拒绝的路径。
        const readable = (await ws.fs.list()).filter((p) => resolveReadableAssetPath(p).ok)
        return {
          ok: true,
          index,
          memory: memStats,
          files: readable.slice(0, ASSET_CATALOG_MAX),
          fileCount: readable.length,
          filesTruncated: readable.length > ASSET_CATALOG_MAX,
          preset: { id: preset.identifier, name: preset.name, entries: listPresetCatalog(preset) },
          hint: '读文件：tavern_asset_read({ path: "journal.md" })；读预设：tavern_asset_read({ preset: "identifier 或 list" })',
        } as unknown as JsonValue
      },
    }),
  )

  // ── tavern_asset_read ───────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'tavern_asset_read',
      description:
        '阅读工作区文本文件或预设条目（含未启用）。path 如 journal.md、index.json、memory/xxx.md、assets/character-book.json；preset 填 list 列目录，或填 identifier 取正文。不读 WAL/图片。',
      parameters: {
        path: { type: 'string', description: '工作区相对路径' },
        preset: { type: 'string', description: 'list/* 列出预设条目；或条目 identifier' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value as ToolResultValue),
      },
      async execute(args, exec): Promise<JsonValue> {
        const resolved = await resolveCtx(state, exec)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const pathArg = asOptionalString(args.path)
        const presetArg = asOptionalString(args.preset)
        if (!pathArg?.trim() && presetArg === undefined) {
          return { ok: false, error: '需要 path 或 preset。先用 tavern_asset_list 看目录。' }
        }

        const out: ToolResultValue = { ok: true }

        if (presetArg !== undefined) {
          const preset = (resolved.binding.presetId ? await state.loadPreset(resolved.binding.presetId) : null) ?? defaultPreset()
          if (isPresetCatalogToken(presetArg)) {
            out.preset = { id: preset.identifier, name: preset.name, mode: 'catalog', entries: listPresetCatalog(preset) }
          } else {
            const entry = findPresetEntry(preset, presetArg)
            if (!entry) {
              return {
                ok: false,
                error: `not-found：预设条目 ${presetArg} 不存在`,
                hint: 'preset 填 list 查看 identifier',
              }
            }
            const clipped = clipAssetText(entry.content)
            out.preset = {
              id: preset.identifier,
              name: preset.name,
              mode: 'content',
              identifier: entry.identifier,
              entryName: entry.name,
              enabled: entry.enabled,
              role: entry.role,
              marker: entry.marker,
              markerId: entry.markerId ?? null,
              truncated: clipped.truncated,
              tokens: clipped.tokens,
              content: clipped.text,
            }
          }
        }

        if (pathArg?.trim()) {
          const resolvedPath = resolveReadableAssetPath(pathArg)
          if (!resolvedPath.ok) return { ok: false, error: resolvedPath.error }
          const body = await resolved.ws.fs.readText(resolvedPath.path)
          if (body === null) return { ok: false, error: `not-found：${resolvedPath.path}` }
          const clipped = clipAssetText(body)
          out.file = {
            path: resolvedPath.path,
            truncated: clipped.truncated,
            tokens: clipped.tokens,
            content: clipped.text,
          }
        }

        return out as unknown as JsonValue
      },
    }),
  )
}
