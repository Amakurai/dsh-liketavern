/** 同一隔离器内完成模板预处理、主动激活与提示词组装；重组只重放来源，定时器从同一轮初快照计算。 */
import { assemblePrompt, isDeltaRenderedInTurn } from '../core/assemble.js'
import { evaluateWorldInfo, isStandingSafeEntry } from '../core/worldbook.js'
import { createTurnRandom, expandMacros } from '../core/macros.js'
import { estimateTokens } from '../core/tokenize.js'
import { clipWorldDeltasForTurn } from '../core/turnBudget.js'
import { normalizeTemplateLore, templateLoreEntries } from '../core/templateLore.js'
import type { WorldInfoEntry } from '../core/types.js'
import type { ComputeJobs } from './computeWorker.js'
import type { TemplateSandbox } from './templateSandbox.js'
import { parseTemplatePlacement } from '../core/templatePlacement.js'
import { applyTemplatePlacements } from './templatePlacement.js'
import type { WIEngineResult } from '../core/types.js'
import { finalizeTemplateOutlets } from './templateOutlets.js'
import { createTemplateGeneration, validateTemplateGenerationBudget } from './templateGeneration.js'

export function assembleTemplatePlan(input: ComputeJobs['assemble']['input'], sandbox: TemplateSandbox | null): ComputeJobs['assemble']['output'] {
  sandbox?.setOutletsDeferred(true)
  const generationRegexCache=new Map<string,string>()
  const baseMacroCtx = {
    ...input.macroCtx,
    description: input.macroCtx.description ?? input.card?.description ?? '',
    personality: input.macroCtx.personality ?? input.card?.personality ?? '',
    scenario: input.macroCtx.scenario ?? input.card?.scenario ?? '',
    persona: input.macroCtx.persona ?? input.personaDescription,
    firstMessage: input.macroCtx.firstMessage ?? input.card?.firstMes ?? '',
    charVersion: input.macroCtx.charVersion ?? input.card?.characterVersion ?? '',
    creatorNotes: input.macroCtx.creatorNotes ?? input.card?.creatorNotes ?? '',
    charDepthPrompt: input.macroCtx.charDepthPrompt ?? input.card?.depthPrompt?.prompt ?? '',
    mesExamples: input.macroCtx.mesExamples ?? input.card?.mesExample ?? '',
    charPrompt: input.promptPreferences?.preferCharacterPrompt === false ? '' : input.macroCtx.charPrompt ?? input.card?.systemPrompt ?? '',
    charInstruction: input.promptPreferences?.preferCharacterInstructions === false ? '' : input.macroCtx.charInstruction ?? input.card?.postHistoryInstructions ?? '',
  }
  const evaluation = input.wiEvaluation
  if (!evaluation) {
    const turnMacroCtx = { ...baseMacroCtx, store: new Map(input.macroCtx.store), random: createTurnRandom(input.seed) }
    let assembled=assemblePrompt({ ...input, estimateTokens,
    ...(sandbox ? createTemplateGeneration(sandbox,[],turnMacroCtx,generationRegexCache) : {}),
    macroCtx:turnMacroCtx })
    if(sandbox) {
      assembled=finalizeTemplateOutlets(assembled,sandbox,input.budget.maxTokens-input.budget.reserveForOutput)
      validateTemplateGenerationBudget(assembled,input.budget.maxTokens-input.budget.reserveForOutput)
      sandbox.setOutletsDeferred(false)
    }
    return {...assembled,...(sandbox ? {templateVariables:sandbox.variables()} : {})}
  }

  const macroCtx = {...baseMacroCtx,store:new Map(input.macroCtx.store),random:createTurnRandom(input.seed)}
  const normalizedEntries = evaluation.entries.map(normalizeTemplateLore)
  // 必须在条件求值、预处理及 WI 命中筛选之前收集写入来源。未命中的来源以后仍可能
  // 修改同名变量，若仅观察本轮激活结果，首轮空/default 读取会被 standing pin 留住。
  const potentialMacroSources = normalizedEntries.map(entry => ({ text: entry.content,
    turnLocal: !entry.enabled || !isStandingSafeEntry(entry) || Boolean(entry.templateCondition
      || entry.templatePreprocessing || parseTemplatePlacement(entry.comment)) }))
  const entries = normalizedEntries.map(entry=> {
    const preprocessing = entry.enabled && !entry.templateDontActivate && (entry.templatePreprocessing || /^\[Preprocessing\]/i.test(entry.comment))
    if (!preprocessing) return entry
    // 预处理条目没有 EJS 时也曾被 needsTemplates 漏判；缺沙箱必须明确失败，不能静默跳过预处理。
    if (!sandbox) throw new Error(`世界书「${entry.comment}」需要模板预处理，但本轮没有可用的模板沙箱`)
    if (entry.templateCondition && !sandbox.condition(entry.templateCondition)) return {...entry,enabled:false}
    const render = (text:string,source:string) => expandMacros(sandbox.renderSource(expandMacros(text,macroCtx),source),macroCtx)
    return {...entry,
      templateCondition:undefined,
      content:`<% /* preprocessed */ %>${render(entry.content,entry.key)}`,
      keys:entry.keys.map((text,i)=>render(text,`${entry.key}:key:${i}`)),
      secondaryKeys:entry.secondaryKeys.map((text,i)=>render(text,`${entry.key}:secondary:${i}`)),
    }
  })
  let requests = sandbox?.activationRequests() ?? []
  // 最多每个条目请求一次，force 最多升级一次；其它条件不允许制造无限轮次。
  for (let attempt=0; attempt<entries.length*2+4; attempt++) {
    const requested = new Map(requests.map(item=>[item.key,item.force]))
    const selected = templateLoreEntries(entries.map((entry): WorldInfoEntry=> {
      if (entry.templateDontActivate) return {...entry,enabled:false}
      const force = requested.get(entry.key)
      let value = force===undefined ? entry : {...entry,enabled:entry.enabled || force,constant:true,
        useProbability:force ? false : entry.useProbability,
        content:`<% /* activewi */ %>${entry.content}`}
      if (value.enabled && value.templateCondition) {
        value = sandbox!.condition(value.templateCondition)
          ? {...value,content:`<% /* conditional lore */ %>${value.content}`} : {...value,enabled:false}
      }
      return value
    }))
    const wi = evaluateWorldInfo({...evaluation,entries:selected,estimateTokens,random:createTurnRandom(evaluation.seed)})
    const activatedDeltaIds = new Set(wi.activated.filter(a=>a.entry.source==='delta').map(a=>a.entry.uid))
    const deltaClip = clipWorldDeltasForTurn(input.worldDeltas.filter(d=>isDeltaRenderedInTurn(d,activatedDeltaIds)),estimateTokens)
    const placements=wi.activated.filter(a=>parseTemplatePlacement(a.entry.comment)).map(a=>a.entry)
    const ordinary=(acts:WIEngineResult['activated'])=>acts.filter(a=>!parseTemplatePlacement(a.entry.comment))
    const regularWi:WIEngineResult={...wi,
      byPosition:Object.fromEntries(Object.entries(wi.byPosition).map(([key,acts])=>[key,ordinary(acts)])),
      outlets:Object.fromEntries(Object.entries(wi.outlets).map(([key,acts])=>[key,ordinary(acts)])),
    }
    const attemptMacroCtx = {...baseMacroCtx,store:new Map(macroCtx.store),random:createTurnRandom(input.seed)}
    const assemblyInput = {...input,wi:regularWi,worldDeltas:deltaClip.kept,estimateTokens,potentialMacroSources,
      ...(sandbox ? createTemplateGeneration(sandbox,placements,attemptMacroCtx,generationRegexCache) : {}),
      macroCtx:attemptMacroCtx } satisfies Parameters<typeof assemblePrompt>[0]
    let assembled = assemblePrompt(assemblyInput)
    const next = sandbox?.activationRequests() ?? []
    if (JSON.stringify(next)!==JSON.stringify(requests)) {requests=next;continue}
    const insertions=placements.filter(entry=>parseTemplatePlacement(entry.comment)?.kind==='insert')
    if(insertions.length) {
      if(!sandbox) throw new Error('定位注入需要模板沙箱')
      assembled=applyTemplatePlacements(assembled,insertions,sandbox,attemptMacroCtx,input.budget.maxTokens-input.budget.reserveForOutput)
      const next=sandbox.activationRequests()
      if(JSON.stringify(next)!==JSON.stringify(requests)) {requests=next;continue}
    }
    if(sandbox) {
      assembled=finalizeTemplateOutlets(assembled,sandbox,input.budget.maxTokens-input.budget.reserveForOutput)
      validateTemplateGenerationBudget(assembled,input.budget.maxTokens-input.budget.reserveForOutput)
      sandbox.setOutletsDeferred(false)
    }
    return {...assembled,evaluatedWi:wi,deltaDropped:deltaClip.dropped,
      ...(sandbox ? {templateVariables:sandbox.variables(),templateRegexRules:sandbox.regexDescriptors(),templateHasMessageRegex:sandbox.hasMessageRegex()} : {})}
  }
  throw new Error('模板世界书主动激活未收敛')
}
