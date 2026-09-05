/** 同一隔离器内完成模板预处理、主动激活与提示词组装；重组只重放来源，定时器从同一轮初快照计算。 */
import { assemblePrompt, isDeltaRenderedInTurn } from '../core/assemble.js';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { createTurnRandom, expandMacros } from '../core/macros.js';
import { estimateTokens } from '../core/tokenize.js';
import { clipWorldDeltasForTurn } from '../core/turnBudget.js';
import { normalizeTemplateLore, templateLoreEntries } from '../core/templateLore.js';
import { parseTemplatePlacement } from '../core/templatePlacement.js';
import { applyTemplatePlacements } from './templatePlacement.js';
import { finalizeTemplateOutlets } from './templateOutlets.js';
import { createTemplateGeneration, validateTemplateGenerationBudget } from './templateGeneration.js';
export function assembleTemplatePlan(input, sandbox) {
    sandbox?.setOutletsDeferred(true);
    const generationRegexCache = new Map();
    const evaluation = input.wiEvaluation;
    if (!evaluation) {
        let assembled = assemblePrompt({ ...input, estimateTokens,
            ...(sandbox ? createTemplateGeneration(sandbox, [], input.macroCtx, generationRegexCache) : {}),
            macroCtx: { ...input.macroCtx, random: createTurnRandom(input.seed) } });
        if (sandbox) {
            assembled = finalizeTemplateOutlets(assembled, sandbox, input.budget.maxTokens - input.budget.reserveForOutput);
            validateTemplateGenerationBudget(assembled, input.budget.maxTokens - input.budget.reserveForOutput);
            sandbox.setOutletsDeferred(false);
        }
        return { ...assembled, ...(sandbox ? { templateVariables: sandbox.variables() } : {}) };
    }
    const macroCtx = { ...input.macroCtx, random: createTurnRandom(input.seed) };
    const entries = evaluation.entries.map(normalizeTemplateLore).map(entry => {
        if (!sandbox || !entry.enabled || !(entry.templatePreprocessing || /^\[Preprocessing\]/i.test(entry.comment)))
            return entry;
        if (entry.templateCondition && !sandbox.condition(entry.templateCondition))
            return { ...entry, enabled: false };
        const render = (text, source) => expandMacros(sandbox.renderSource(expandMacros(text, macroCtx), source), macroCtx);
        return { ...entry,
            content: `<% /* preprocessed */ %>${render(entry.content, entry.key)}`,
            keys: entry.keys.map((text, i) => render(text, `${entry.key}:key:${i}`)),
            secondaryKeys: entry.secondaryKeys.map((text, i) => render(text, `${entry.key}:secondary:${i}`)),
        };
    });
    let requests = sandbox?.activationRequests() ?? [];
    // 最多每个条目请求一次，force 最多升级一次；其它条件不允许制造无限轮次。
    for (let attempt = 0; attempt < entries.length * 2 + 4; attempt++) {
        const requested = new Map(requests.map(item => [item.key, item.force]));
        const selected = templateLoreEntries(entries.map((entry) => {
            if (entry.templateDontActivate)
                return { ...entry, enabled: false };
            const force = requested.get(entry.key);
            let value = force === undefined ? entry : { ...entry, enabled: entry.enabled || force, constant: true,
                useProbability: force ? false : entry.useProbability,
                content: `<% /* activewi */ %>${entry.content}` };
            if (value.enabled && value.templateCondition) {
                value = sandbox.condition(value.templateCondition)
                    ? { ...value, content: `<% /* conditional lore */ %>${value.content}` } : { ...value, enabled: false };
            }
            return value;
        }));
        const wi = evaluateWorldInfo({ ...evaluation, entries: selected, estimateTokens, random: createTurnRandom(evaluation.seed) });
        const activatedDeltaIds = new Set(wi.activated.filter(a => a.entry.source === 'delta').map(a => a.entry.uid));
        const deltaClip = clipWorldDeltasForTurn(input.worldDeltas.filter(d => isDeltaRenderedInTurn(d, activatedDeltaIds)), estimateTokens);
        const placements = wi.activated.filter(a => parseTemplatePlacement(a.entry.comment)).map(a => a.entry);
        const ordinary = (acts) => acts.filter(a => !parseTemplatePlacement(a.entry.comment));
        const regularWi = { ...wi,
            byPosition: Object.fromEntries(Object.entries(wi.byPosition).map(([key, acts]) => [key, ordinary(acts)])),
            outlets: Object.fromEntries(Object.entries(wi.outlets).map(([key, acts]) => [key, ordinary(acts)])),
        };
        const assemblyInput = { ...input, wi: regularWi, worldDeltas: deltaClip.kept, estimateTokens,
            ...(sandbox ? createTemplateGeneration(sandbox, placements, macroCtx, generationRegexCache) : {}),
            macroCtx: { ...input.macroCtx, random: createTurnRandom(input.seed) } };
        let assembled = assemblePrompt(assemblyInput);
        const next = sandbox?.activationRequests() ?? [];
        if (JSON.stringify(next) !== JSON.stringify(requests)) {
            requests = next;
            continue;
        }
        const insertions = placements.filter(entry => parseTemplatePlacement(entry.comment)?.kind === 'insert');
        if (insertions.length) {
            if (!sandbox)
                throw new Error('定位注入需要模板沙箱');
            assembled = applyTemplatePlacements(assembled, insertions, sandbox, macroCtx, input.budget.maxTokens - input.budget.reserveForOutput);
            const next = sandbox.activationRequests();
            if (JSON.stringify(next) !== JSON.stringify(requests)) {
                requests = next;
                continue;
            }
        }
        if (sandbox) {
            assembled = finalizeTemplateOutlets(assembled, sandbox, input.budget.maxTokens - input.budget.reserveForOutput);
            validateTemplateGenerationBudget(assembled, input.budget.maxTokens - input.budget.reserveForOutput);
            sandbox.setOutletsDeferred(false);
        }
        return { ...assembled, evaluatedWi: wi, deltaDropped: deltaClip.dropped,
            ...(sandbox ? { templateVariables: sandbox.variables(), templateRegexRules: sandbox.regexDescriptors(), templateHasMessageRegex: sandbox.hasMessageRegex() } : {}) };
    }
    throw new Error('模板世界书主动激活未收敛');
}
