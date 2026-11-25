/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。换模时宿主先向日志追加 model/selection，下一次请求才写
 * request/header；只看最近请求头会让换模后第一轮仍用旧模型。因此按宿主 modelSelection 投影同一
 * 口径取值：尚未被请求使用的最新选择优先，其次最近请求头，日志都没有时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js'
import { isTavernRuntimeSession } from './tavernSession.js'

const wrappedAgents = new WeakSet<object>()
const activeStepSelections = new WeakMap<object, SelectionEntry>()

/**
 * 同步 DSH 0.2.2-rc.1 ReactLoopAgent 在单步 preStep -> prepareRequest 期间锁定的 selection：
 * Tavern 在 agent/request 中将 deepseek-official 重写为内部布局通道 tavern-deepseek 并合入预设 reasoningEffort；
 * 仅处理已挂载 Tavern 预设的实例，不改宿主共享原型或覆盖会话已有的模型选择。
 */
export function ensureAgentRequestSelectionSync(agent: unknown, stepSelection?: unknown): void {
  if (!agent || typeof agent !== 'object') return
  const machine = agent as Record<string, any>
  if (stepSelection && typeof stepSelection === 'object') {
    activeStepSelections.set(machine, stepSelection as SelectionEntry)
    machine._activeSelection = stepSelection
  }
  if (!wrappedAgents.has(machine) && typeof machine.dispatch?.waterfall === 'function') {
    wrappedAgents.add(machine)
    const origWaterfall = machine.dispatch.waterfall
    machine.dispatch.waterfall = async function (this: any, name: string, payload: any, ...rest: any[]) {
      if (name === 'agent/pre-step' && payload?.modelSelection && typeof payload.modelSelection === 'object') {
        activeStepSelections.set(machine, payload.modelSelection as SelectionEntry)
        machine._activeSelection = payload.modelSelection
      }
      const res = await origWaterfall.call(this, name, payload, ...rest)
      // 只读 probe 不能改动当前步骤的已锁定选择，任何请求也不向会话日志伪造 model/selection 事件；
      // 真实请求头仍由宿主 buildRequest 在 prepareCall 成功后统一落盘。
      if (name === 'agent/request' && !payload?.probe && res && typeof res === 'object') {
        const sel = (machine._activeSelection ?? activeStepSelections.get(machine)) as SelectionEntry | undefined
        if (sel && typeof sel === 'object' && !Object.isFrozen(sel)) {
          if (res.provider) sel.provider = res.provider
          if (res.model) sel.model = res.model
          if (res.reasoningEffort !== undefined) {
            sel.reasoningEffort = res.reasoningEffort
          } else {
            delete sel.reasoningEffort
          }
        }
      }
      return res
    }
  }
}

export interface SessionModelRoute {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface RoutePair { provider: string; model: string; reasoningEffort?: string }

const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** 只接受成对的路由，不能拼出「新 provider + 旧 model」这类不存在的组合。 */
function pairOf(value: unknown): RoutePair | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { provider, model, reasoningEffort } = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (!present(provider) || !present(model)) return undefined
  return {
    provider: provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : provider,
    model,
    ...(present(reasoningEffort) ? { reasoningEffort } : {}),
  }
}

/** 对齐宿主 applyModelSelectionProjection：请求用过同一路由后，待用选择即消耗。 */
function loggedRoute(session: Partial<Pick<Agent['session'], 'snapshotEvents' | 'requestHeader'>> | undefined): RoutePair | undefined {
  const events = session?.snapshotEvents?.()
  if (!events) return pairOf(session?.requestHeader?.()?.config)
  let lastUsed: RoutePair | undefined
  let pending: RoutePair | undefined
  for (const event of events) {
    const type = String(event.type)
    if (type === 'model/selection') {
      pending = pairOf(event.data) ?? pending
    } else if (type === 'request/header') {
      const used = pairOf((event.data as { header?: { config?: unknown } } | undefined)?.header?.config)
      if (!used) continue
      lastUsed = used
      if (pending && pending.provider === used.provider && pending.model === used.model) pending = undefined
    }
  }
  // 早于快照折叠点的请求头不在事件里，但宿主仍能重建它。
  return pending ?? lastUsed ?? pairOf(session?.requestHeader?.()?.config)
}

export function sessionModelRoute(agent: Pick<Agent, 'options' | 'session'>): SessionModelRoute {
  return loggedRoute(agent.session) ?? pairOf(agent.options) ?? {}
}

interface SelectionEntry {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelSelectionState {
  lastUsed: SelectionEntry | null
  pending: SelectionEntry | null
}

const patchedProjections = new WeakSet<object>()
const patchedDefs = new WeakSet<object>()
const installedRoots = new WeakSet<object>()

function normalizeSelectionEntry(entry: SelectionEntry | null | undefined): SelectionEntry | null {
  if (!entry || typeof entry !== 'object') return null
  return entry.provider === PRESET_ADAPTER_PROVIDER
    ? { ...entry, provider: PRESET_ADAPTER_SOURCE_PROVIDER }
    : entry
}

function normalizeModelSelectionState(state: ModelSelectionState): ModelSelectionState {
  if (!state || typeof state !== 'object') return state
  const lastUsed = normalizeSelectionEntry(state.lastUsed)
  let pending = normalizeSelectionEntry(state.pending)
  if (pending && lastUsed && pending.provider === lastUsed.provider && pending.model === lastUsed.model
    && (state.lastUsed?.provider === PRESET_ADAPTER_PROVIDER || state.pending?.provider === PRESET_ADAPTER_PROVIDER)) {
    pending = null
  }
  return lastUsed === state.lastUsed && pending === state.pending ? state : { lastUsed, pending }
}

function patchModelSelectionDef(def: {
  key?: string
  apply?: (state: ModelSelectionState, event: { type?: string; data?: any }) => ModelSelectionState
  stateSchema?: { parse?: (input: unknown) => unknown; safeParse?: (input: unknown) => { success: boolean; data?: unknown } }
}, cleanups?: Array<() => void>): void {
  if (!def || typeof def !== 'object' || def.key !== 'modelSelection' || patchedDefs.has(def)) return
  patchedDefs.add(def)
  const origApply = def.apply
  if (typeof origApply === 'function') {
    const wrappedApply = (rawState: ModelSelectionState, event: { type?: string; data?: any }) => {
      const state = normalizeModelSelectionState(rawState)
      if (event?.type === 'model/selection' && event.data?.provider === PRESET_ADAPTER_PROVIDER) {
        return origApply(state, { ...event, data: { ...event.data, provider: PRESET_ADAPTER_SOURCE_PROVIDER } })
      }
      if (event?.type === 'request/header' && event.data?.header?.config?.provider === PRESET_ADAPTER_PROVIDER) {
        const cfg = event.data.header.config
        const normalizedEvent = {
          ...event,
          data: {
            ...event.data,
            header: {
              ...event.data.header,
              config: { ...cfg, provider: PRESET_ADAPTER_SOURCE_PROVIDER },
            },
          },
        }
        const next = origApply(state, normalizedEvent)
        if (next.pending && next.pending.provider === PRESET_ADAPTER_SOURCE_PROVIDER && next.pending.model === cfg.model) {
          return { ...next, pending: null }
        }
        return next
      }
      return origApply(state, event)
    }
    def.apply = wrappedApply
    cleanups?.push(() => {
      if (def.apply === wrappedApply) def.apply = origApply
      patchedDefs.delete(def)
    })
  }
  const schema = def.stateSchema
  if (schema && typeof schema === 'object' && !patchedDefs.has(schema)) {
    patchedDefs.add(schema)
    const rawParse = schema.parse
    let wrappedParse: ((input: unknown) => unknown) | undefined
    if (typeof rawParse === 'function') {
      const origParse = rawParse.bind(schema)
      wrappedParse = (input: unknown) => normalizeModelSelectionState(origParse(input) as ModelSelectionState)
      schema.parse = wrappedParse
    }
    const rawSafeParse = schema.safeParse
    let wrappedSafeParse: ((input: unknown) => { success: boolean; data?: unknown }) | undefined
    if (typeof rawSafeParse === 'function') {
      const origSafeParse = rawSafeParse.bind(schema)
      wrappedSafeParse = (input: unknown) => {
        const res = origSafeParse(input)
        return res.success ? { ...res, data: normalizeModelSelectionState(res.data as ModelSelectionState) } : res
      }
      schema.safeParse = wrappedSafeParse
    }
    cleanups?.push(() => {
      if (wrappedParse && schema.parse === wrappedParse) schema.parse = rawParse
      if (wrappedSafeParse && schema.safeParse === wrappedSafeParse) schema.safeParse = rawSafeParse
      patchedDefs.delete(schema)
    })
  }
}

function unwrapService<T extends object>(service: T): T {
  const original = (service as unknown as Record<PropertyKey, unknown>)[symbols.original]
  return (original && typeof original === 'object' ? original : service) as T
}

function ensureProjectionPatched(rawProjections: unknown, cleanups?: Array<() => void>): void {
  if (!rawProjections || typeof rawProjections !== 'object') return
  const projections = unwrapService(rawProjections as object)
  const regMap = (projections as { registrations?: Map<string, { def?: any }> }).registrations
  const existing = regMap?.get('modelSelection')
  if (existing?.def) patchModelSelectionDef(existing.def, cleanups)
  if (patchedProjections.has(projections)) return
  patchedProjections.add(projections)
  const origRegister = (projections as { register?: (def: any) => unknown }).register
  if (typeof origRegister === 'function') {
    const wrappedRegister = function (this: unknown, def: any) {
      patchModelSelectionDef(def, cleanups)
      const dispose = origRegister.call(this, def)
      const registered = regMap?.get('modelSelection')
      if (registered?.def) patchModelSelectionDef(registered.def, cleanups)
      return dispose
    }
    ;(projections as { register: (def: any) => unknown }).register = wrappedRegister
    cleanups?.push(() => {
      if ((projections as { register?: unknown }).register === wrappedRegister) {
        ;(projections as { register: (def: any) => unknown }).register = origRegister
      }
      patchedProjections.delete(projections)
    })
  }
}

/**
 * 对齐宿主 modelSelection 投影与 SessionController.consumeSelection：
 * Tavern 将 deepseek-official 请求重写为内部布局通道 tavern-deepseek 后，request/header 记录
 * provider='tavern-deepseek'。在此将其映射回 deepseek-official 结算，避免 pending/picked 悬空导致跨轮/跨重启重复换模通知。
 */
export function installTavernModelSelectionCompat(ctx: Context): void {
  const root = (ctx.root ?? ctx) as Context
  const cleanups: Array<() => void> = []
  ensureProjectionPatched(root.get('sessionProjections'), cleanups)
  if (installedRoots.has(root)) return
  installedRoots.add(root)
  ctx.on('session/event' as any, (session: { id: string }, event: { type?: string; data?: any }) => {
    if (event?.type !== 'request/header') return
    ensureProjectionPatched(root.get('sessionProjections'), cleanups)
    const cfg = event.data?.header?.config
    if (!cfg || typeof cfg.provider !== 'string' || typeof cfg.model !== 'string') return
    const isPresetRoute = cfg.provider === PRESET_ADAPTER_PROVIDER
    if (!isPresetRoute && !isTavernRuntimeSession(root, session as Session)) return
    const targetProvider = isPresetRoute ? PRESET_ADAPTER_SOURCE_PROVIDER : cfg.provider
    const controller = root.get('sessionController') as {
      agents?: {
        consumeSelection?: (agent: unknown, provider: string, model: string, reasoningEffort?: string) => boolean
        selections?: Map<unknown, {
          current?: { provider?: string; model?: string; reasoningEffort?: string }
          consume?: (provider: string, model: string, reasoningEffort?: string) => boolean
        }>
      }
    } | undefined
    const agents = root.get('agents') as { get?: (id: string) => { session?: unknown } | undefined } | undefined
    const agent = agents?.get?.(session.id)
    if (!agent || agent.session !== session || !controller?.agents) return
    const consumed = controller.agents.consumeSelection?.(
      agent,
      targetProvider,
      cfg.model,
      cfg.reasoningEffort,
    )
    if (!consumed) {
      const sel = controller.agents.selections?.get(agent)
      const current = sel?.current
      const currentProvider = current?.provider
      if (current
        && typeof currentProvider === 'string'
        && (currentProvider === targetProvider || (isPresetRoute && currentProvider === PRESET_ADAPTER_PROVIDER))
        && typeof current.model === 'string'
        && current.model === cfg.model) {
        sel?.consume?.(currentProvider, current.model, current.reasoningEffort)
      }
    }
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      installedRoots.delete(root)
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    }, 'dsh-tavern: model selection compat')
  }
}
