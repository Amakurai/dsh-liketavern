/**
 * 无会话 hero 上选择「Tavern 模式」的补偿器。
 *
 * 宿主的预设 seat（dsh-client-ui-agent-preset）在没有 current 会话时只把选择暂存
 * （staged，chip 立即回显「Tavern 模式」，但不发 RPC、不建会话）；要再点一次
 * 「新对话」让会话成为 current，暂存的选择才落地。表现为：选了模式，英雄区的
 * 角色卡选择器（conversation.input.dock，session 作用域，无会话时不渲染）不出现。
 *
 * 这里监听 seat chip 的文案变化：一旦它从无变为显示「Tavern 模式」且当前仍无会话，
 * 就代为调用 workspaces.startSession()（与侧边栏「新对话」同一动作）。会话出现后
 * 宿主 seat 的 list 订阅会自动把暂存的 tavern 预设应用上去，dock 英雄区随即渲染。
 *
 * DOM 耦合点（宿主升级后若失效，最坏退回「需要再点一次新对话」的原行为）：
 * - seat chip = button[aria-haspopup="menu"] 且 title 为 seatHint 的中/英文案；
 * - 选中文案 = presets/tavern/preset.yml 的 name（宿主原样显示，不做本地化）。
 */
import type { ClientContext } from './types.js'

/** 与 presets/tavern/preset.yml 的 name 保持一致。 */
const TAVERN_SEAT_LABEL = 'Tavern 模式'

/** 宿主 seatHint 的中英文案（dsh-client-ui-agent-preset 的 locale 表）。 */
const SEAT_HINTS = ['即将开始的这个会话所用的 Agent 预设', 'Agent preset for the session you are about to start']

/** seat chip 当前是否显示 Tavern 预设；null = chip 尚未渲染（含 title 被错误信息顶替）。 */
function seatShowsTavern(): boolean | null {
  const chips = document.querySelectorAll('button[aria-haspopup="menu"]')
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i]
    if (chip && SEAT_HINTS.includes(chip.getAttribute('title') ?? '')) {
      return (chip.textContent ?? '').includes(TAVERN_SEAT_LABEL)
    }
  }
  return null
}

/** 安装监听；返回清理函数（挂进 ctx.effect）。 */
export function installTavernSeatWatch(ctx: ClientContext): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  let baselineDone = false
  let lastTavern = false
  let coolingDown = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let observer: MutationObserver | undefined

  const check = () => {
    timer = undefined
    const tavern = seatShowsTavern()
    if (tavern === null) return // chip 不在树上：保持上次状态，不算变化
    if (!baselineDone) {
      // 首次只建基线：刷新页面且 tavern 本就是默认预设时不能自动开会话。
      baselineDone = true
      lastTavern = tavern
      return
    }
    if (tavern === lastTavern) return
    lastTavern = tavern
    if (!tavern || coolingDown) return
    if (ctx.sessions.list.getSnapshot().current !== undefined) return // 已有会话：宿主自己会处理
    coolingDown = true
    setTimeout(() => {
      coolingDown = false
    }, 1500)
    try {
      // 0.1.2 起「新对话」动作从 ctx.workspaces 迁到 ctx.uiWorkspace（IWorkspaces 已移除
      // startSession）；旧宿主回退 workspaces。两者都缺席时静默，用户仍可手动点。
      // 保持方法调用形态（宿主控制器方法依赖 this）。
      const uiWorkspace = ctx.get('uiWorkspace') as { startSession?: () => void } | undefined
      if (uiWorkspace && typeof uiWorkspace.startSession === 'function') uiWorkspace.startSession()
      else ctx.workspaces.startSession?.()
    } catch {
      // 与宿主「新对话」一致：失败静默（无工作区/基线未就绪），用户仍可手动点。
    }
  }

  // 流式输出期间 DOM 变动频繁，合并到一个短窗口内检查一次。
  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(check, 200)
  }

  const start = () => {
    if (observer || !document.body) return
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    schedule() // 建立基线
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
  return () => {
    document.removeEventListener('DOMContentLoaded', start)
    observer?.disconnect()
    if (timer !== undefined) clearTimeout(timer)
  }
}
