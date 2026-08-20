/**
 * 楼层操作：重新生成 / 回退 / 编辑用户消息 / 开场白 swipe。
 *
 * dsh 会话日志不可删除，楼层操作通过「fork 前缀 + WAL 回滚 + 子会话续跑」实现：
 * 原会话保持不变，结果落在一个新的子会话上（README 限制项有说明）。
 * 子会话必须走 agents.create + workspace.attachSession（与官方 session.fork 相同），
 * 并带上父会话的 provider/model（agentOptions），否则子会话立刻 followup 时
 * `deployment:persona` 的 `{{model}}` 没有值，本轮会直接失败。
 * 开场白要预先编进 seed。禁止 ctx.sessions.fork / tavern- 前缀，禁止 create 后再 append 开场白。
 * WAL 楼层命名：`${sessionId}#t${turn}`（由 host 入口在 turn/start 时 beginFloor）；
 * 子绑定额外记录继承的祖先 session/turn 边界，跨 fork 回滚时合并这些楼层。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset, type AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { greetingFloorState, isGreetingOnlyBlank, pickGreetingText, sessionHasUserMessage, TAVERN_GREETING_SOURCE } from '../core/greetingLog.js'
import { expandMacros } from '../core/macros.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { greetingMessage, greetingTurnEvents } from './greetingSeed.js'
import { isTavernRuntimeSession } from './tavernSession.js'
import type { SessionBinding, WalLineageEntry } from './bindings.js'
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
    for (let i = source.events.length - 1; i >= 0; i--) {
      const event = source.events[i]!
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
export function sessionPrefixEvents(source: Pick<Session, 'events'>, boundaryInclusive?: number): SessionEvent[] {
  const events = source.events
  const cut = boundaryInclusive === undefined ? events.length : Math.max(0, boundaryInclusive + 1)
  return events.slice(0, cut) as SessionEvent[]
}

/**
 * 按官方 session.fork 的路径建子会话：agents.create（seed 里带完整前缀 / cwd / agentPreset）后
 * workspace.attachSession。不要用 ctx.sessions.fork——那样没有 agent、也不挂工作区。
 * setup 走 mount（与官方 fork 相同），不要 composeFrom（那是 subagent 路径）。
 * 开场白必须预先编进 seed，禁止 create 之后再 append。
 */
async function forkChildSession(ctx: Context, source: Session, seed: readonly SessionEvent[]): Promise<string> {
  const childId = newChildId()
  const presets = agentPresetsOf(ctx)
  const parent = ctx.agents.get(source.id)
  const named =
    (parent ? presets.composedPreset(parent.ctx) : undefined) ?? resolveSessionPreset(source) ?? 'tavern'
  let resolvedId = named
  try {
    resolvedId = (await presets.resolve(named)).id
  } catch {
    resolvedId = named
  }
  const meta = {
    ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
    parentSession: source.id,
    seedLength: seed.length,
    agentPreset: resolvedId,
  }
  const copied = agentOptionsForCreate(forkAgentOptions(parent, source))
  const options: CreateAgentOptions = {
    sessionId: childId as Session['id'],
    ...(seed.length > 0 ? { seed } : {}),
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
  // The caller owns the handle only for creation cleanup; the running child remains registered.
  // AgentRegistry removes its own handle ownership after create resolves.
  return childId
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
 * WalManager.rollbackAfter 会在内部按数组逆序回放，因此这里必须按 turn 数字升序传入；
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

/** WAL 回滚当前分支 turn >= fromTurn 的楼层（含被继承的祖先楼层）。 */
async function rollbackFloors(
  state: TavernState,
  cardId: string,
  binding: Pick<SessionBinding, 'walLineage'>,
  sessionId: string,
  fromTurn: number,
): Promise<string[]> {
  const ws = await state.workspace(cardId)
  const names = floorNamesForLineageRollback(
    (await ws.wal.listFloors()).map((floor) => floor.floor),
    binding,
    sessionId,
    fromTurn,
  )
  if (names.length === 0) return []
  const result = await ws.wal.rollbackAfter(names, join(state.paths.characters, cardId))
  return [...result.restored, ...result.skipped]
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

/** 把回退边界所属会话（可能刚回滚过）的定时状态复制为子会话起点。 */
async function copyTimers(
  state: TavernState,
  cardId: string,
  binding: Pick<SessionBinding, 'walLineage'>,
  currentSessionId: string,
  toSession: string,
  boundaryTurn: number,
): Promise<void> {
  const owner = timerOwnerAtTurn(binding, currentSessionId, boundaryTurn)
  const timers = await state.loadTimers(cardId, owner)
  await state.saveTimers(cardId, toSession, timers)
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
 * 兼容上一版本已经存在的分支绑定：从当前 live session 的 durable header 补回祖先边界。
 * 新 fork 会直接持久化 walLineage；这里只在旧绑定缺字段且父会话仍在线时尽力迁移。
 */
function inferLiveWalLineage(ctx: Context, source: Session, binding: SessionBinding): SessionBinding {
  if ((binding.walLineage?.length ?? 0) > 0 || !source.header.parentSession) return binding
  const reverse: WalLineageEntry[] = []
  const seen = new Set<string>()
  let child = source
  while (child.header.parentSession && !seen.has(child.header.parentSession)) {
    const parentId = child.header.parentSession
    seen.add(parentId)
    const seedLength = Number.isSafeInteger(child.header.seedLength) ? child.header.seedLength! : 0
    const throughTurn = inheritedThroughTurn(child.events.slice(0, seedLength))
    if (throughTurn !== null) reverse.push({ sessionId: parentId, throughTurn })
    const parent = ctx.sessions.get(parentId)
    if (!parent) break
    child = parent
  }
  if (reverse.length === 0) return binding
  return { ...binding, walLineage: reverse.reverse() }
}

async function forkAt(
  ctx: Context,
  state: TavernState,
  source: Session,
  binding: SessionBinding,
  boundary: number,
  greetingIndex?: number,
): Promise<string> {
  const seed = sessionPrefixEvents(source, boundary)
  const childId = await forkChildSession(ctx, source, seed)
  const throughTurn = inheritedThroughTurn(seed)
  const walLineage = [
    ...(binding.walLineage ?? []).filter((entry) => entry.sessionId !== source.id),
    ...(throughTurn === null ? [] : [{ sessionId: source.id, throughTurn }]),
  ]
  try {
    await state.saveBinding({
      ...binding,
      sessionId: childId,
      walLineage,
      ...(greetingIndex !== undefined ? { greetingIndex } : {}),
    })
  } catch (error) {
    const workspace = (ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined)
      ?.list()
      .find((item) => item.sessionIds.includes(childId))
    await workspace?.detachSession?.(childId).catch(() => {})
    const child = ctx.agents.get(childId as Session['id']) as (Agent & { dispose?: () => Promise<void> }) | undefined
    await child?.dispose?.().catch(() => {})
    throw new FloorError('binding-save-failed', `保存分支绑定失败：${error instanceof Error ? error.message : String(error)}`)
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

/** 重新生成：回滚目标楼层并重跑。messageId 指定楼层（assistant 消息 id），缺省取最后一个已关闭 turn。进行中的 turn 拒绝。 */
export async function regenerate({ ctx, state }: FloorDeps, sessionId: string, messageId?: string): Promise<{ childSessionId: string }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线（仅支持当前打开的会话）`)
  requireTavernSession(ctx, source)
  const { turns, openTurn } = closedTurns(source.events)
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中，请等待完成后再重新生成`)
  let target: number
  if (messageId !== undefined) {
    const turn = turnOfAssistantMessage(source.events, messageId)
    if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
    if (!turns.includes(turn)) throw new FloorError('turn-open', `turn ${turn} 尚未完结，不能重新生成`)
    target = turn
  } else {
    const last = turns.at(-1)
    if (last === undefined) throw new FloorError('no-turns', '会话还没有可重新生成的楼层')
    target = last
  }
  const seq = turnStartSeq(source.events, target)
  // seq 0 合法：turn/start 是日志第一条时，前缀为空（sessionPrefixEvents(..., -1) → []），即重跑第一层。
  if (seq === null) throw new FloorError('bad-boundary', `turn ${target} 的边界不可回退`)
  const userMessage = firstUserMessageOf(source.events, target)
  if (!userMessage) throw new FloorError('no-user-message', `turn ${target} 内找不到用户消息`)

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  // fork/挂工作区/保存子绑定全部成功后才改 WAL；这些步骤失败时源工作区保持原状。
  const childId = await forkAt(ctx, state, source, binding, seq - 1)
  await rollbackFloors(state, binding.cardId, binding, sessionId, target)
  await copyTimers(state, binding.cardId, binding, sessionId, childId, target - 1)
  await resumeAndDrive(ctx, childId, createUserMessage({ content: userMessage.content, source: { kind: 'user' } }))
  return { childSessionId: childId }
}

/** 回退到指定楼层：保留该楼层（含）之前的全部内容，丢弃其后的楼层；不自动续跑。 */
export async function rollbackToFloor({ ctx, state }: FloorDeps, sessionId: string, messageId: string): Promise<{ childSessionId: string }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const { openTurn } = closedTurns(source.events)
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中`)
  const turn = turnOfAssistantMessage(source.events, messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const endSeq = turnEndSeq(source.events, turn)
  if (endSeq === null) throw new FloorError('turn-open', `turn ${turn} 尚未完结，不能作为回退边界`)

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const childId = await forkAt(ctx, state, source, binding, endSeq)
  await rollbackFloors(state, binding.cardId, binding, sessionId, turn + 1)
  await copyTimers(state, binding.cardId, binding, sessionId, childId, turn)
  return { childSessionId: childId }
}

/** 读取指定楼层的首条用户消息（编辑对话框预填用）。 */
export async function getFloorUserMessage({ ctx }: FloorDeps, sessionId: string, messageId: string): Promise<{ turn: number; text: string }> {
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const turn = turnOfAssistantMessage(source.events, messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const userMessage = firstUserMessageOf(source.events, turn)
  if (!userMessage) throw new FloorError('no-user-message', `turn ${turn} 内没有用户消息`)
  return { turn, text: userMessageText(userMessage) }
}

/** 编辑指定楼层的用户消息：回退到该楼层前并以新文本重跑。 */
export async function editUserMessage(
  deps: FloorDeps,
  sessionId: string,
  messageId: string,
  newText: string,
): Promise<{ childSessionId: string }> {
  const { ctx, state } = deps
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const { openTurn } = closedTurns(source.events)
  if (openTurn !== null) throw new FloorError('turn-open', `turn ${openTurn} 仍在进行中`)
  const turn = turnOfAssistantMessage(source.events, messageId)
  if (turn === null) throw new FloorError('no-message', '这条消息不在当前会话中（可能已过期）')
  const seq = turnStartSeq(source.events, turn)
  if (seq === null) throw new FloorError('no-turn', `会话中没有 turn ${turn}`)
  if (!firstUserMessageOf(source.events, turn)) throw new FloorError('no-user-message', `turn ${turn} 内没有用户消息可编辑`)

  const loadedBinding = await state.loadBinding(sessionId)
  const binding = loadedBinding ? inferLiveWalLineage(ctx, source, loadedBinding) : null
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const childId = await forkAt(ctx, state, source, binding, seq - 1)
  await rollbackFloors(state, binding.cardId, binding, sessionId, turn)
  await copyTimers(state, binding.cardId, binding, sessionId, childId, turn - 1)
  await resumeAndDrive(ctx, childId, createUserMessage({ content: [{ type: 'text', text: newText }], source: { kind: 'user' } }))
  return { childSessionId: childId }
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

/** agent-loop 的 lastTurn 只在构造时从日志读取；补 turn 后把 idle 相位对齐，避免下一句抢号。 */
function syncIdleAgentLastTurn(ctx: Context | undefined, sessionId: string): void {
  const agent = (ctx as { agents?: { get(id: string): unknown } } | undefined)?.agents?.get(sessionId)
  const phase = (agent as { phase?: { kind?: string; lastTurn?: number } } | undefined)?.phase
  if (!phase || phase.kind !== 'idle' || typeof phase.lastTurn !== 'number') return
  phase.lastTurn = 1
}

/**
 * 把「只有开场白、从未 turn/start」的会话标成已开聊，这样「新对话」不会再复用它。
 * dsh 的 blank 只看 turn/start；assistant/message 不够。不要在 inbox/inserted 热路径调用：
 * agent loop 马上会自己 append turn/start，抢号会把当轮打崩。
 */
export function retireGreetingOnlyBlankSession(session: Session, ctx?: Context): boolean {
  if (!isGreetingOnlyBlank(session.events)) return false
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
  return greetingFloorState(session.events, messageId, binding.greetingIndex, variants.length)
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
  if (sessionHasUserMessage(session.events)) return false
  if (session.events.some((e) => e.type === 'assistant/message')) {
    retireGreetingOnlyBlankSession(session, ctx)
    return false
  }
  if (session.events.some((e) => e.type === 'turn/start')) return false
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
  if (session.events.some((e) => e.type === 'assistant/message')) return false
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
export async function swipeGreeting({ ctx, state }: FloorDeps, sessionId: string, index: number): Promise<{ childSessionId: string; index: number }> {
  const binding = await state.loadBinding(sessionId)
  if (!binding) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
  const source = liveSession(ctx, sessionId)
  if (!source) throw new FloorError('session-not-live', `会话 ${sessionId} 不在线`)
  requireTavernSession(ctx, source)
  const variants = await greetingVariants(state, binding.cardId)
  if (variants.length === 0) throw new FloorError('no-greetings', '该角色没有开场白')
  const next = ((index % variants.length) + variants.length) % variants.length
  if (sessionHasUserMessage(source.events)) {
    throw new FloorError('has-turns', '对话已开始，不能再 swipe 开场白（请用回退/重新生成）')
  }
  const raw = pickGreetingText(variants, next)
  if (!raw) throw new FloorError('empty-greeting', '当前这条开场白为空')
  const text = await expandGreeting(state, binding, raw)

  const childId = await forkChildSession(ctx, source, greetingTurnEvents(text))
  await state.saveBinding({ ...binding, sessionId: childId, greetingIndex: next })
  return { childSessionId: childId, index: next }
}
