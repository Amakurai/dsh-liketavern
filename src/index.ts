/**
 * dsh-liketavern host 入口。
 * 职责：注册设置命名空间、初始化数据目录、安装 agent 预设、提供 tavern 服务、
 * 注册 typert remote 描述符、维护楼层 WAL 与每 turn 缓存（session/event 监听）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-typert-registry'
import { TAVERN_NS, TavernConfigSchema, resolveConfig } from './node/config.js'
import { ensureGreeting, retireGreetingOnlyBlankSession } from './node/floors.js'
import { tavernPaths } from './node/paths.js'
import { installTavernPreset } from './node/presetInstall.js'
import { createTavernService } from './node/service.js'
import { recordRequestDiagnostics, registerRequestDiagnostics } from './node/requestDiagnostics.js'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER, registerPresetAdapter } from './node/presetAdapter.js'
import { createPresetRequestProjector } from './node/presetRequestProjection.js'
import { onTurnStart, onTurnEnd } from './node/sessionLifecycle.js'
import { registerHelperMvuLifecycle, reserveHelperMvuMaintenance } from './node/helperMvuLifecycle.js'
import { TavernState } from './node/state.js'
import { isTavernRuntimeSession } from './node/tavernSession.js'
import { TYPERT_HOST } from './remote.js'

export const name = 'dsh-liketavern'
export const inject = ['settings', 'sessions', 'agents', 'typert', 'workspaceRegistry', 'agentPresets']

/** 从消息内容块中提取纯文本（非 text 块忽略）。 */
function messageText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
}

export async function apply(ctx: Context): Promise<void> {
  const scope = ctx.settings.register(TAVERN_NS, TavernConfigSchema, { applies: 'live' })
  const state = new TavernState(tavernPaths(), () => resolveConfig(scope.get()))
  await state.init()

  try {
    const result = await installTavernPreset()
    if (result.written.length > 0) ctx.logger.info(`dsh-tavern: agent 预设已安装（${result.written.join(', ')}）`)
  } catch (error) {
    ctx.logger.warn(`dsh-tavern: agent 预设安装失败：${error instanceof Error ? error.message : String(error)}`)
  }

  createTavernService(ctx, state, scope)
  registerRequestDiagnostics(ctx, state)
  state.presetAdapter = registerPresetAdapter(ctx, (options, model) => {
    // 摘要、标题和明确的独立代答没有普通聊天布局；仍复用相同官方传输。
    if (options.purpose || !options.sessionId) return options
    const session = ctx.sessions.get(options.sessionId)
    if (session && !isTavernRuntimeSession(ctx,session)) return options
    const notes = new Set<string>()
    const projector = createPresetRequestProjector(ctx,{onDiagnostic:diagnostic => {
      if (diagnostic.kind === 'text-budget') {
        if (notes.size >= 128) notes.delete(notes.values().next().value!)
        const window = diagnostic.contextWindow === undefined ? '模型窗口未知'
          : `模型窗口 ${diagnostic.contextWindow}，输出预留 ${diagnostic.reservedOutputTokens}，可用 ${diagnostic.availableTextTokens}`
        notes.add(`文本估算：投影前≈${diagnostic.beforeTextTokens} tokens，投影后≈${diagnostic.afterTextTokens} tokens；${window}。不含图片、工具编码和供应商消息封装。`
          + (diagnostic.exceedsAvailable ? '估算已超过可用窗口，可能请求失败；请缩短预设、减少深度 system 或清理历史。' : ''))
      } else if (notes.size < 128) notes.add(diagnostic.kind === 'compaction-clamp'
        ? `历史消息 ${diagnostic.messageId} 已压缩，提示词位置映射至摘要 ${diagnostic.summaryMessageId} 的边界。`
        : '当前模型仅支持首条 system；系统角色预设合入首条完整提示，user/assistant 角色仍按布局插入。')
    }})
    const projected = projector.project(options, model)
    recordRequestDiagnostics(state, options.sessionId, projected, 'tavern-adapter',[...notes])
    return projected
  })
  const preparePresetAdapter = () => {
    const providers = ctx.get('llm')?.listProviders() ?? []
    if (providers.some(provider => provider.id === PRESET_ADAPTER_PROVIDER)
      || !providers.some(provider => provider.id === PRESET_ADAPTER_SOURCE_PROVIDER)) return
    try { state.presetAdapter!.ensureRegistered() }
    catch (error) { ctx.logger.warn(`dsh-tavern: DeepSeek 布局通道尚未就绪：${String(error)}`) }
  }
  preparePresetAdapter()
  ctx.on('llm/adapters-updated', preparePresetAdapter)
  registerHelperMvuLifecycle(ctx)
  ctx.effect(() => ctx.typert.register(TYPERT_HOST as never), 'dsh-tavern.typert')

  const retireStuckBlank = (session: Session) => {
    try {
      if (!isTavernRuntimeSession(ctx, session)) return
      if (retireGreetingOnlyBlankSession(session, ctx)) {
        ctx.logger.info(`dsh-tavern: 已解除被开场白写脏的空白会话 ${session.id}`)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-tavern: 解除写脏空白会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const session of ctx.sessions.list()) retireStuckBlank(session)
  ctx.on('session/created', retireStuckBlank)

  // 楼层 WAL 与每 turn 检索缓存：只碰 Tavern 模式会话，普通 dsh 助手不受影响。
  ctx.on('session/event', (session: Session, event) => {
    if (!isTavernRuntimeSession(ctx, session)) return
    if (event.type === 'turn/start') {
      const { turn } = event.data as { turn: number }
      void state
        .enqueueSessionTask(session.id, () => onTurnStart(state, session.id, turn, session))
        .catch((error) => ctx.logger.warn(`dsh-tavern: beginFloor 失败：${String(error)}`))
    } else if (event.type === 'step/start') {
      const { step } = event.data as { step: number }
      if (state.currentTurns.has(session.id)) state.currentSteps.set(session.id, step)
    } else if (event.type === 'turn/end') {
      // 事件队列可能晚于下一轮开始才执行；必须携带这一刻的不可变日志快照。
      const events = session.snapshotEvents()
      const closedSession = { id: session.id, snapshotEvents: () => events }
      void state
        .enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, closedSession))
        .catch((error) => ctx.logger.warn(`dsh-tavern: commitFloor 失败：${String(error)}`))
    }
  })

  // 提前捕获尚未入日志的用户输入（供 WI 当轮扫描）。
  // 同时在第一条真正发出时才写入开场白，避免空白会话被写脏后无法换模式 / 无法新对话。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const session = ctx.sessions.get(agent.id)
    if (!session || !isTavernRuntimeSession(ctx, session)) return
    const text = messageText(message.content)
    const hasImage = message.content.some(block => block.type === 'image')
    if ((text.trim() || hasImage) && !state.pendingTemplateInputs.get(agent.id)?.some(input => input.id === message.id)) {
      const list = state.pendingInputs.get(agent.id) ?? []
      list.push(text)
      state.pendingInputs.set(agent.id, list)
      const templateInputs=state.pendingTemplateInputs.get(agent.id) ?? []
      templateInputs.push({id:message.id,text,...(hasImage ? {hasImage:true} : {}),chat:message.source.kind === 'user'})
      state.pendingTemplateInputs.set(agent.id,templateInputs)
    }
    void state
      .enqueueSessionTask(agent.id, () => ensureGreeting({ ctx, state }, agent.id))
      .catch((error) => ctx.logger.warn(`dsh-tavern: 写入开场白失败：${String(error)}`))
    reserveHelperMvuMaintenance(state, agent, error => ctx.logger.warn(`dsh-tavern: MVU 等待已结束，待处理任务与输入保留：${String(error)}`))
  })
}
