/** 隔离运行时按墙钟限时；限制测试文件并发，避免大量测试沙箱争抢 CPU 产生假超时，不放宽产品限额。 */
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'dsh-agent-compat-alias',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === '\0dsh-test-harness-compat' || id === '\0dsh-agent-compat') return id
        if (id === '@deepseek-ai/dsh-agent') {
          if (importer && (importer.includes('node_modules') || importer === '\0dsh-test-harness-compat' || importer === '\0dsh-agent-compat')) {
            return null
          }
          return '\0dsh-agent-compat'
        }
        return null
      },
      load(id) {
        if (id === '\0dsh-agent-compat') {
          return `
import * as upstreamAgent from '@deepseek-ai/dsh-agent'
export * from '@deepseek-ai/dsh-agent'

export function installModelSelection(agentCtx, legacySelection) {
  if (legacySelection && typeof legacySelection === 'object') {
    agentCtx.on('agent/pre-step', async ({ agent, modelSelection }, next) => {
      if (legacySelection.current && agent?.model) {
        const cur = legacySelection.current
        if (cur.provider && cur.model) {
          agent.model.select(cur)
          if (modelSelection) {
            modelSelection.provider = cur.provider
            modelSelection.model = cur.model
            if (cur.reasoningEffort !== undefined) modelSelection.reasoningEffort = cur.reasoningEffort
          }
        }
      }
      return next()
    }, { prepend: true })
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const res = await next()
      if (legacySelection.current?.provider) {
        res.variables['provider'] = legacySelection.current.provider
      }
      return res
    })
    agentCtx.on('agent/request', async (_payload, next) => {
      const config = await next()
      if (legacySelection.current?.provider && legacySelection.current?.model) {
        return {
          ...config,
          provider: legacySelection.current.provider,
          model: legacySelection.current.model,
          ...(legacySelection.current.reasoningEffort === undefined ? {} : { reasoningEffort: legacySelection.current.reasoningEffort }),
        }
      }
      return config
    })
  }
  return upstreamAgent.installModelSelection(agentCtx)
}
`
        }
        if (id !== '\0dsh-test-harness-compat') return null
        return `
import { Service, symbols, Context } from '@deepseek-ai/cordis'
import { AgentRegistry, AgentModel } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
// setup 只安装宿主测试桩；业务模块等测试文件注册 vi.mock 后再加载，避免提前缓存真实适配器。
const loadModelRoute = () => import('${fileURLToPath(new URL('./src/node/modelRoute.ts', import.meta.url)).replace(/\\/g, '/')}')

if (typeof AgentModel?.prototype?.current === 'function') {
  const origCurrent = AgentModel.prototype.current
  AgentModel.prototype.current = function () {
    const state = this.readState?.()
    if (state?.pending) return { ...state.pending }
    if (this.options?.provider && this.options?.model) {
      const hasOwnRequest = Boolean(this.session?.ownEvents?.()?.some((e) => e.type === 'request/header'))
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

if (typeof SandboxPolicyService?.prototype?.overrideOf === 'function') {
  const origOverrideOf = SandboxPolicyService.prototype.overrideOf
  SandboxPolicyService.prototype.overrideOf = function (session) {
    if (!this.sandboxModeProjectionHandle) return undefined
    return origOverrideOf.call(this, session)
  }
}

if (typeof WorkingDirectoryService?.prototype?.get === 'function') {
  const origGet = WorkingDirectoryService.prototype.get
  WorkingDirectoryService.prototype.get = function (session) {
    if (!this.workingDirectoryProjectionHandle) {
      return session?.header?.cwd ?? this.defaultDirectory
    }
    return origGet.call(this, session)
  }
}

if (typeof WorkingDirectoryService?.prototype?.ensure === 'function') {
  const origEnsure = WorkingDirectoryService.prototype.ensure
  WorkingDirectoryService.prototype.ensure = async function (agent, signal) {
    if (!this.workingDirectoryProjectionHandle && this.ctx?.sessionProjections) {
      try { await this[Service.init]?.() } catch {}
    }
    if (!this.workingDirectoryProjectionHandle) {
      return this.get(agent?.session)
    }
    return origEnsure.call(this, agent, signal)
  }
}

if (typeof ToolRuntime?.prototype?.selectExecutor === 'function') {
  const origSelectExecutor = ToolRuntime.prototype.selectExecutor
  ToolRuntime.prototype.selectExecutor = function (scope) {
    try {
      return origSelectExecutor.call(this, scope)
    } catch (err) {
      if (err?.code === 'TOOL_EXECUTOR_UNAVAILABLE' || err?.name === 'ToolExecutorUnavailableError') {
        return new NativeToolExecutor(this.ctx)
      }
      throw err
    }
  }
}

if (typeof ToolRuntime?.prototype?.modeFor !== 'function') {
  ToolRuntime.prototype.modeFor = function (scope) {
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

if (typeof ToolRuntime?.prototype?.execute === 'function') {
  const origExecute = ToolRuntime.prototype.execute
  ToolRuntime.prototype.execute = async function (input) {
    const isSingle = input && !input.calls && (input.name !== undefined || input.callId !== undefined)
    if (isSingle) {
      const call = {
        id: input.callId ?? 'call-1',
        name: input.name,
        arguments: input.arguments,
      }
      const batchResult = await origExecute.call(this, { ...input, calls: [call] })
      const first = batchResult?.results?.[0]?.result ?? batchResult?.results?.[0]
      return first ?? batchResult
    }
    return origExecute.call(this, input)
  }
}

try {
  const EventsService = new Context().events?.constructor
  if (typeof EventsService?.prototype?.waterfall === 'function') {
    const origWaterfall = EventsService.prototype.waterfall
    EventsService.prototype.waterfall = function (...args) {
      const name = typeof args[0] === 'string' ? args[0] : typeof args[1] === 'string' ? args[1] : undefined
      if (name === 'agent/pre-step') {
        const payload = typeof args[0] === 'object' && args[0] !== null ? args[0] : typeof args[1] === 'object' && args[1] !== null ? args[1] : undefined
        if (payload && !payload.modelSelection && payload.agent) {
          return loadModelRoute().then(({ sessionModelRoute }) => {
            const route = sessionModelRoute(payload.agent)
            payload.modelSelection = {
              provider: route.provider ?? payload.agent.options?.provider ?? 'deepseek-official',
              model: route.model ?? payload.agent.options?.model ?? 'deepseek-chat',
              ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
            }
            return origWaterfall.apply(this, args)
          })
        }
      }
      // 仅异步的 agent/pre-step 等待模块；llm/stream、设置更新等事件保持原有返回类型。
      return origWaterfall.apply(this, args)
    }
  }
} catch {}

if (typeof AgentRegistry?.prototype?.setFactory === 'function') {
  const origSetFactory = AgentRegistry.prototype.setFactory
  AgentRegistry.prototype.setFactory = function (factory) {
    if (this.factory !== undefined) {
      const target = factory?.[symbols.original] ?? factory
      if (this.factory.target === target) return () => {}
    }
    return origSetFactory.call(this, factory)
  }
}

if (typeof AgentRegistry?.prototype?.requireFactory === 'function') {
  const origRequireFactory = AgentRegistry.prototype.requireFactory
  AgentRegistry.prototype.requireFactory = function () {
    if (!this.factory && this.ctx?.agentLoop) {
      try { this.setFactory(this.ctx.agentLoop) } catch {}
    }
    return origRequireFactory.call(this)
  }
}

if (typeof AgentLoop?.prototype?.initializeAgent === 'function') {
  const origInitializeAgent = AgentLoop.prototype.initializeAgent
  AgentLoop.prototype.initializeAgent = async function (ownerCtx, options) {
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
    const machine = result?.agent ?? result?.[0]
    if (machine) {
      const { ensureAgentRequestSelectionSync } = await loadModelRoute()
      ensureAgentRequestSelectionSync(machine)
    }
    return result
  }
}

if (typeof AgentRegistry?.prototype?.turnBoundaryOf === 'function') {
  const origTurnBoundaryOf = AgentRegistry.prototype.turnBoundaryOf
  AgentRegistry.prototype.turnBoundaryOf = function (session) {
    if (this.turnBoundaryProjectionHandle) {
      return origTurnBoundaryOf.call(this, session)
    }
    let state = {
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
`
      },
      transform(code, id) {
        if (id.replace(/\\/g, '/').endsWith('/test/setupComputeWorkers.ts')) {
          return { code: `import '\\0dsh-test-harness-compat';\n${code}`, map: null }
        }
        return null
      },
    },
  ],
  test: {
    // 只收集仓库 test/；.tmp 等被忽略目录里的旧版冒烟副本不能混进本地全量运行。
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setupComputeWorkers.ts'],
    // 显式配置 reporter 时默认的 GitHub 注解不会自动追加，必须一并保留。
    reporters: process.env.GITHUB_ACTIONS === 'true' ? [
      'default', 'github-actions',
      'json',
      ['junit', { includeConsoleOutput: false }],
    ] : configDefaults.reporters,
    // 放在全局选项，保留 CLI --outputFile.json/junit 对并行本地诊断的覆盖能力。
    outputFile: { json: '.vitest/results.json', junit: '.vitest/junit.xml' },
    // CI 共享机器串行运行文件，避免多个 QuickJS 实例争抢 CPU 耗尽产品的墙钟预算。
    maxWorkers: process.env.CI ? 1 : Math.min(4, availableParallelism()),
    // 集成用例会依次启动多个 worker；整条用例的时限独立于每次隔离计算的产品限额。
    testTimeout: 15_000,
  },
})
