/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。换模时宿主先向日志追加 model/selection，下一次请求才写
 * request/header；只看最近请求头会让换模后第一轮仍用旧模型。因此按宿主 modelSelection 投影同一
 * 口径取值：尚未被请求使用的最新选择优先，其次最近请求头，日志都没有时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import { Service, symbols, Context } from '@deepseek-ai/cordis'
import { AgentRegistry, AgentModel, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js'

if (typeof (AgentModel as any)?.prototype?.current === 'function') {
  const origCurrent = (AgentModel as any).prototype.current
  ;(AgentModel as any).prototype.current = function () {
    const state = this.readState?.()
    if (state?.pending) return { ...state.pending }
    if (this.options?.provider && this.options?.model) {
      const hasOwnRequest = Boolean(this.session?.ownEvents?.()?.some((e: any) => e.type === 'request/header'))
      if (!hasOwnRequest) {
        return {
          provider: this.options.provider,
          model: this.options.model,
          ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
        }
      }
    }
    return origCurrent.call(this)
  }
}

if (typeof (SandboxPolicyService as any)?.prototype?.overrideOf === 'function') {
  const origOverrideOf = (SandboxPolicyService as any).prototype.overrideOf
  ;(SandboxPolicyService as any).prototype.overrideOf = function (session: any) {
    if (!this.sandboxModeProjectionHandle) return undefined
    return origOverrideOf.call(this, session)
  }
}

if (typeof (WorkingDirectoryService as any)?.prototype?.get === 'function') {
  const origGet = (WorkingDirectoryService as any).prototype.get
  ;(WorkingDirectoryService as any).prototype.get = function (session: any) {
    if (!this.workingDirectoryProjectionHandle) {
      return session?.header?.cwd ?? this.defaultDirectory
    }
    return origGet.call(this, session)
  }
}

if (typeof (WorkingDirectoryService as any)?.prototype?.ensure === 'function') {
  const origEnsure = (WorkingDirectoryService as any).prototype.ensure
  ;(WorkingDirectoryService as any).prototype.ensure = async function (agent: any, signal: any) {
    if (!this.workingDirectoryProjectionHandle && this.ctx?.sessionProjections) {
      try {
        await this[Service.init]?.()
      } catch {}
    }
    if (!this.workingDirectoryProjectionHandle) {
      return this.get(agent?.session)
    }
    return origEnsure.call(this, agent, signal)
  }
}

if (typeof (ToolRuntime as any)?.prototype?.selectExecutor === 'function') {
  const origSelectExecutor = (ToolRuntime as any).prototype.selectExecutor
  ;(ToolRuntime as any).prototype.selectExecutor = function (scope: any) {
    try {
      return origSelectExecutor.call(this, scope)
    } catch (err: any) {
      if (err?.code === 'TOOL_EXECUTOR_UNAVAILABLE' || err?.name === 'ToolExecutorUnavailableError') {
        return new NativeToolExecutor(this.ctx)
      }
      throw err
    }
  }
}

if (typeof (ToolRuntime as any)?.prototype?.modeFor !== 'function') {
  ;(ToolRuntime as any).prototype.modeFor = function (scope: any) {
    try {
      const exec = this.selectExecutor(scope)
      if (exec?.constructor?.name === 'PtcExecutor') return 'ptc'
      if (exec?.constructor?.name === 'NativeToolExecutor') return 'native'
      return undefined
    } catch {
      return undefined
    }
  }
}

if (typeof (ToolRuntime as any)?.prototype?.execute === 'function') {
  const origExecute = (ToolRuntime as any).prototype.execute
  ;(ToolRuntime as any).prototype.execute = async function (input: any) {
    const isSingle = input && !input.calls && (input.name !== undefined || input.callId !== undefined)
    if (isSingle) {
      const call = {
        id: input.callId ?? 'call-1',
        name: input.name,
        arguments: input.arguments,
      }
      const batchInput = {
        ...input,
        calls: [call],
      }
      const batchResult = await origExecute.call(this, batchInput)
      const first = batchResult?.results?.[0]?.result ?? batchResult?.results?.[0]
      return first ?? batchResult
    }
    return origExecute.call(this, input)
  }
}

try {
  const EventsService = (new Context() as any).events?.constructor
  if (typeof EventsService?.prototype?.waterfall === 'function') {
    const origWaterfall = EventsService.prototype.waterfall
    EventsService.prototype.waterfall = function (...args: any[]) {
      const name = typeof args[0] === 'string' ? args[0] : typeof args[1] === 'string' ? args[1] : undefined
      if (name === 'agent/pre-step') {
        const payload = typeof args[0] === 'object' && args[0] !== null ? args[0] : typeof args[1] === 'object' && args[1] !== null ? args[1] : undefined
        if (payload && !payload.modelSelection && payload.agent) {
          const route = sessionModelRoute(payload.agent)
          payload.modelSelection = {
            provider: route.provider ?? payload.agent.options?.provider ?? 'deepseek-official',
            model: route.model ?? payload.agent.options?.model ?? 'deepseek-chat',
            ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
          }
        }
      }
      return origWaterfall.apply(this, args)
    }
  }
} catch {}

if (typeof (AgentRegistry as any)?.prototype?.setFactory === 'function') {
  const origSetFactory = (AgentRegistry as any).prototype.setFactory
  ;(AgentRegistry as any).prototype.setFactory = function (factory: any) {
    if (this.factory !== undefined) {
      const target = (factory as any)?.[symbols.original] ?? factory
      if (this.factory.target === target) {
        return () => {}
      }
    }
    return origSetFactory.call(this, factory)
  }
}

if (typeof (AgentRegistry as any)?.prototype?.requireFactory === 'function') {
  const origRequireFactory = (AgentRegistry as any).prototype.requireFactory
  ;(AgentRegistry as any).prototype.requireFactory = function () {
    if (!this.factory && this.ctx?.agentLoop) {
      try {
        this.setFactory(this.ctx.agentLoop)
      } catch {}
    }
    return origRequireFactory.call(this)
  }
}

let patchedReactLoop = false
if (typeof (AgentLoop as any)?.prototype?.initializeAgent === 'function') {
  const origInitializeAgent = (AgentLoop as any).prototype.initializeAgent
  ;(AgentLoop as any).prototype.initializeAgent = async function (ownerCtx: any, options: any) {
    if (!this.modelProjectionHandle) {
      await this[Service.init]?.()
    }
    const agents = this.runtime?.ctx?.agents
    if (agents && !agents.turnBoundaryProjectionHandle) {
      await agents[Service.init]?.()
    }
    const loopCtx = this.runtime?.ctx
    if (loopCtx && !loopCtx.tools) {
      loopCtx.tools = {
        resolve: async () => ({
          dispose: () => {},
          view: () => new Map(),
        }),
        execute: async () => [],
      }
    }
    const result = await origInitializeAgent.call(this, ownerCtx, options)
    const machine = (result as any)?.agent ?? result?.[0]
    if (machine) {
      if (typeof machine.dispatch?.waterfall === 'function' && !(machine.dispatch as any)._tavernWrapped) {
        const origWaterfall = machine.dispatch.waterfall
        ;(machine.dispatch as any)._tavernWrapped = true
        machine.dispatch.waterfall = async function (name: string, payload: any, ...rest: any[]) {
          const res = await origWaterfall.call(this, name, payload, ...rest)
          if (name === 'agent/request' && res && machine._activeSelection) {
            const sel = machine._activeSelection
            if (res.provider) sel.provider = res.provider
            if (res.model) sel.model = res.model
            if (res.reasoningEffort !== undefined) {
              sel.reasoningEffort = res.reasoningEffort
            } else {
              delete sel.reasoningEffort
            }
            if (typeof machine.model?.select === 'function') {
              machine.model.select({
                provider: res.provider,
                model: res.model,
                ...(res.reasoningEffort !== undefined ? { reasoningEffort: res.reasoningEffort } : {}),
              })
            }
          }
          return res
        }
      }
      if (!patchedReactLoop) {
        patchedReactLoop = true
        const proto = Object.getPrototypeOf(machine)
        if (typeof proto?.preStep === 'function') {
          const origPreStep = proto.preStep
          proto.preStep = async function (target: any, position: any) {
            if (!this.requestHeaderLogged && this.options?.provider && this.options?.model) {
              const current = this.model?.current()
              if (!current || current.provider !== this.options.provider || current.model !== this.options.model) {
                this.model?.select({
                  provider: this.options.provider,
                  model: this.options.model,
                  ...(this.options.reasoningEffort !== undefined ? { reasoningEffort: this.options.reasoningEffort } : {}),
                })
              }
            }
            if (this.model && this.model.current() === undefined) {
              const route = sessionModelRoute(this)
              const fallbackRoute = (route.provider && route.model)
                ? {
                    provider: route.provider,
                    model: route.model,
                    ...((route as any).reasoningEffort !== undefined ? { reasoningEffort: (route as any).reasoningEffort } : {}),
                  }
                : {
                    provider: this.options?.provider || 'deepseek-official',
                    model: this.options?.model || 'deepseek-chat',
                  }
              this.model.select(fallbackRoute)
            }
            const decision = await origPreStep.call(this, target, position)
            if (decision?.selection) {
              this._activeSelection = decision.selection
            }
            return decision
          }
        }
      }
    }
    return result
  }
}

if (typeof AgentRegistry?.prototype?.turnBoundaryOf === 'function') {
  const origTurnBoundaryOf = AgentRegistry.prototype.turnBoundaryOf
  AgentRegistry.prototype.turnBoundaryOf = function (session: any) {
    if ((this as any).turnBoundaryProjectionHandle) {
      return origTurnBoundaryOf.call(this, session)
    }
    let state: any = {
      openTurnStartSeq: null,
      lastStepStartSeq: null,
      lastStepBoundary: null,
      lastTurn: 0,
    }
    for (const event of session?.snapshotEvents?.() ?? []) {
      switch (event.type) {
        case 'turn/start':
          state = { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
          break
        case 'turn/end':
          state = { ...state, openTurnStartSeq: null }
          break
        case 'step/start':
          state = { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } }
          break
        case 'step/end':
          state = { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
          break
      }
    }
    return state
  }
}

export interface SessionModelRoute {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface RoutePair { provider: string; model: string }

const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** 只接受成对的路由，不能拼出「新 provider + 旧 model」这类不存在的组合。 */
function pairOf(value: unknown): RoutePair | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { provider, model } = value as { provider?: unknown; model?: unknown }
  if (!present(provider) || !present(model)) return undefined
  return {
    provider: provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : provider,
    model,
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
}): void {
  if (!def || typeof def !== 'object' || def.key !== 'modelSelection' || patchedDefs.has(def)) return
  patchedDefs.add(def)
  const origApply = def.apply
  if (typeof origApply === 'function') {
    def.apply = (rawState: ModelSelectionState, event: { type?: string; data?: any }) => {
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
  }
  const schema = def.stateSchema
  if (schema && typeof schema === 'object' && !patchedDefs.has(schema)) {
    patchedDefs.add(schema)
    if (typeof schema.parse === 'function') {
      const origParse = schema.parse.bind(schema)
      schema.parse = (input: unknown) => normalizeModelSelectionState(origParse(input) as ModelSelectionState)
    }
    if (typeof schema.safeParse === 'function') {
      const origSafeParse = schema.safeParse.bind(schema)
      schema.safeParse = (input: unknown) => {
        const res = origSafeParse(input)
        return res.success ? { ...res, data: normalizeModelSelectionState(res.data as ModelSelectionState) } : res
      }
    }
  }
}

function ensureProjectionPatched(projections: unknown): void {
  if (!projections || typeof projections !== 'object') return
  const regMap = (projections as { registrations?: Map<string, { def?: any }> }).registrations
  const existing = regMap?.get('modelSelection')
  if (existing?.def) patchModelSelectionDef(existing.def)
  if (patchedProjections.has(projections)) return
  patchedProjections.add(projections)
  const origRegister = (projections as { register?: (def: any) => unknown }).register
  if (typeof origRegister === 'function') {
    ;(projections as { register: (def: any) => unknown }).register = function (def: any) {
      patchModelSelectionDef(def)
      const dispose = origRegister.call(this, def)
      const registered = regMap?.get('modelSelection')
      if (registered?.def) patchModelSelectionDef(registered.def)
      return dispose
    }
  }
}

/**
 * 对齐宿主 modelSelection 投影与 SessionController.consumeSelection：
 * Tavern 将 deepseek-official 请求重写为内部布局通道 tavern-deepseek 后，request/header 记录
 * provider='tavern-deepseek'。在此将其映射回 deepseek-official 结算，避免 pending/picked 悬空导致跨轮/跨重启重复换模通知。
 */
export function installTavernModelSelectionCompat(ctx: Context): void {
  const root = (ctx.root ?? ctx) as Context
  ensureProjectionPatched(root.get('sessionProjections'))
  if (installedRoots.has(root)) return
  installedRoots.add(root)
  root.on('session/event' as any, (session: { id: string }, event: { type?: string; data?: any }) => {
    ensureProjectionPatched(root.get('sessionProjections'))
    if (event?.type !== 'request/header') return
    const cfg = event.data?.header?.config
    if (!cfg || cfg.provider !== PRESET_ADAPTER_PROVIDER) return
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
      PRESET_ADAPTER_SOURCE_PROVIDER,
      cfg.model,
      cfg.reasoningEffort,
    )
    if (!consumed) {
      const sel = controller.agents.selections?.get(agent)
      const current = sel?.current
      if (current
        && (current.provider === PRESET_ADAPTER_SOURCE_PROVIDER || current.provider === PRESET_ADAPTER_PROVIDER)
        && typeof current.model === 'string'
        && current.model === cfg.model) {
        sel?.consume?.(current.provider, current.model, current.reasoningEffort)
      }
    }
  })
}
