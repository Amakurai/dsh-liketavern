/**
 * 记忆异步压缩：memory_write 超容量时只标记（state.requestMemoryCompress），
 * turn 结束后经 agent.runMaintenance 用当前会话模型把最旧一批记忆合并为一条。
 *
 * 语义约定：maintenance 在楼层之外运行，WorkspaceFs 的 floor 为 null →
 * 压缩写入不记 WAL、不随楼层回滚（压缩是无损整理，不增删剧情事实；
 * 记忆条目本身的写入仍在 turn 内、照常回滚）。
 * 同步压缩曾阻塞该 step 的 LLM 流式调用数秒，挪到 idle 期后写工具立即返回。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateTokens } from '../core/tokenize.js'
import { rebuildIndex } from '../state/workspace.js'
import type { TavernState } from './state.js'

/** 用指定模型把一批旧记忆压缩合并为一条；失败返回 null。 */
export async function compressMemoryBatch(
  llm: LlmRuntime,
  provider: string,
  model: string,
  bodies: string[],
): Promise<string | null> {
  try {
    const prompt = bodies.map((b, i) => `【记忆 ${i + 1}】\n${b}`).join('\n\n')
    const message = createUserMessage({
      content: [{ type: 'text', text: `请将以下多条角色扮演记忆合并为一条简洁、不丢失关键事实的记忆（中文，200 字以内），只输出合并后的正文：\n\n${prompt}` }],
      source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '记忆压缩' },
    })
    let out = ''
    for await (const chunk of llm.stream({ provider, model, messages: [message], maxTokens: 1024, temperature: 0.3 })) {
      if (chunk.type === 'text-delta') out += chunk.text
    }
    const merged = out.trim()
    return merged || null
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
): Promise<{ merged: string; archived: number } | null> {
  if (!llm || !provider || !model) return null
  const ws = await state.workspace(cardId)
  const batch = await ws.memory.oldest(state.config.memory.compressBatch)
  if (batch.length === 0) return null
  const merged = await compressMemoryBatch(llm, provider, model, batch.map((b) => b.body))
  if (merged === null) return null
  // 顺序必须是先落合并条目再归档：若先 archive，write/rebuildIndex 抛错会让整批
  // 记忆从活跃库消失而合并条目没落盘（丢事实，且 registerMemoryMaintenance 清标记后
  // 永不重试）。反过来 write 失败时批次原样保留、下次压缩原样重试；archive 中途失败的
  // 最坏结果只是新（合并条目）旧（未移走的批次残余）并存——下次压缩把残余再合并一次，
  // 有冗余但不丢事实。
  await ws.memory.write({
    body: merged,
    tags: [...new Set(['compressed', ...batch.flatMap((entry) => entry.tags)])],
    keys: [...new Set(batch.flatMap((entry) => entry.keys))],
    sourceRange: `compress:${batch.map((b) => b.id).join(',')}`,
  })
  await ws.memory.archive(batch.map((b) => b.id))
  await rebuildIndex(ws.fs, estimateTokens)
  return { merged, archived: batch.length }
}

/**
 * agent 面注册：turn 结束（status → idle）且本会话工作区有压缩标记时，runMaintenance 执行压缩。
 * runMaintenance 在 turn-driving 时会同步 throw（与本事件的 idle 之间存在输入竞态）——
 * 任务未执行则保留标记待下次 idle；执行过（无论成败）即清除，下一轮超容量写入会再标记。
 */
export function registerMemoryMaintenance(ctx: Context, state: TavernState, llm: LlmRuntime | undefined): void {
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // 排在 turn/end 的 commitFloor 后执行；若新 turn 已进入队列，也会等维护退出后再 beginFloor。
    void state.enqueueSessionTask(agent.id, async () => {
      const binding = await state.loadBinding(agent.id)
      if (!binding || !state.pendingMemoryCompress.has(binding.cardId)) return
      let ran = false
      try {
        await agent.runMaintenance(async () => {
          ran = true
          const result = await compressOldestMemories(state, llm, binding.cardId, agent.options.provider, agent.options.model)
          if (result) ctx.logger.info(`dsh-tavern: 记忆压缩完成（${binding.cardId}，归档 ${result.archived} 条）`)
        })
        state.pendingMemoryCompress.delete(binding.cardId)
      } catch (error) {
        if (ran) state.pendingMemoryCompress.delete(binding.cardId)
        ctx.logger.warn(`dsh-tavern: 记忆压缩失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }).catch((error) => ctx.logger.warn(`dsh-tavern: 记忆维护调度失败：${String(error)}`))
  })
}
