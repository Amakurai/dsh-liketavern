/** worker 的纯计算入口；不读取工作区，不接触宿主、会话或网络。 */
import { parentPort, workerData } from 'node:worker_threads'
import { assemblePrompt } from '../core/assemble.js'
import { evaluateWorldInfo } from '../core/worldbook.js'
import { applyRegexRules } from '../core/regex.js'
import { createTurnRandom } from '../core/macros.js'
import { estimateTokens } from '../core/tokenize.js'
import type { MacroContext, WorldInfoEntry } from '../core/types.js'
import type { TemplateContext, TemplateScopes, TemplateRegexDescriptor } from '../core/template.js'
import { normalizeTemplateLore } from '../core/templateLore.js'
import { assembleTemplatePlan } from './templatePlan.js'
import { parseTemplatePlacement } from '../core/templatePlacement.js'
import type { TemplateReplay } from '../core/templateReplay.js'
import type { TemplateMessageVariables } from '../core/templateMessageVariables.js'
import type { TemplateDisplayPart } from '../core/templateDisplay.js'
import { renderTemplateDisplay, presentTemplateDisplay } from './templateDisplay.js'
import type { TemplateContinuation } from '../core/templateContinuation.js'
import { prepareContinuedTemplate,exportTemplateContinuation } from './templateContinuation.js'
import { parseTemplateContinuation,templatePreloadRevision } from '../state/templateContinuation.js'
import { templateReplayGenerationContext } from '../core/templateReplay.js'

type SerializableMacros = Omit<MacroContext, 'random' | 'onUnknown'>
export interface ComputeJobs {
  assemble: {
    input: Omit<Parameters<typeof assemblePrompt>[0], 'estimateTokens' | 'macroCtx' | 'renderTemplate' | 'transformPrompt'> & { macroCtx: SerializableMacros; seed: number; templates?: TemplateContext; templateContinuation?:TemplateContinuation; wiEvaluation?: ComputeJobs['wi']['input'] }
    output: ReturnType<typeof assemblePrompt> & { templateVariables?: TemplateScopes; templateMessageVariables?:TemplateMessageVariables; templateRegexRules?: TemplateRegexDescriptor[]; templateHasMessageRegex?: boolean; templateReplay?:TemplateReplay; templateContinuation?:TemplateContinuation; evaluatedWi?: ReturnType<typeof evaluateWorldInfo>; deltaDropped?: number }
  }
  wi: {
    input: Omit<Parameters<typeof evaluateWorldInfo>[0], 'estimateTokens' | 'random'> & { seed: number; templates?: TemplateContext }
    output: ReturnType<typeof evaluateWorldInfo>
  }
  render: {
    input: { text: string; rules: Parameters<typeof applyRegexRules>[1]; macroCtx: SerializableMacros }
    output: ReturnType<typeof applyRegexRules>
  }
  template: {
    input: { texts: string[]; context: TemplateContext; decorateOutput?: boolean; replay?:TemplateReplay; templateContinuation?:TemplateContinuation }
    output: { texts: string[]; parts:TemplateDisplayPart[][]; variables: TemplateScopes; messageVariables:TemplateMessageVariables; templateContinuation?:TemplateContinuation }
  }
  display: {
    input: {parts:TemplateDisplayPart[];rules:Parameters<typeof applyRegexRules>[1];macroCtx:SerializableMacros}
    output: {parts:TemplateDisplayPart[]}
  }
}

if (parentPort) {
  try {
    const { kind, input } = workerData
    const needsTemplates = kind === 'template' || kind === 'wi' && input.templates && input.entries.some((e: {templateCondition?: string}) => e.templateCondition)
      || kind === 'assemble' && input.templates
      && (input.templateContinuation || input.templates.historyIdentities?.length || JSON.stringify(input).includes('<%') || JSON.stringify(input).includes('{{outletPromptsInjected:') || input.templates.entries.some((raw:WorldInfoEntry) => {
        const entry=normalizeTemplateLore(raw)
        return entry.enabled && (entry.templatePreload || entry.templateCondition || parseTemplatePlacement(entry.comment)
          || /^\[(InitialVariables|RENDER:BEFORE|RENDER:AFTER)\]/i.test(entry.comment))
      }))
    const templateClass = needsTemplates ? (await import('./templateSandbox.js')).TemplateSandbox : null
    // 依赖装载属于 worker 启动预算；第三方 YAML/JS 在 ready 后才开始计算预算。
    await templateClass?.prepare()
    parentPort.postMessage({ ready: true })
    let value: unknown
    if (kind === 'assemble') {
      const sandbox = templateClass ? await prepareContinuedTemplate(templateClass,input.templates,input.templateContinuation) : null
      try {
        const assembled=assembleTemplatePlan(input,sandbox)
        sandbox?.sticky('finish')
        value={...assembled,...(sandbox ? {templateReplay:sandbox.replay(),templateMessageVariables:sandbox.messageVariables(),
          templateContinuation:exportTemplateContinuation(sandbox,input.templates),templateRegexRules:sandbox.regexDescriptors(),templateHasMessageRegex:sandbox.hasMessageRegex()} : {})}
      } finally { sandbox?.dispose() }
    }
    else if (kind === 'template') {
      const continuation=input.templateContinuation && parseTemplateContinuation(input.templateContinuation)
      if(continuation && (!input.replay || continuation.preloadRevision!==templatePreloadRevision(templateReplayGenerationContext(input.replay))
        || continuation.replay && JSON.stringify(continuation.replay)!==JSON.stringify(input.replay))) throw new Error('回复 sticky 状态与生成日志不一致')
      const sandbox = input.replay ? await templateClass!.restore(input.replay,input.context) : await templateClass!.create(input.context)
      try {
        if(continuation && JSON.stringify(continuation.state)!==JSON.stringify(sandbox.stickyState())) throw new Error('回复 sticky 注册表与已提交状态不一致')
        const entries = (input.context as TemplateContext).entries.map(normalizeTemplateLore)
        const rendered=input.texts.map((text: string,index:number) => {
          const meta=sandbox.setMessageContext(input.context.renderMessages?.[index] ?? null)
          if(input.context.phase==='render') return renderTemplateDisplay(text,entries,sandbox,meta,Boolean(input.decorateOutput))
          const rendered=sandbox.resolveOutlets(sandbox.render(text))
          return {text:rendered,parts:[{kind:'markdown' as const,text:rendered}]}
        })
        value = { texts:rendered.map((result:{text:string})=>result.text),parts:rendered.map((result:{parts:TemplateDisplayPart[]})=>result.parts),variables:sandbox.variables(),messageVariables:sandbox.messageVariables(),
          ...(input.templateContinuation ? {templateContinuation:{...exportTemplateContinuation(sandbox,input.context,true),preloadRevision:input.templateContinuation.preloadRevision}} : {}) }
      }
      finally { sandbox.dispose() }
    }
    else if (kind === 'wi') {
      const sandbox = templateClass ? await templateClass.create(input.templates) : null
      try {
        const entries = input.entries.map((entry: import('../core/types.js').WorldInfoEntry) => {
          if (!entry.enabled || !entry.templateCondition) return entry
          if (!sandbox!.condition(entry.templateCondition)) return { ...entry, enabled:false }
          return { ...entry, content:`<% /* conditional lore */ %>${entry.content}` }
        })
        value = evaluateWorldInfo({ ...input, entries, estimateTokens, random: createTurnRandom(input.seed) })
      } finally { sandbox?.dispose() }
    }
    else if (kind === 'render') value = applyRegexRules(input.text, input.rules, { scope: 'output', timing: 'render' }, input.macroCtx)
    else if (kind === 'display') value = {parts:presentTemplateDisplay(input.parts,input.rules,input.macroCtx)}
    else throw new Error('未知提示词任务')
    if (JSON.stringify(value).length > 16 * 1024 * 1024) throw new Error('提示词计算结果超过 16 MiB 上限')
    parentPort.postMessage({ value })
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
