/** worker 的纯计算入口；不读取工作区，不接触宿主、会话或网络。 */
import { parentPort } from 'node:worker_threads';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { applyRegexRules } from '../core/regex.js';
import { createTurnRandom } from '../core/macros.js';
import { estimateTokens } from '../core/tokenize.js';
import { normalizeTemplateLore } from '../core/templateLore.js';
import { assembleTemplatePlan } from './templatePlan.js';
import { parseTemplatePlacement } from '../core/templatePlacement.js';
import { renderTemplateDisplay, presentTemplateDisplayResult } from './templateDisplay.js';
import { prepareContinuedTemplate, exportTemplateContinuation } from './templateContinuation.js';
import { parseTemplateContinuation, templatePreloadRevision } from '../state/templateContinuation.js';
import { measureTemplateReplayWork, templateReplayGenerationContext } from '../core/templateReplay.js';
import { measureTemplateJson, templateExecutionBudget } from '../core/templateBudget.js';
import { TemplateWorkerCache, templateWorkerCacheKey } from './templateWorkerCache.js';
/** 只检查会成为正文的字段，避免为检测标记把包含重复长历史的整个任务编码两遍。 */
function hasTemplateText(value) {
    if (typeof value === 'string')
        return value.includes('<%') || value.includes('{{outletPromptsInjected:');
    if (!value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.some(hasTemplateText);
    return Object.values(value).some(hasTemplateText);
}
const sandboxCache = new TemplateWorkerCache();
async function compute(request) {
    let cacheKey, cacheHit = false;
    const send = (message) => parentPort.postMessage({ id: request.id, ...message });
    try {
        const { kind, input } = request;
        const budget = request.budget ?? templateExecutionBudget(Math.max(measureTemplateJson(input), input.replay ? measureTemplateReplayWork(input.replay) : 0, input.templateContinuation?.replay ? measureTemplateReplayWork(input.templateContinuation.replay) : 0));
        const needsTemplates = kind === 'template' || kind === 'wi' && input.templates && input.entries.some((e) => e.templateCondition)
            || kind === 'assemble' && input.templates
                && (input.templateContinuation || input.templates.historyIdentities?.length
                    || [input.card, input.preset, input.personaDescription, input.history, input.wi, input.macroCtx,
                        input.memories, input.worldDeltas, input.authorNote, input.journalText,
                        input.personaDescription, input.wi, input.regexRules, input.macroCtx, input.templates.variables,
                        input.templates.messageVariables, input.templates.entries, input.templates.presets].some(hasTemplateText) || input.templates.entries.some((raw) => {
                    const entry = normalizeTemplateLore(raw);
                    return entry.enabled && (entry.templatePreload || entry.templateCondition || parseTemplatePlacement(entry.comment)
                        || /^\[(InitialVariables|RENDER:BEFORE|RENDER:AFTER)\]/i.test(entry.comment));
                }));
        const templateClass = needsTemplates ? (await import('./templateSandbox.js')).TemplateSandbox : null;
        // 输入解析、预加载与重放都计入计算预算；只有受信依赖和沙箱初始化走装载预算。
        await templateClass?.prepare(phase => send({ [phase]: true }));
        const beginComputing = () => send({ computing: true });
        beginComputing();
        const incomingReplay = kind === 'assemble' ? input.templateContinuation?.replay : kind === 'template' ? input.replay : undefined;
        const incomingContext = kind === 'assemble' ? input.templates : input.context;
        const incomingKey = templateWorkerCacheKey(incomingReplay, incomingContext);
        if (kind === 'render' || kind === 'display')
            cacheKey = sandboxCache.key;
        else if (!incomingKey)
            sandboxCache.clear();
        const restoreCached = () => {
            const cached = sandboxCache.take(incomingKey, incomingReplay, budget.inputChars);
            cacheHit = Boolean(cached);
            return cached;
        };
        let value;
        if (kind === 'assemble') {
            const sandbox = templateClass ? await prepareContinuedTemplate(templateClass, input.templates, input.templateContinuation, restoreCached) : null;
            beginComputing();
            let retained = false;
            try {
                const assembled = assembleTemplatePlan(input, sandbox);
                sandbox?.sticky('finish');
                // replay() 必须是最后一次查询；它也记录变量导出，缓存 VM 必须与回传日志精确对齐。
                const result = { ...assembled, ...(sandbox ? { templateMessageVariables: sandbox.messageVariables(),
                        templateContinuation: exportTemplateContinuation(sandbox, input.templates), templateRegexRules: sandbox.regexDescriptors(), templateHasMessageRegex: sandbox.hasMessageRegex(), templateReplay: sandbox.replay() } : {}) };
                value = result;
                if (sandbox && result.templateReplay) {
                    cacheKey = sandboxCache.keep(sandbox, result.templateReplay, input.templates);
                    retained = true;
                }
            }
            finally {
                if (!retained)
                    sandbox?.dispose();
            }
        }
        else if (kind === 'template') {
            const continuation = input.templateContinuation && parseTemplateContinuation(input.templateContinuation);
            if (continuation && (!input.replay || continuation.preloadRevision !== templatePreloadRevision(templateReplayGenerationContext(input.replay))
                || continuation.replay && JSON.stringify(continuation.replay) !== JSON.stringify(input.replay)))
                throw new Error('回复 sticky 状态与生成日志不一致');
            const sandbox = input.replay ? restoreCached() ?? await templateClass.rebuild(input.replay) : await templateClass.create(input.context);
            beginComputing();
            let retained = false;
            try {
                if (input.replay)
                    sandbox.resume(input.context);
                if (continuation && JSON.stringify(continuation.state) !== JSON.stringify(sandbox.stickyState()))
                    throw new Error('回复 sticky 注册表与已提交状态不一致');
                const entries = input.context.entries.map(normalizeTemplateLore);
                const rendered = input.texts.map((text, index) => {
                    const meta = sandbox.setMessageContext(input.context.renderMessages?.[index] ?? null);
                    if (input.context.phase === 'render')
                        return renderTemplateDisplay(text, entries, sandbox, meta, Boolean(input.decorateOutput));
                    const rendered = sandbox.resolveOutlets(sandbox.render(text));
                    return { text: rendered, parts: [{ kind: 'markdown', text: rendered }] };
                });
                const result = { texts: rendered.map((result) => result.text), parts: rendered.map((result) => result.parts), variables: sandbox.variables(), messageVariables: sandbox.messageVariables(),
                    ...(input.templateContinuation ? { templateContinuation: { ...exportTemplateContinuation(sandbox, input.context, true), preloadRevision: input.templateContinuation.preloadRevision } } : {}) };
                value = result;
                if (result.templateContinuation?.replay) {
                    cacheKey = sandboxCache.keep(sandbox, result.templateContinuation.replay, input.context);
                    retained = true;
                }
            }
            finally {
                if (!retained)
                    sandbox.dispose();
            }
        }
        else if (kind === 'wi') {
            const sandbox = templateClass ? await templateClass.create(input.templates) : null;
            beginComputing();
            try {
                const entries = input.entries.map((entry) => {
                    if (!entry.enabled || !entry.templateCondition)
                        return entry;
                    if (!sandbox.condition(entry.templateCondition))
                        return { ...entry, enabled: false };
                    return { ...entry, content: `<% /* conditional lore */ %>${entry.content}` };
                });
                value = evaluateWorldInfo({ ...input, entries, estimateTokens, random: createTurnRandom(input.seed) });
            }
            finally {
                sandbox?.dispose();
            }
        }
        else if (kind === 'render') {
            beginComputing();
            value = applyRegexRules(input.text, input.rules, { scope: 'output', timing: 'render' }, input.macroCtx);
        }
        else if (kind === 'display') {
            beginComputing();
            value = presentTemplateDisplayResult(input.parts, input.rules, input.macroCtx);
        }
        else
            throw new Error('未知提示词任务');
        measureTemplateJson(value, budget.outputChars);
        send({ value, cacheKey, cacheHit });
    }
    catch (error) {
        sandboxCache.clear();
        send({ error: error instanceof Error ? error.message : String(error) });
    }
}
if (parentPort)
    parentPort.on('message', request => { void compute(request); });
