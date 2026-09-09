/**
 * client 侧共享类型：remote 方法签名（结果类型一律索引 src/remote.ts 的 TavernMethodResults，
 * 与 src/node/service.ts 的实现共用单一来源）、以及插件入口所需的最小 cordis Context 形状
 * （宿主经 declaration merging 注入的 slots/remote/locale 服务在此以结构化类型描述，避免依赖宿主包的类型）。
 */
import type { TavernMethodResults, TavernMethodRequests } from '../remote.js'
import type { SessionBinding as HostSessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'

// 契约共享形状：从唯一定义处 re-export，本文件不再保留手写副本。
export type { CharacterSummary } from '../state/workspace.js'
export type { Persona } from '../core/persona.js'
export type { SessionBinding } from '../core/binding.js'
export type { CharacterDetail, CharacterInspect, PresetSummary } from '../remote.js'

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 设置命名空间 dsh-tavern 的原始（schemastery 解析后）形状；单一来源是 host 侧 TavernConfigRaw；maxTokens 为数字，0 = 不限。 */
export type TavernSettings = TavernMethodResults['getSettings']['settings']

export const EMPTY_SESSION_DEFAULTS: TavernSettings['defaults'] = {
  cardId: '',
  presetId: '',
  personaId: '',
  lorebookIds: [],
  characterLorebookId: '',
}

/**
 * remote 调用镜像：请求形状按方法声明（与 remote.ts 的 req schema 对应），
 * 结果一律索引 TavernMethodResults——service 改返回形状时这里自动跟随，消费点编译报错。
 */
export type TavernRemote = {
  [K in keyof TavernMethodResults]: (req: TavernMethodRequests[K]) => Promise<Envelope<TavernMethodResults[K]>>
}

export interface SlotsLike {
  register(options: Record<string, unknown>, component: unknown): () => void
  /** 等待 slot 声明可用后再注册（参照 ui-message-feedback）；声明崩塌时自动重挂。 */
  inject?(name: string, factory: () => (() => void) | void): () => void
}

export interface LocaleLike {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  /** 宿主界面语言快照（0.1.2 的 LocaleRuntime）；auto 档据此跟随。 */
  getSnapshot?(): { active: string }
  subscribe?(fn: () => void): () => void
}

/** 插件入口所见的最小 Context。 */
export interface ClientContext {
  remote: { $mount(remote: unknown): Promise<unknown> } & Record<string, unknown>
  slots: SlotsLike
  locale: LocaleLike
  /** dsh-client-runtime 的会话运行时：open 跳转；refresh 把 fork 子会话拉进列表后再 open。 */
  sessions: {
    open(id: string): void
    refresh?: () => Promise<void>
    /** 当前已保留会话的公开同步事件源；不借此打开会话或读取后台历史。 */
    binding?(id: string): (Pick<HostSessionBinding, 'sessionId' | 'eventSource'> & { session?: Pick<HostSessionBinding['session'], 'cancel'> }) | undefined
    /** 会话列表快照 store（含 current；预设 id 在 projectionValues.agentPreset）；seatWatch 与 assistant-step 显隐据此判断。 */
    list: {
      getSnapshot(): {
        current: string | undefined
        byId: Record<string, { projectionValues?: { agentPreset?: string | null } } | undefined>
      }
      subscribe(fn: () => void): () => void
    }
    /** 宿主 ISessions 的命名路径（scope → sessionOf → rename）；旧宿主缺省时跳过改名。 */
    scope?(id: string): unknown
    sessionOf?(ctx: unknown): { rename(title: string): Promise<unknown> } | undefined
  }
  /** 工作区运行时；「新对话」动作 0.1.2 起迁到 uiWorkspace 服务（seatWatch 经 ctx.get 读取）。 */
  workspaces: { startSession?(workspaceId?: string): void }
  effect(fn: () => void | (() => void), label?: string): void
  /** cordis reflect.get：不做 inject 检查，用于读取自行 $mount 的 remote.<ns> 子服务。 */
  get(name: string): unknown
  on?(event: string, listener: (...args: unknown[]) => void): void
}
