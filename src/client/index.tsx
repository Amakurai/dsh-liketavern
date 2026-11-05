/**
 * dsh-tavern 浏览器端入口。
 * 注册五块 UI：设置面板、assistant 操作条、会话头部角色 chip、
 * 新会话英雄区角色选择、对话区 assistant 消息排版；并注册 tavern 文案命名空间。
 *
 * conversation.chat.node / assistant-step 是 keyed 覆盖位：登记就会挡住原生
 * AssistantNodeView。因此只在当前会话是 Tavern 模式时才挂上，切走即卸掉。
 */
import type {Context} from '@deepseek-ai/cordis'
import type {IConversation} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {installChoiceInput} from './helperChoices.js'
import { TYPERT_REMOTE } from '../remote.js'
import { TavernFloorActions } from './actions.js'
import { TavernAssistantNode } from './assistant.js'
import { TavernTurnTrigger } from './trigger.js'
import { TavernHeaderChip } from './chip.js'
import { TavernHeroCharacter } from './hero.js'
import { setSpeakerHeader } from './displayPrefs.js'
import { setTavernHostLocale, setTavernLocale } from './i18n.js'
import { en, zh } from './locales.js'
import { createSessionsPort } from './navigation.js'
import { sessionViews } from './sessionViews.js'
import { installHelperLiveEvents } from './helperLiveEvents.js'
import { TavernPanel } from './panel/index.js'
import { installTavernSeatWatch } from './seatWatch.js'
import type { ClientContext, TavernRemote } from './types.js'

export const name = 'dsh-tavern-client'

// 注意：不能声明 'remote.tavern' —— 该服务由下方 $mount 在 apply 内自行安装，
// 注入声明会让加载器在 apply 前等待一个尚不存在的服务（死锁）。安装后经
// ctx.get('remote.tavern') 读取（reflect.get 不做 inject 检查），
// 也不要写 ctx.remote.tavern（追踪代理会按点路径检查 inject）。
export const inject = ['slots', 'remote', 'locale', 'sessions', 'workspaces']

export async function apply(ctx: ClientContext) {
  // 宿主 client API 版本不设限（package.json engines.dsh = *），因此每一块 UI 独立注册：
  // 某一块 slot 或服务在老/新宿主上消失时只跳过该块，不中断其余面板。
  const warn = (label: string, error: unknown) => {
    const text = `dsh-tavern: ${label} 已跳过（宿主界面接口可能已变更）：${error instanceof Error ? error.message : String(error)}`
    try { (ctx as unknown as { logger?: { warn?(m: string): void } }).logger?.warn?.(text) } catch { /* 日志失败不再制造失败 */ }
    if (!(ctx as unknown as { logger?: unknown }).logger) console.warn(text)
  }
  const guard = <T,>(label: string, run: () => T): T | undefined => {
    try { return run() } catch (error) { warn(label, error); return undefined }
  }

  // $mount 的返回值不作为成功信号：宿主可能返回 disposer、也可能什么都不返回。
  let mountError: unknown
  try { await ctx.remote.$mount(TYPERT_REMOTE) } catch (error) { mountError = error }
  if (mountError !== undefined) { warn('remote 挂载', mountError); return }
  const remote = ctx.get('remote.tavern') as TavernRemote
  const sessions = createSessionsPort(ctx)
  ctx.effect(()=>installChoiceInput(sessionId=>{
    if(!sessionViews.isTavernSessionShown(sessionId))return undefined
    const scope=sessions.scope?.(sessionId)
    const conversation=ctx.get('conversation') as IConversation|undefined
    return scope&&conversation?.input?conversation.input.for(scope as Context):undefined
  }),'dsh-tavern: choice input')
  /** 使用宿主公开取消动作；其 keepInbox 语义保留待处理输入，也可以终止空闲维护等待。 */
  const cancelWaiting = (sessionId: string): (() => Promise<void>) | undefined => {
    const face = sessions.binding?.(sessionId)?.session
    if (!face) return undefined
    return async () => {
      const result = await face.cancel()
      if (!result.ok) throw new Error(result.error.message)
    }
  }

  // 界面语言与消息显示偏好在挂载 slot 前播种（持久化于 dsh-tavern 设置），避免先英文或头像闪一下再切走。
  try {
    const result = await remote.getSettings({})
    if (result.ok) {
      setTavernLocale(result.value.settings.locale)
      setSpeakerHeader(result.value.settings.speakerHeader === true)
    }
  } catch {
    // 读取失败保持默认（auto 跟随宿主）。
  }

  // auto 档跟随宿主界面语言（0.1.2 的 LocaleRuntime 快照 + 订阅）。
  ctx.effect(() => {
    const sync = () => setTavernHostLocale(ctx.locale.getSnapshot?.().active ?? 'en')
    sync()
    return ctx.locale.subscribe?.(sync) ?? (() => {})
  }, 'dsh-tavern: host locale')

  ctx.effect(() => {
    try { return ctx.locale.register('tavern', { zh, en }) } catch (error) { warn('文案命名空间', error); return () => {} }
  }, 'dsh-tavern: locale')

  // 无会话 hero 上选「Tavern 模式」时自动补一次「新对话」，让暂存的模式选择落地。
  guard('seat watch', () => ctx.effect(() => installTavernSeatWatch(ctx), 'dsh-tavern: seat watch'))
  guard('helper live events', () => ctx.effect(() => installHelperLiveEvents(sessions, remote), 'dsh-tavern: helper live events'))

  /** slot 声明可能尚未就位（插件加载顺序），优先经 slots.inject 延迟注册。 */
  const mount = (slotName: string, options: Record<string, unknown>, component: unknown) => {
    try {
      if (typeof ctx.slots.inject === 'function') {
        ctx.slots.inject(slotName, () => ctx.slots.register({ ...options, name: slotName }, component))
      } else {
        ctx.effect(() => ctx.slots.register({ ...options, name: slotName }, component), `dsh-tavern: slot ${slotName}`)
      }
    } catch (error) {
      warn(`slot ${slotName}`, error)
    }
  }

  // A. 设置面板（root 作用域；导入卡/预设不依赖当前会话模式）
  mount('settings.section', { id: 'tavern', order: 50, label: 'Tavern', inject: () => ({ remote, sessions }) }, TavernPanel)

  // B. assistant 消息操作条（session 作用域；组件内再按 Tavern 模式显隐）
  mount(
    'conversation.chat.assistant-actions',
    { id: 'tavern-floors', order: 20, inject: (sessionId: string) => ({ remote, sessionId, sessions }) },
    TavernFloorActions,
  )

  // C. 会话头部角色 chip（session 作用域；对话开始后可见）
  mount(
    'conversation.session.header.actions',
    { id: 'tavern-binding', order: 20, inject: (sessionId: string) => ({ remote, sessionId, sessions, onCancel: cancelWaiting(sessionId) }) },
    TavernHeaderChip,
  )

  // D. 新会话英雄区：芯片并入 workspace 行，开场白预览挂在输入框上方
  mount(
    'conversation.input.dock',
    { id: 'tavern-hero-character', order: -20, inject: (sessionId: string) => ({ remote, sessionId, sessions }) },
    TavernHeroCharacter,
  )

  // E. 对话区 assistant 消息：只在当前会话是 Tavern 时覆盖原生节点，否则卸掉让 dsh 自己画。
  ctx.effect(() => {
    let nodeDispose: (() => void) | undefined
    const applyNode = (want: boolean) => {
      if (want) {
        if (nodeDispose) return
        try {
          const assistant = ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'assistant-step',
              priority: -1,
              inject: (sessionId: string) => ({ remote, sessionId, sessions }),
            },
            TavernAssistantNode,
          )
          // 续写等合成指令唤醒的回合：宿主会把指令原文画成可展开行，这里换成简短说明（见 trigger.tsx）。
          const trigger = ctx.slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', priority: -1 }, TavernTurnTrigger)
          nodeDispose = () => { assistant(); trigger() }
        } catch (error) {
          nodeDispose = undefined
          warn('对话节点覆盖', error)
        }
      } else if (nodeDispose) {
        nodeDispose()
        nodeDispose = undefined
      }
    }
    // 宿主 0.1.7 不再公开当前会话；由会话头部与英雄区登记的显示状态决定是否接管。
    const sync = () => applyNode(sessionViews.currentTavernSession() !== undefined)
    if (typeof ctx.slots.inject === 'function') {
      return ctx.slots.inject('conversation.chat.node', () => {
        const unsub = sessionViews.subscribe(sync)
        sync()
        return () => {
          unsub()
          applyNode(false)
        }
      })
    }
    const unsub = sessionViews.subscribe(sync)
    sync()
    return () => {
      unsub()
      applyNode(false)
    }
  }, 'dsh-tavern: assistant-step')
}
