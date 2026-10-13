/** 活沙箱缓存只接受完整日志及会话身份完全相同的下一次恢复；命中即移交所有权，任何重试仍从持久日志冷恢复。 */
import { createHash } from 'node:crypto'
import type { TemplateContext } from '../core/template.js'
import type { TemplateReplay } from '../core/templateReplay.js'
import type { TemplateSandbox } from './templateSandbox.js'

export function templateWorkerCacheKey(replay: TemplateReplay | undefined, context: TemplateContext | undefined): string | undefined {
  if (!replay || !context) return undefined
  return createHash('sha256').update(JSON.stringify([context.sessionId ?? null,context.cardId ?? null,replay])).digest('hex')
}

export class TemplateWorkerCache {
  private current?: {key:string;sandbox:TemplateSandbox}

  get key():string|undefined {return this.current?.key}

  take(key:string|undefined,replay:TemplateReplay,resourceChars:number):TemplateSandbox|undefined {
    const current=this.current
    this.current=undefined
    if (!current) return undefined
    if (!key || current.key!==key) {current.sandbox.dispose();return undefined}
    try {current.sandbox.restartBudget(resourceChars);current.sandbox.verifyReplayState(replay);return current.sandbox}
    catch(error) {current.sandbox.dispose();throw error}
  }

  keep(sandbox:TemplateSandbox,replay:TemplateReplay,context:TemplateContext):string {
    this.clear()
    const key=templateWorkerCacheKey(replay,context)!
    this.current={key,sandbox}
    return key
  }

  clear():void {
    const current=this.current
    this.current=undefined
    current?.sandbox.dispose()
  }
}
