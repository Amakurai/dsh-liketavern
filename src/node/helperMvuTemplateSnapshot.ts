/** MVU 模板当前基准：按后台继承顺序读取本剧情原始聊天的最近有效变量，模型摘要不删除已保存状态。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { helperJson, helperRecord, type HelperScopes } from '../core/helperRuntime.js'
import type { TemplateVariables } from '../core/template.js'
import { helperHistoryOf } from './helperRuntime.js'

export function currentHelperMvuTemplateData(events: readonly SessionEvent[], scopes: HelperScopes): TemplateVariables | undefined {
  // 轮初尚无本轮目标 assistant；与 prepareHelperMvuJob 在目标之前倒序找 scope 一致，
  // 包括手动保存的用户消息变量。原生回执 lastIdentity 不能覆盖之后的新 scope。
  const history = helperHistoryOf(events, {char:'',user:''})
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index]!, data = scopes[JSON.stringify(['message', item.identity])]
    if (!helperRecord(data?.stat_data)) continue
    return helperJson(data.stat_data) as TemplateVariables
  }
  return undefined
}
