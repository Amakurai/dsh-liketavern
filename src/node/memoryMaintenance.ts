import type {} from './messageSources.js'
/**
 * 记忆的空闲维护，两件事共用一次 agent.runMaintenance，每次空闲只做其中一件：
 * - 异步压缩：memory_write 超容量时只标记（state.pendingMemoryCompress），
 *   turn 结束后用当前会话模型把最旧一批记忆合并为一条。
 * - 检索别名：没有待压缩的批次时，为还没有别名的记忆请模型补上（见 core/memoryAliases.ts）。
 *   别名是派生数据，写进 memory/aliases.json，不改记忆文件；失败不留痕迹，下一个结束的轮次再试。
 *
 * 语义约定：maintenance 在楼层之外运行，写入走 state.plainWorkspace 的
 * floor=null 文件面，压缩本身不记 WAL；原文归档并保留来源链。
 * 源记忆回滚时先展开相关摘要再撤销原文，避免摘要残留已撤销事实。即使同卡的
 * 另一会话正在生成中（其楼层由 withFloor 派生实例持有），这里也绝不会被记进 WAL。
 * 同步压缩曾阻塞该 step 的 LLM 流式调用数秒，挪到 idle 期后写工具立即返回。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ALIAS_BATCH, buildAliasPrompt, parseAliasReply } from '../core/memoryAliases.js'
import { estimateTokens } from '../core/tokenize.js'
import { rebuildIndex } from '../state/workspace.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { collectCompleteText } from './collectText.js'
import { sessionModelRoute } from './modelRoute.js'
import type { TavernState } from './state.js'

/** 用指定模型把一批旧记忆压缩合并为一条；失败返回 null。 */
export async function compressMemoryBatch(
  llm: LlmRuntime,
  provider: string,
  model: string,
  bodies: string[],
  maintenanceSignal?: AbortSignal,
): Promise<string | null> {
  try {
    if (maintenanceSignal?.aborted) return null
    const prompt = bodies.map((b, i) => `【记忆 ${i + 1}】\n${b}`).join('\n\n')
    const message = createUserMessage({
      content: [{ type: 'text', text: `请将以下多条角色扮演记忆合并为一条简洁、不丢失关键事实的记忆（中文，200 字以内），只输出合并后的正文：\n\n${prompt}` }],
      source: { kind: 'dsh-tavern', form: 'notice', summary: '记忆压缩' },
    })
    const timeout = AbortSignal.timeout(60_000)
    const signal = maintenanceSignal ? AbortSignal.any([maintenanceSignal, timeout]) : timeout
    return await collectCompleteText(llm.stream({ provider, model, messages: [message], maxTokens: 1024, temperature: 0.3, signal }), signal)
  } catch {
    return null
  }
}

/**
 * 压缩指定角色工作区最旧的一批记忆（compressBatch 条）为一条。
 * 无模型 / 空批次 / 合并失败返回 null；成功返回合并正文与归档条数。
 */
export async function compressOldestMemories(
  state: TavernState,
  llm: LlmRuntime | undefined,
  cardId: string,
  provider: string | undefined,
  model: string | undefined,
  storyId?: string,
  maintenanceSignal?: AbortSignal,
): Promise<{ merged: string; archived: number } | null> {
  if (!llm || !provider || !model || maintenanceSignal?.aborted) return null
  // idle 压缩是楼层之外的有来源摘要：plainWorkspace 的 floor 恒为 null，不记 WAL、不回滚。
  const ws = await state.plainWorkspace(cardId, storyId)
  const batch = await ws.memory.oldest(state.config.memory.compressBatch)
  if (batch.length === 0) return null
  const merged = await compressMemoryBatch(llm, provider, model, batch.map((b) => b.body), maintenanceSignal)
  if (merged === null || maintenanceSignal?.aborted) return null
  // 顺序必须是先落合并条目再归档：若先 archive，write/rebuildIndex 抛错会让整批
  // 记忆从活跃库消失而合并条目没落盘（丢事实，且 registerMemoryMaintenance 清标记后
  // 永不重试）。反过来 write 失败时批次原样保留、下次压缩原样重试；archive 中途失败的
  // 最坏结果只是新（合并条目）旧（未移走的批次残余）并存——下次压缩把残余再合并一次，
  // 有冗余但不丢事实。
  return withWorkspaceLock(ws.fs.root, async () => {
    // 等待剧情锁期间仍可取消；开始写入后完成整批提交，不在归档中途截断事务。
    if (maintenanceSignal?.aborted) return null
    const archived = await ws.memory.mergeBatch(batch, merged, 'compress')
    if (archived === 0) return null
    await rebuildIndex(ws.fs, estimateTokens)
    return { merged, archived }
  })
}

/**
 * 请模型为一批记忆写检索别名；返回与输入等长的数组（没有对应行的位置为 null）。
 * 只接受正常 stop 终止帧：超时、截断、取消、出错都返回 null，调用方不保存任何东西。
 */
export async function requestMemoryAliases(
  llm: LlmRuntime,
  provider: string,
  model: string,
  bodies: string[],
  maintenanceSignal?: AbortSignal,
): Promise<Array<string[] | null> | null> {
  try {
    if (maintenanceSignal?.aborted) return null
    const message = createUserMessage({
      content: [{ type: 'text', text: buildAliasPrompt(bodies) }],
      source: { kind: 'dsh-tavern', form: 'notice', summary: '记忆检索别名' },
    })
    const timeout = AbortSignal.timeout(60_000)
    const signal = maintenanceSignal ? AbortSignal.any([maintenanceSignal, timeout]) : timeout
    const text = await collectCompleteText(llm.stream({ provider, model, messages: [message], maxTokens: 2048, temperature: 0.3, signal }), signal)
    return parseAliasReply(text, bodies)
  } catch {
    return null
  }
}

/**
 * 为最新的一批还没有别名的记忆生成并保存别名。
 * 无模型、取消或请求失败返回 null（什么都不保存，以后重试）；成功返回保存的条数与其中拿到别名的条数。
 * 正常结束的回复里没有对应行的记忆记为空列表：不为同一段正文反复请求。
 */
export async function expandMemoryAliases(
  state: TavernState,
  llm: LlmRuntime | undefined,
  cardId: string,
  provider: string | undefined,
  model: string | undefined,
  storyId?: string,
  maintenanceSignal?: AbortSignal,
): Promise<{ saved: number; named: number } | null> {
  if (!llm || !provider || !model || maintenanceSignal?.aborted) return null
  // 与压缩一样在楼层之外运行：别名文件不记 WAL，不随楼层回退。
  const ws = await state.plainWorkspace(cardId, storyId)
  const batch = await ws.memory.aliasCandidates(ALIAS_BATCH)
  if (batch.length === 0) return { saved: 0, named: 0 }
  const parsed = await requestMemoryAliases(llm, provider, model, batch.map((entry) => entry.body), maintenanceSignal)
  if (parsed === null || maintenanceSignal?.aborted) return null
  const items = batch.map((entry, index) => ({ entry, aliases: parsed[index] ?? [] }))
  const saved = await ws.memory.saveAliases(items)
  return { saved, named: items.filter((item) => item.aliases.length > 0).length }
}

/**
 * agent 面注册：turn 结束（status → idle）且本会话工作区有压缩标记、或有记忆还没有检索别名时，runMaintenance 执行维护。
 * runMaintenance 在 turn-driving 时会同步 throw（与本事件的 idle 之间存在输入竞态）——
 * 任务未执行则保留标记待下次 idle；失败保留 pending，但每个已结束轮次只尝试一次。
 */
export function registerMemoryMaintenance(ctx: Context, state: TavernState, llm: LlmRuntime | undefined): void {
  const attempted = new Map<string, string>()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // 排在 turn/end 的 commitFloor 后执行；若新 turn 已进入队列，也会等维护退出后再 beginFloor。
    void state.enqueueSessionTask(agent.id, async () => {
      const binding = await state.loadBinding(agent.id)
      if (!binding) return
      const key = binding.storyId ?? binding.cardId
      const memory = (await state.storyWorkspace(binding.cardId, binding.storyId)).memory
      // pending 是可重建状态：重启后也能从实际容量找回尚未完成的压缩。
      if (!state.pendingMemoryCompress.has(key)) {
        const stats = await memory.stats()
        if (stats.count > state.config.memory.maxEntries || stats.tokens > state.config.memory.maxTokens) state.pendingMemoryCompress.add(key)
      }
      const compress = state.pendingMemoryCompress.has(key)
      // 每次空闲只发一次辅助请求。压缩优先：它会改写活跃记忆，别名等下一次空闲再补。
      const aliases = !compress && llm !== undefined && state.config.memory.aliasExpansion && (await memory.aliasCandidates(1)).length > 0
      if (!compress && !aliases) return
      const events = agent.session.snapshotEvents()
      let closedTurn = 0
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!
        if (event.type === 'turn/end') { closedTurn = event.data.turn; break }
      }
      const marker = `${agent.id}#t${closedTurn}`
      if (attempted.get(key) === marker) return
      attempted.set(key, marker)
      let ran = false
      try {
        await agent.runMaintenance(async (signal) => {
          ran = true
          // agent.options 是创建时的全局默认模型，会话内换模后可能已不可用；按会话实际路由压缩。
          const route = sessionModelRoute(agent)
          if (!compress) {
            const expanded = await expandMemoryAliases(state, llm, binding.cardId, route.provider, route.model, binding.storyId, signal)
            if (!expanded) ctx.logger.warn('dsh-tavern: 记忆检索别名未生成；后续轮次再试')
            else if (expanded.saved > 0 && expanded.named === 0) ctx.logger.warn('dsh-tavern: 模型回复里没有可用的检索别名，这批记忆不再重复请求')
            else if (expanded.saved > 0) ctx.logger.info(`dsh-tavern: 已为 ${expanded.named} 条记忆补充检索别名（${binding.cardId}）`)
            return
          }
          // 宿主取消维护必须取消这次辅助流；不能等待迟到的 stop 后继续归档原文。
          const result = await compressOldestMemories(state, llm, binding.cardId, route.provider, route.model, binding.storyId, signal)
          if (result) state.pendingMemoryCompress.delete(binding.storyId ?? binding.cardId)
          if (!result) ctx.logger.warn('dsh-tavern: 记忆压缩未完成，原文与待处理标记已保留；后续轮次再试')
          if (result) ctx.logger.info(`dsh-tavern: 记忆压缩完成（${binding.cardId}，归档 ${result.archived} 条）`)
        })
      } catch (error) {
        if (!ran) attempted.delete(key)
        ctx.logger.warn(`dsh-tavern: 记忆维护失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }).catch((error) => ctx.logger.warn(`dsh-tavern: 记忆维护调度失败：${String(error)}`))
  })
}
