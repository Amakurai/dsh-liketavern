/**
 * 楼层操作：重新生成 / 回退 / 编辑用户消息 / 编辑 assistant 正文 / 续写 / 开场白 swipe。
 *
 * dsh 会话日志不可删除，修改历史通过「fork 前缀 + WAL 回滚 + 子会话续跑」实现：
 * 原会话保持不变，结果落在一个新的子会话上（README 限制项有说明）。
 * 子会话必须走 agents.create + workspace.attachSession（与官方 session.fork 相同），
 * 并带上父会话的 provider/model（agentOptions），否则子会话立刻 followup 时
 * `deployment:persona` 的 `{{model}}` 没有值，本轮会直接失败。
 * 开场白要预先编进 seed。禁止 ctx.sessions.fork / tavern- 前缀，禁止 create 后再 append 开场白。
 * WAL 楼层命名：`${sessionId}#t${turn}`（由 host 入口在 turn/start 时 beginFloor）；
 * 子绑定额外记录继承的祖先 session/turn 边界，跨 fork 回滚时合并这些楼层。
 * 例外：编辑 assistant 正文只换 seed 里的该条消息、不续跑；续写（continueFloor）不改历史，
 * 不 fork，直接 followup 一条合成指令（不当用户台词）。
 * 每个产生分支的操作都返回建议标题，客户端用 dsh 会话 rename 写进会话列表。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createAssistantMessage, createUserMessage, type AssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { Wal } from '../state/wal.js'
import { copyTemplateTimers } from '../state/template.js'
import { estimateTokens } from '../core/tokenize.js'
import { rebuildIndex } from '../state/workspace.js'
import { greetingFloorState, isGreetingOnlyBlank, pickGreetingText, sessionHasUserMessage, TAVERN_GREETING_SOURCE } from '../core/greetingLog.js'
import { expandMacros } from '../core/macros.js'
import { CONTINUE_INSTRUCTION_PREFIX } from '../core/dshPrompt.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { greetingMessage, greetingTurnEvents } from './greetingSeed.js'
import { isTavernRuntimeSession, sessionPresetId } from './tavernSession.js'
import { pruneSiblingForks, siblingSwipe, type SiblingSwipe } from '../core/siblings.js'
import { appendSiblingFork, loadSiblingForks, mutateSiblingForks } from '../state/siblings.js'
import { loadBinding, type SessionBinding, type WalLineageEntry } from './bindings.js'
import type { TavernState } from './state.js'

export interface FloorDeps {
  ctx: Context
  state: TavernState
}

export class FloorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 与平台 session.create / session.fork 相同的 id 形态，客户端按此前缀认会话。 */
function newChildId(): string {
  return `session-${randomUUID()}`
}

/** 工作区注册表（避免把 dsh-workspace 加进运行时依赖，按结构调用）。 */
interface WorkspaceAttachable {
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  detachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): WorkspaceAttachable[]
}

function agentPresetsOf(ctx: Context): AgentPresets {
  const presets = ctx.get('agentPresets') as AgentPresets | undefined
  if (!presets) throw new FloorError('no-presets', '当前运行时没有 agent 预设服务，无法创建分支会话')
  return presets
}

function presentRoute(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 子会话的模型路由：官方 session.fork 会传入 agentOptions + 安装 model selection。
 * 本插件在 create 后立刻 followup，来不及等 UI 再装 selection，必须在 create 时写上
 * provider/model，否则 system-prompt 插值 `{{model}}` 会抛「has no value」。
 *
 * 优先会话最新 request/header（用户中途换模也跟得上），其次父 agent.options，
 * 再次最近一条非开场白 assistant 的 source。
 */
export function forkAgentOptions(parent: Pick<Agent, 'options'> | undefined, source: Session): AgentOptions {
  const out: AgentOptions = { ...(parent?.options ?? {}) }
  const logged = source.requestHeader()?.config
  if (presentRoute(logged?.provider)) out.provider = logged.provider
  if (presentRoute(logged?.model)) out.model = logged.model
  if (typeof logged?.maxTokens === 'number' && Number.isFinite(logged.maxTokens) && logged.maxTokens > 0) {
    out.maxTokens = logged.maxTokens
  }
  if (!presentRoute(out.provider) || !presentRoute(out.model)) {
    const events = source.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event.type !== 'assistant/message') continue
      const src = (event.data as { message?: { source?: { provider?: string; model?: string } } }).message?.source
      if (!presentRoute(src?.provider) || !presentRoute(src.model)) continue
      if (src.provider === TAVERN_GREETING_SOURCE.provider && src.model === TAVERN_GREETING_SOURCE.model) continue
      if (!presentRoute(out.provider)) out.provider = src.provider
      if (!presentRoute(out.model)) out.model = src.model
      break
    }
  }
  return out
}

function agentOptionsForCreate(options: AgentOptions): AgentOptions | undefined {
  if (!presentRoute(options.provider) && !presentRoute(options.model) && options.maxTokens === undefined) return undefined
  return options
}

function liveSession(ctx: Context, sessionId: string): Session | undefined {
  return ctx.sessions.get(sessionId as Session['id'])
}

/** 楼层写入只允许 Tavern 会话，避免陈旧绑定文件改到普通 dsh 助手上。 */
function requireTavernSession(ctx: Context, session: Session): void {
  if (!isTavernRuntimeSession(ctx, session)) {
    throw new FloorError('not-tavern', '当前会话不是 Tavern 模式')
  }
}

/** 切到 boundaryInclusive（含）为止的前缀；-1 / 空日志得到空数组（重跑第一层时 turn/start 在 seq 0）。 */
export function sessionPrefixEvents(events: readonly SessionEvent[], boundaryInclusive?: number): SessionEvent[] {
  const cut = boundaryInclusive === undefined ? events.length : Math.max(0, boundaryInclusive + 1)
  return events.slice(0, cut) as SessionEvent[]
}

/**
 * 按官方 session.fork 的路径建子会话：agents.create（seed 里带完整前缀 / cwd / agentPreset）后
 * workspace.attachSession。不要用 ctx.sessions.fork——那样没有 agent、也不挂工作区。
 * setup 走 mount（与官方 fork 相同），不要 composeFrom（那是 subagent 路径）。
 * 开场白必须预先编进 seed，禁止 create 之后再 append。
 */
async function forkChildSession(ctx: Context, source: Session, seed: readonly SessionEvent[], childId = newChildId()): Promise<{ childId: string; handle: { dispose(): Promise<void> } }> {
  const presets = agentPresetsOf(ctx)
  const parent = ctx.agents.get(source.id)
  const named = (parent ? presets.composedPreset(parent.ctx) : undefined) ?? sessionPresetId(ctx, source) ?? 'tavern'
  let resolvedId = named
  try {
    resolvedId = (await presets.resolve(named)).id
  } catch {
    resolvedId = named
  }
  // 与官方 SessionStore.fork 相同的元数据形态：meta.isSeeded + 顶层 inheritedEventCount
  // （0.1.2 起 header 不再带 seedLength，继承前缀长度是 Session 状态而不是普通 header 元数据）。
  const meta = {
    ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
    parentSession: source.id,
    isSeeded: true,
    agentPreset: resolvedId,
  }
  const copied = agentOptionsForCreate(forkAgentOptions(parent, source))
  const options: CreateAgentOptions = {
    sessionId: childId as Session['id'],
    ...(seed.length > 0 ? { seed } : {}),
    inheritedEventCount: SessionLogOffset(seed.length),
    meta,
    ...(copied ? { agentOptions: copied } : {}),
    setup: async (agentCtx: Context) => {
      await presets.mount(agentCtx, resolvedId)
    },
  }
  let handle: { dispose(): Promise<void> }
  try {
    handle = await ctx.agents.withoutInitiator(() => ctx.agents.create(options))
  } catch (error) {
    throw new FloorError('fork-failed', `创建分支会话失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  const workspace = registry?.list().find((item) => item.sessionIds.includes(source.id))
  if (workspace) {
    try {
      await workspace.attachSession(childId)
    } catch (error) {
      await handle.dispose().catch(() => {})
      throw new FloorError(
        'workspace-attach-failed',
        `分支会话已创建，但未能挂到工作区：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 调用方只在「分支尚未绑定完成」的清理路径上使用 handle；正常路径不 dispose，子会话保持注册运行。
  // ctx.agents.get(id) 只返回裸 Agent，没有 dispose 能力，所以失败清理必须拿到这份 handle。
  return { childId, handle }
}

/** 会话事件里 turn N 的 turn/start 的 seq；不存在返回 null。 */
function turnStartSeq(events: readonly SessionEvent[], turn: number): number | null {
  const hit = events.find((e) => e.type === 'turn/start' && (e.data as { turn: number }).turn === turn)
  return hit ? hit.seq : null
}

/** 会话事件里 turn N 的 turn/end 的 seq；不存在返回 null。 */
function turnEndSeq(events: readonly SessionEvent[], turn: number): number | null {
  const hit = events.find((e) => e.type === 'turn/end' && (e.data as { turn: number }).turn === turn)
  return hit ? hit.seq : null
}

/** assistant 消息 id → 所属 turn；不存在返回 null。 */
function turnOfAssistantMessage(events: readonly SessionEvent[], messageId: string): number | null {
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const data = e.data as { turn: number; message?: { id?: string } }
    if (data.message?.id === messageId) return data.turn
  }
  return null
}

/**
 * 楼层定位：messageId（assistant 消息 id）优先，其次直接按 turn 号。
 * 被中断的 assistant 消息不进宿主的 assistant-actions slot（非 finalized），
 * 中断楼层的操作条由 chat.node 渲染侧按 turn 号定位补挂。
 */
export function resolveFloorTurn(events: readonly SessionEvent[], messageId?: string, turn?: number): number | null {
  if (messageId !== undefined) return turnOfAssistantMessage(events, messageId)
  if (turn === undefined || !Number.isSafeInteger(turn) || turn < 1) return null
  return events.some((e) => e.type === 'turn/start' && (e.data as { turn: number }).turn === turn) ? turn : null
}

/** 用户消息的纯文本（多段 text 拼接）。 */
function userMessageText(message: UserMessage): string {
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** 最大已关闭 turn 号；最后一个 turn 未关闭（进行中）返回 null 并给出 openTurn。 */
function closedTurns(events: readonly SessionEvent[]): { turns: number[]; openTurn: number | null } {
  const started = new Set<number>()
  const closed = new Set<number>()
  for (const e of events) {
    if (e.type === 'turn/start') started.add((e.data as { turn: number }).turn)
    if (e.type === 'turn/end') closed.add((e.data as { turn: number }).turn)
  }
  const open = [...started].filter((t) => !closed.has(t))
  return { turns: [...closed].sort((a, b) => a - b), openTurn: open.length > 0 ? Math.max(...open) : null }
}

/** turn N 内的第一条用户消息（followup 重发用）。 */
function firstUserMessageOf(events: readonly SessionEvent[], turn: number): UserMessage | null {
  let inTurn = false
  for (const e of events) {
    if (e.type === 'turn/start') inTurn = (e.data as { turn: number }).turn === turn
    else if (e.type === 'turn/end' && (e.data as { turn: number }).turn === turn) inTurn = false
    else if (inTurn && e.type === 'user/message') return e.data as UserMessage
  }
  return null
}

/**
 * 取指定会话 turn >= fromTurn 的 WAL 楼层。
 *
 * Wal.rollbackAfter 会在内部按数组逆序回放，因此这里必须按 turn 数字升序传入；
 * 不能先 reverse，也不能使用字符串排序（t10 会排在 t2 前面）。
 */
export function floorNamesForRollback(
  floors: readonly string[],
  sessionId: string,
  fromTurn: number,
  throughTurn = Number.POSITIVE_INFINITY,
): string[] {
  const prefix = `${sessionId}#t`
  return floors
    .map((floor) => ({ floor, suffix: floor.startsWith(prefix) ? floor.slice(prefix.length) : '' }))
    .filter((item) => /^\d+$/.test(item.suffix))
    .map((item) => ({ floor: item.floor, turn: Number.parseInt(item.suffix, 10) }))
    .filter((item) => Number.isSafeInteger(item.turn) && item.turn >= fromTurn && item.turn <= throughTurn)
    .sort((a, b) => a.turn - b.turn)
    .map((item) => item.floor)
}

/**
 * 当前会话与 fork 祖先中属于本分支的 WAL 楼层，按 turn 升序交给 rollbackAfter。
 * 同 turn 时祖先在前、当前会话在后，逆放时仍是较新的分支写入先撤销。
 */
export function floorNamesForLineageRollback(
  floors: readonly string[],
  binding: Pick<SessionBinding, 'walLineage'>,
  sessionId: string,
  fromTurn: number,
): string[] {
  const lineage = (binding.walLineage ?? []).filter(
    (entry): entry is WalLineageEntry =>
      typeof entry.sessionId === 'string' && Number.isSafeInteger(entry.throughTurn) && entry.throughTurn >= 0,
  )
  const owners = [...lineage, { sessionId, throughTurn: Number.POSITIVE_INFINITY }]
  const selected = owners.flatMap((owner, ownerIndex) =>
    floorNamesForRollback(floors, owner.sessionId, fromTurn, owner.throughTurn).map((floor) => {
      const turn = Number.parseInt(floor.slice(`${owner.sessionId}#t`.length), 10)
      return { floor, turn, ownerIndex }
    }),
  )
  return [...new Map(selected.map((item) => [item.floor, item])).values()]
    .sort((a, b) => a.turn - b.turn || a.ownerIndex - b.ownerIndex)
    .map((item) => item.floor)
}

/** 回退边界属于哪个会话；walLineage 按根祖先 → 直接父会话排列。 */
export function timerOwnerAtTurn(
  binding: Pick<SessionBinding, 'walLineage'>,
  currentSessionId: string,
  boundaryTurn: number,
): string {
  for (const entry of binding.walLineage ?? []) {
    if (Number.isSafeInteger(entry.throughTurn) && boundaryTurn <= entry.throughTurn) return entry.sessionId
  }
  return currentSessionId
}

/**
 * 子会话的 WAL 世系：在祖先条目后追加源会话边界。
 * 保留的祖先条目必须 clamp 到新 seed 实际继承的边界——回退 fork 只继承 throughTurn
 * 之前的楼层，不 clamp 会让 timerOwnerAtTurn 用陈旧边界命中未继承的祖先定时器。
 * throughTurn === null（空 seed，未继承任何楼层）时祖先内容同样未继承，整条世系丢弃。
 */
export function childWalLineage(
  binding: Pick<SessionBinding, 'walLineage'>,
  sourceId: string,
  throughTurn: number | null,
): WalLineageEntry[] {
  if (throughTurn === null) return []
  return [
    ...(binding.walLineage ?? [])
      .filter((entry) => entry.sessionId !== sourceId)
      .map((entry) => ({ ...entry, throughTurn: Math.min(entry.throughTurn, throughTurn) })),
    { sessionId: sourceId, throughTurn },
  ]
}

/** seed 中最大的 turn/start；空前缀表示没有继承源会话楼层。 */
export function inheritedThroughTurn(seed: readonly SessionEvent[]): number | null {
  let max: number | null = null
  for (const event of seed) {
    if (event.type !== 'turn/start') continue
    const turn = (event.data as { turn?: unknown }).turn
    if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) max = Math.max(max ?? turn, turn)
  }
  return max
}

/**
 * 兼容上一版本已经存在的分支绑定：从当前 live session 的继承前缀长度（inheritedEventCount）
 * 补回祖先边界。新 fork 会直接持久化 walLineage；这里只在旧绑定缺字段且父会话仍在线时尽力迁移。
 */
function inferLiveWalLineage(ctx: Context, source: Session, binding: SessionBinding): SessionBinding {
  if ((binding.walLineage?.length ?? 0) > 0 || !source.header.parentSession) return binding
  const reverse: WalLineageEntry[] = []
  const seen = new Set<string>()
  let child = source
  while (child.header.parentSession && !seen.has(child.header.parentSession)) {
    const parentId = child.header.parentSession
    seen.add(parentId)
    const seedLength = Number.isSafeInteger(child.inheritedEventCount) ? child.inheritedEventCount : 0
    const throughTurn = inheritedThroughTurn(child.snapshotEvents().slice(0, seedLength))
    if (throughTurn !== null) reverse.push({ sessionId: parentId, throughTurn })
    const parent = ctx.sessions.get(parentId)
    if (!parent) break
    child = parent
  }
  if (reverse.length === 0) return binding
  return { ...binding, walLineage: reverse.reverse() }
}

/** 分支操作结果：子会话 id + 建议标题（客户端经 sessions.rename 落到会话列表）。 */
export interface ForkResult {
  childSessionId: string
  /** 分支会话的可读标题，如「角色名 · 从第 3 层重生成」。 */
  title: string
}

/** 分支标题的角色名部分：优先工作区卡名（展示名永远用 card.name），退回绑定快照。 */
async function branchTitle(state: TavernState, binding: SessionBinding, action: string): Promise<string> {
  const ws = await state.loadCharacter(binding.cardId)
  const name = ws?.card.name ?? binding.cardName ?? '角色'
  return `${name} · ${action}`
}

async function forkAt(
  ctx: Context,
  state: TavernState,
  source: Session,
  binding: SessionBinding,
  boundary: number,
  options?: { prepareEdits?:(fs:import('../state/workspaceFs.js').WorkspaceFs,childId:string)=>Promise<void>; greetingIndex?: number; seedOverride?: readonly SessionEvent[]; forkTurn?: number; rollbackFromTurn?: number; verifySource?:()=>Promise<void> },
): Promise<string> {
  const seed = options?.seedOverride ?? sessionPrefixEvents(source.snapshotEvents(), boundary)
  const childId = newChildId()
  // 先在独立草稿恢复剧情；失败不会创建会话，也不会改动来源分支。
  const storyId = await state.forkStory(binding, childId, async (fs) => {
    const wal = new Wal(join(fs.root, 'state', 'wal'))
    if (options?.rollbackFromTurn !== undefined) {
      const floors = (await wal.listFloors()).filter((item) => !item.rolledBack).map((item) => item.floor)
      await wal.rollbackAfter(floorNamesForLineageRollback(floors, binding, source.id, options.rollbackFromTurn), fs.root)
    }
    const boundaryTurn = options?.rollbackFromTurn !== undefined ? options.rollbackFromTurn - 1 : inheritedThroughTurn(seed) ?? 0
    const owner = timerOwnerAtTurn(binding, source.id, boundaryTurn)
    await copyTemplateTimers(fs, owner, childId)
    await rebuildIndex(fs, estimateTokens)
    await options?.prepareEdits?.(fs,childId)
    await options?.verifySource?.()
  })
  const throughTurn = inheritedThroughTurn(seed)
  const walLineage = childWalLineage(binding, source.id, throughTurn)
  let created: { dispose(): Promise<void> } | undefined
  try {
    created = (await forkChildSession(ctx, source, seed, childId)).handle
    await state.saveBinding({
      ...binding,
      sessionId: childId,
      storyId,
      walLineage,
      ...(options?.greetingIndex !== undefined ? { greetingIndex: options.greetingIndex } : {}),
    })
  } catch (error) {
    const workspace = (ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined)
      ?.list()
      .find((item) => item.sessionIds.includes(childId))
    await workspace?.detachSession?.(childId).catch(() => {})
    // 子会话已创建但绑定未落盘：用 create 返回的 handle 停止并移除它，否则会留下一个没有 Tavern 绑定、
    // 插件无法操作的孤儿会话。
    await created?.dispose().catch(() => {})
    await state.discardUnboundStory(binding.cardId, storyId, childId)
    throw new FloorError('fork-failed', `准备分支失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 兄弟索引（‹ n/m › 导航元数据，state/siblings.ts，不记 WAL）：登记失败不拖垮分支本身。
  if (options?.forkTurn !== undefined) {
    try {
      await appendSiblingFork(state.paths.root, {
        parentSessionId: source.id,
        turn: options.forkTurn,
        childSessionId: childId,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      ctx.logger.warn(`dsh-tavern: 记录分支兄弟索引失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return childId
}

/** 子会话若已由 forkChildSession 创建则直接 followup；否则 resume。不要 dispose 刚 create 的 agent。 */
async function resumeAndDrive(ctx: Context, childId: string, message: UserMessage | null): Promise<Agent> {
  const live = ctx.agents.get(childId as Session['id'])
  if (live) {
    if (message) live.followup(message)
    return live
  }
  const handle = await ctx.agents.resume({ resumeSessionId: childId as Session['id'] })
  if (message) handle.agent.followup(message)
  void handle.agent
    .whenIdle()
    .catch(() => {})
    .finally(() => void handle.dispose().catch(() => {}))
  return handle.agent
}

/** 重新生成：回滚目标楼层并重跑。messageId（assistant 消息 id）或 floorTurn 指定楼层，都缺省取最后一个已关闭 turn。进行中的 turn 拒绝。 */
export async function regenerate({ ctx, state }: FloorDeps, sessionId: string, messageId?: string, floorTurn?: number): Promise<ForkResult> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线（仅支持当前打开的会话）`)
  requireTavernSession(ctx, source)
  const { turns, openTurn } = closedTurns(source.snapshotEvents())
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中，请等待完成后再重新生成`)
  let target: number
  if (messageId !== undefined || floorTurn !== undefined) {
    const turn = resolveFloorTurn(source.snapshotEvents(), messageId, floorTurn)
    if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
    if (!turns.includes(turn)) throw new FloorError('turn-open', `turn ${turn} 尚未完结，不能重新生成`)
    target = turn
  } else {
    const last = turns.at(-1)
    if (last === undefined) throw new FloorError('no-turns', '会话还没有可重新生成的楼层')
    target = last
  }
  const seq = turnStartSeq(source.snapshotEvents(), target)
  // seq 0 合法：turn/start 是日志第一条时，前缀为空（sessionPrefixEvents(..., -1) → []），即重跑第一层。
  if (seq === null) throw new FloorError('bad-boundary', `turn ${target} 的边界不可回退`)
  const userMessage = firstUserMessageOf(source.snapshotEvents(), target)
  if (!userMessage) throw new FloorError('no-user-message', `turn ${target} 内找不到用户消息`)

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  // fork/挂工作区/保存子绑定全部成功后才改 WAL；这些步骤失败时源工作区保持原状。
  const childId = await forkAt(ctx, state, source, binding, seq - 1, { forkTurn: target, rollbackFromTurn: target })
  // 保留原消息来源：重生成一个续写轮时驱动消息仍是插件 notice，宿主不会把续写指令当用户台词渲染，
  // 自动 MVU 的续写核对（按 source 识别）也仍能把新片段接回被截断的上一条回复。
  await resumeAndDrive(ctx, childId, createUserMessage({ content: userMessage.content, source: userMessage.source }))
  return { childSessionId: childId, title: await branchTitle(state, binding, `从第 ${target} 层重生成`) }
}

/** 回退到指定楼层：保留该楼层（含）之前的全部内容，丢弃其后的楼层；不自动续跑。messageId 与 floorTurn 至少给其一。 */
export async function rollbackToFloor({ ctx, state }: FloorDeps, sessionId: string, messageId?: string, floorTurn?: number): Promise<ForkResult> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const { openTurn } = closedTurns(source.snapshotEvents())
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中`)
  const turn = resolveFloorTurn(source.snapshotEvents(), messageId, floorTurn)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const endSeq = turnEndSeq(source.snapshotEvents(), turn)
  if (endSeq === null) throw new FloorError('turn-open', `turn ${turn} 尚未完结，不能作为回退边界`)

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const childId = await forkAt(ctx, state, source, binding, endSeq, { forkTurn: turn, rollbackFromTurn: turn + 1 })
  return { childSessionId: childId, title: await branchTitle(state, binding, `回退到第 ${turn} 层`) }
}

/** 读取指定楼层的首条用户消息（编辑对话框预填用）。 */
export async function getFloorUserMessage({ ctx }: FloorDeps, sessionId: string, messageId: string): Promise<{ turn: number; text: string }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const turn = turnOfAssistantMessage(source.snapshotEvents(), messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const userMessage = firstUserMessageOf(source.snapshotEvents(), turn)
  if (!userMessage) throw new FloorError('no-user-message', `turn ${turn} 内没有用户消息`)
  return { turn, text: userMessageText(userMessage) }
}

/** 编辑指定楼层的用户消息：回退到该楼层前并以新文本重跑。 */
export async function editUserMessage(
  deps: FloorDeps,
  sessionId: string,
  messageId: string,
  newText: string,
): Promise<ForkResult> {
  const { ctx, state } = deps
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const { openTurn } = closedTurns(source.snapshotEvents())
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中`)
  const turn = turnOfAssistantMessage(source.snapshotEvents(), messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const seq = turnStartSeq(source.snapshotEvents(), turn)
  if (seq === null) throw new FloorError('no-turn', `会话中没有 turn ${turn}`)
  if (!firstUserMessageOf(source.snapshotEvents(), turn)) throw new FloorError('no-user-message', `turn ${turn} 内没有用户消息可编辑`)
  if (!newText.trim()) throw new FloorError('empty-text', '编辑后的正文不能为空')

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const childId = await forkAt(ctx, state, source, binding, seq - 1, { forkTurn: turn, rollbackFromTurn: turn })
  await resumeAndDrive(ctx, childId, createUserMessage({ content: [{ type: 'text', text: newText }], source: { kind: 'user' } }))
  return { childSessionId: childId, title: await branchTitle(state, binding, `编辑第 ${turn} 层`) }
}

/**
 * 把 seed 里指定 assistant 消息的正文替换为编辑后文本（新消息 id，保留原模型 source）。
 * 事件本体深冻，这里浅拷一层换 data.message；找不到返回 null。
 */
export function withEditedAssistantMessage(
  events: readonly SessionEvent[],
  messageId: string,
  newText: string,
): SessionEvent[] | null {
  const index = events.findIndex(
    (e) => e.type === 'assistant/message' && (e.data as { message?: { id?: string } }).message?.id === messageId,
  )
  if (index === -1) return null
  const event = events[index]!
  const data = event.data as { turn: number; step: number; message: AssistantMessage; usage?: unknown; interrupted?: true }
  const message = createAssistantMessage({
    content: [{ type: 'text', text: newText }],
    source: { provider: data.message.source.provider, model: data.message.source.model },
  })
  // 编辑生成的是完整新正文，中断标记（宿主 rc.2 起 interrupted: true）不应带进分支 seed。
  const { interrupted: _dropped, ...rest } = data
  const replaced = { ...event, data: { ...rest, message } } as SessionEvent
  return [...events.slice(0, index), replaced, ...events.slice(index + 1)]
}

/** 读取指定楼层 assistant 消息的正文（编辑对话框预填用）。 */
export async function getFloorAssistantMessage(
  { ctx }: FloorDeps,
  sessionId: string,
  messageId: string,
): Promise<{ turn: number; text: string }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const turn = turnOfAssistantMessage(source.snapshotEvents(), messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const hit = source.snapshotEvents().find(
    (e) => e.type === 'assistant/message' && (e.data as { message?: { id?: string } }).message?.id === messageId,
  )
  const message = (hit?.data as { message?: AssistantMessage } | undefined)?.message
  if (!message) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const text = message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  return { turn, text }
}

/**
 * 编辑指定楼层的 assistant 正文：fork 到该楼层结束（seed 内替换该条消息），
 * 撤销该层及之后的派生事实，不自动续跑——编辑 AI 台词后通常由用户自己接话。
 */
export async function editAssistantMessage(
  deps: FloorDeps,
  sessionId: string,
  messageId: string,
  newText: string,
): Promise<ForkResult> {
  const { ctx, state } = deps
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const { openTurn } = closedTurns(source.snapshotEvents())
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中`)
  const turn = turnOfAssistantMessage(source.snapshotEvents(), messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const endSeq = turnEndSeq(source.snapshotEvents(), turn)
  if (endSeq === null) throw new FloorError('turn-open', `turn ${turn} 尚未完结，不能编辑`)
  if (!newText.trim()) throw new FloorError('empty-text', '编辑后的正文不能为空')

  const seed = withEditedAssistantMessage(sessionPrefixEvents(source.snapshotEvents(), endSeq), messageId, newText)
  if (!seed) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const childId = await forkAt(ctx, state, source, binding, endSeq, { seedOverride: seed, forkTurn: turn, rollbackFromTurn: turn })
  return { childSessionId: childId, title: await branchTitle(state, binding, `编辑第 ${turn} 层回复`) }
}

/**
 * 楼层继续：最后一条 assistant 回复被截断（或用户认为不完整）时，不产生新的用户台词，
 * 直接以一条合成指令（CONTINUE_INSTRUCTION_PREFIX，isSyntheticUserText 过滤）驱动画前会话续写。
 * 续写不改历史，因此不 fork、不回滚 WAL；续写轮自身是正常 turn（楼层 WAL 照常 beginFloor）。
 * 只允许续最后一个已关闭 turn 的楼层，避免在历史中间续出分叉语义。
 */
export async function continueFloor(
  { ctx, state }: FloorDeps,
  sessionId: string,
  messageId: string,
): Promise<{ continued: boolean }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线（仅支持当前打开的会话）`)
  requireTavernSession(ctx, source)
  const { turns, openTurn } = closedTurns(source.snapshotEvents())
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中，请等待完成后再续写`)
  const turn = turnOfAssistantMessage(source.snapshotEvents(), messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const last = turns.at(-1)
  if (last === undefined || turn !== last) throw new FloorError('not-last-floor', '只能续写最后一层回复')
  const binding = await state.loadBinding(sessionId)
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')

  const instruction = createUserMessage({
    content: [
      {
        type: 'text',
        text: `${CONTINUE_INSTRUCTION_PREFIX}上一条角色回复可能因长度上限被截断。请紧接断点继续写扮演正文，不要重复已输出的内容，不要解释，中间不要调用工具。`,
      },
    ],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '续写指令' },
  })
  await resumeAndDrive(ctx, sessionId, instruction)
  return { continued: true }
}

/** 角色的全部开场白变体（0 = first_mes）。 */
export async function greetingVariants(state: TavernState, cardId: string): Promise<string[]> {
  const ws = await state.loadCharacter(cardId)
  if (!ws) return []
  return [ws.card.firstMes, ...ws.card.alternateGreetings]
}

async function expandGreeting(state: TavernState, binding: SessionBinding, text: string): Promise<string> {
  const ws = await state.loadCharacter(binding.cardId)
  const persona = await state.resolvePersona(binding.personaId)
  return expandMacros(text, {
    char: ws?.card.name ?? 'Assistant',
    user: persona?.name ?? DEFAULT_USER_NAME,
  })
}

/**
 * agent-loop 的 lastTurn 只在构造时从 turnBoundary 投影读取；补 turn 后把空闲相位对齐，避免下一句抢号。
 * maintenance 相位同样要对齐：runMaintenance 结束时恢复的是相位对象上捕获的 lastTurn
 * （dsh-agent-loop 0.1.2 的 maintenance.lastTurn 与 phase.lastTurn 同源），在窗口内改写即随恢复生效。
 * 否则首条输入触发的维护（如 reserveHelperMvuMaintenance）会把开场白 turn 1 的对齐吞掉，
 * 锁存唤醒再开 turn 1 撞号，进而清空已提交开场白楼层的 WAL 记录。
 */
function syncIdleAgentLastTurn(ctx: Context | undefined, sessionId: string): void {
  const agent = (ctx as { agents?: { get(id: string): unknown } } | undefined)?.agents?.get(sessionId)
  const phase = (agent as { phase?: { kind?: string; lastTurn?: number } } | undefined)?.phase
  if (!phase || (phase.kind !== 'idle' && phase.kind !== 'maintenance') || typeof phase.lastTurn !== 'number') return
  phase.lastTurn = 1
}

/**
 * 把「只有开场白、从未 turn/start」的会话标成已开聊，这样「新对话」不会再复用它。
 * dsh 的 blank 只看 turn/start；assistant/message 不够。不要在 inbox/inserted 热路径调用：
 * agent loop 马上会自己 append turn/start，抢号会把当轮打崩。
 */
export function retireGreetingOnlyBlankSession(session: Session, ctx?: Context): boolean {
  if (!isGreetingOnlyBlank(session.snapshotEvents())) return false
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  syncIdleAgentLastTurn(ctx, session.id)
  return true
}

/** 开场白楼层的 swipe / 是否问候楼层；其它 assistant 消息 isGreeting = false。 */
export async function getGreetingSwipe(
  { ctx, state }: FloorDeps,
  sessionId: string,
  messageId: string,
): Promise<{ swipe: { index: number; total: number } | null; isGreeting: boolean; started: boolean }> {
  const none = { swipe: null, isGreeting: false, started: false }
  const binding = await state.loadBinding(sessionId)
  if (!binding || !messageId) return none
  const session = liveSession(ctx, sessionId)
  if (!session || !isTavernRuntimeSession(ctx, session)) return none
  const variants = await greetingVariants(state, binding.cardId)
  return greetingFloorState(session.snapshotEvents(), messageId, binding.greetingIndex, variants.length)
}

/**
 * 同一楼层分支会话的兄弟导航（ST 式 ‹ n/m ›）：读取 siblings.json 索引，
 * 按存在性过滤已删除/悬空的分支（live 会话直接算数；离线的以绑定文件是否还在为准——
 * dsh 不向插件暴露历史会话目录，绑定文件是插件侧最可靠的存在性信号；删卡/解绑会清绑定）。
 * 剪枝有变化就顺手落盘。非 Tavern / 未绑定 / 无兄弟记录一律软返回 swipe=null。
 */
export async function getFloorSiblings(
  { ctx, state }: FloorDeps,
  sessionId: string,
  messageId?: string,
  floorTurn?: number,
): Promise<{ swipe: (SiblingSwipe & { turn: number }) | null }> {
  const none: { swipe: null } = { swipe: null }
  const binding = await state.loadBinding(sessionId)
  if (!binding || (messageId === undefined && floorTurn === undefined)) return none
  const session = liveSession(ctx, sessionId)
  if (!session || !isTavernRuntimeSession(ctx, session)) return none
  const turn = resolveFloorTurn(session.snapshotEvents(), messageId, floorTurn)
  if (turn === null) return none

  const forks = await loadSiblingForks(state.paths.root)
  if (forks.length === 0) return none
  const ids = new Set<string>()
  for (const f of forks) {
    ids.add(f.parentSessionId)
    ids.add(f.childSessionId)
  }
  const existing = new Set<string>([sessionId])
  // 并行探测存在性：兄弟索引会随分支数增长，串行 await loadBinding 让每次导航查询线性变慢。
  await Promise.all(
    [...ids].map(async (id) => {
      if (ctx.sessions.get(id as Session['id']) !== undefined || (await loadBinding(state.paths, id)) !== null) {
        existing.add(id)
      }
    }),
  )
  const exists = (id: string) => existing.has(id)
  // 剪枝落盘走互斥读改写：与其它会话的 fork 登记（appendSiblingFork）并发时不互相覆盖。
  try {
    await mutateSiblingForks(state.paths.root, (current) => {
      const pruned = pruneSiblingForks(current, exists)
      return pruned.changed ? pruned.forks : current
    })
  } catch {
    // 落盘失败不影响本次查询；下次读取再剪
  }
  const swipe = siblingSwipe(pruneSiblingForks(forks, exists).forks, sessionId, turn, exists)
  if (!swipe) return none
  return { swipe: { turn, ...swipe } }
}

/**
 * 选卡进入对话：把开场白写进一轮完整 turn（start/step/message/end），
 * 聊天区才能露出封面，工具栏才会挂在这条开场白下面。「新对话」也不会再复用。
 * inbox 热路径仍走 ensureGreeting，避免和 agent loop 抢 turn 号。
 */
export async function enterGreetingConversation({ ctx, state }: FloorDeps, sessionId: string): Promise<boolean> {
  const binding = await state.loadBinding(sessionId)
  if (!binding) return false
  const session = liveSession(ctx, sessionId)
  if (!session || !isTavernRuntimeSession(ctx, session)) return false
  if (sessionHasUserMessage(session.snapshotEvents())) return false
  if (session.snapshotEvents().some((e) => e.type === 'assistant/message')) {
    retireGreetingOnlyBlankSession(session, ctx)
    return false
  }
  if (session.snapshotEvents().some((e) => e.type === 'turn/start')) return false
  const variants = await greetingVariants(state, binding.cardId)
  const raw = pickGreetingText(variants, binding.greetingIndex)
  if (!raw) return false
  const text = await expandGreeting(state, binding, raw)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'assistant/message',
    { turn: 1, step: 1, message: greetingMessage(text) },
    { surfaceOp: 'append', sourceEventSeqs: [] },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  syncIdleAgentLastTurn(ctx, session.id)
  return true
}

/**
 * 确保会话有开场白：会话尚无任何 assistant 消息时，把当前 greetingIndex 对应的
 * 开场白作为 turn 0 的 assistant 消息追加进日志。已有则返回 false。
 */
export async function ensureGreeting({ ctx, state }: FloorDeps, sessionId: string): Promise<boolean> {
  const binding = await state.loadBinding(sessionId)
  if (!binding) return false
  const session = liveSession(ctx, sessionId)
  if (!session || !isTavernRuntimeSession(ctx, session)) return false
  if (session.snapshotEvents().some((e) => e.type === 'assistant/message')) return false
  const variants = await greetingVariants(state, binding.cardId)
  const raw = pickGreetingText(variants, binding.greetingIndex)
  if (!raw) return false
  const text = await expandGreeting(state, binding, raw)
  session.append('assistant/message', { turn: 0, step: 0, message: greetingMessage(text) }, { surfaceOp: 'append', sourceEventSeqs: [] })
  return true
}

/**
 * 开场白 swipe：用指定变体编成 seed 后 fork。不要 create 空会话再 enterGreetingConversation——
 * 那会和刚启动的 agent loop 抢 append，打开子会话历史会 Failed to fetch。
 * 会话已有后续楼层时拒绝（swipe 只适用于开场白还是最后一条消息的场景）。
 */
export async function swipeGreeting({ ctx, state }: FloorDeps, sessionId: string, index: number): Promise<{ childSessionId: string; index: number; title: string }> {
  const binding = await state.loadBinding(sessionId)
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const variants = await greetingVariants(state, binding.cardId)
  if (variants.length === 0) throw new FloorError('no-greetings', '该角色没有开场白')
  const next = ((index % variants.length) + variants.length) % variants.length
  if (sessionHasUserMessage(source.snapshotEvents())) {
    throw new FloorError('has-turns', '对话已开始，不能再 swipe 开场白（请用回退/重新生成）')
  }
  const raw = pickGreetingText(variants, next)
  if (!raw) throw new FloorError('empty-greeting', '当前这条开场白为空')
  const text = await expandGreeting(state, binding, raw)

  const childId = await forkAt(ctx, state, source, binding, -1, {
    seedOverride: greetingTurnEvents(text), greetingIndex: next, rollbackFromTurn: 0,
  })
  return { childSessionId: childId, index: next, title: await branchTitle(state, binding, `开场白 ${next + 1}/${variants.length}`) }
}

/** 助手批量正文修改保持完整后续聊天，在草稿回滚派生状态；原会话不变且不自动重生成。 */
export async function forkEditedHistory(deps:FloorDeps,sessionId:string,storyId:string,seed:readonly SessionEvent[],fromTurn:number,verify:()=>Promise<void>,prepareEdits?:(fs:import('../state/workspaceFs.js').WorkspaceFs,childId:string)=>Promise<void>,action:'编辑聊天消息'|'删除聊天消息'='编辑聊天消息'):Promise<ForkResult>{
  const {ctx,state}=deps,source=liveSession(ctx,sessionId)
  if(!source)throw new FloorError('session-not-live','消息编辑需要当前会话在线')
  requireTavernSession(ctx,source)
  if(closedTurns(source.snapshotEvents()).openTurn!==null)throw new FloorError('turn-open','生成期间不能编辑聊天消息')
  const loaded=await state.loadBinding(sessionId)
  if(!loaded||loaded.storyId!==storyId)throw new FloorError('binding-changed','剧情绑定已改变')
  const binding=inferLiveWalLineage(ctx,source,loaded)
  const childSessionId=await forkAt(ctx,state,source,binding,source.snapshotEvents().length-1,{seedOverride:seed,forkTurn:fromTurn,rollbackFromTurn:fromTurn,verifySource:verify,prepareEdits})
  return {childSessionId,title:await branchTitle(state,binding,action)}
}
