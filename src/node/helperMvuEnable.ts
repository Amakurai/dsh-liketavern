/**
 * 开启本会话原生 MVU。follow 只处理从未表态的绑定：会话启用的脚本含官方 MVU 入口即视为卡片作者要求变量更新；
 * explicit 是用户在设置中点选开启。两者都经 runHelperMvuEnable 认领宿主真正 idle 后保存，
 * 保存前在绑定锁内复核剧情与表态；显式关闭（false）不会被跟随模式改写。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '../core/binding.js'
import { hasNativeMvuEntry } from '../core/cardScript.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { runHelperMvuEnable } from './helperMvuLifecycle.js'
import { sessionHelperLibraries } from './helperRuntime.js'
import type { TavernState } from './state.js'

export type HelperMvuEnableMode = 'follow' | 'explicit'
export interface HelperMvuEnableResult { enabled: boolean; changed: boolean }
type Verdict = { kind: 'on' | 'skip' } | { kind: 'enable'; binding: SessionBinding }

export async function enableHelperMvu(ctx: Context, state: TavernState, request: { sessionId: string; storyId: string; mode: HelperMvuEnableMode }): Promise<HelperMvuEnableResult> {
  const check = async (): Promise<Verdict> => {
    const binding = await state.loadBinding(request.sessionId)
    if (!binding?.storyId || binding.storyId !== request.storyId) throw new Error('会话剧情绑定已改变，请刷新后重试')
    if (binding.helperMvu === true) return { kind: 'on' }
    if (!state.config.interactiveCards || binding.interactiveCards === false) {
      if (request.mode === 'explicit') throw new Error('交互卡已关闭，不能开启原生 MVU')
      return { kind: 'skip' }
    }
    if (request.mode === 'follow' && (binding.helperMvu === false || !hasNativeMvuEntry(await sessionHelperLibraries(state, binding)))) return { kind: 'skip' }
    return { kind: 'enable', binding }
  }
  const outcome = (verdict: Verdict): HelperMvuEnableResult => ({ enabled: verdict.kind === 'on', changed: false })
  const first = await check()
  if (first.kind !== 'enable') return outcome(first)
  return runHelperMvuEnable(ctx, state, request.sessionId, () => withWorkspaceLock(state.paths.sessions, async () => {
    // 等待 idle 期间用户可能已换卡、关闭或另一页面已开启；以锁内复核为准。
    const current = await check()
    if (current.kind !== 'enable') return outcome(current)
    await state.saveBinding({ ...current.binding, helperMvu: true })
    return { enabled: true, changed: true }
  }))
}
