/** worker 的纯计算入口；不读取工作区，不接触宿主、会话或网络。 */
import { parentPort, workerData } from 'node:worker_threads';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { applyRegexRules } from '../core/regex.js';
import { createTurnRandom } from '../core/macros.js';
import { estimateTokens } from '../core/tokenize.js';
import { normalizeTemplateLore } from '../core/templateLore.js';
import { assembleTemplatePlan } from './templatePlan.js';
import { parseTemplatePlacement } from '../core/templatePlacement.js';
import { renderTemplateDisplay, presentTemplateDisplay } from './templateDisplay.js';
import { prepareContinuedTemplate, exportTemplateContinuation } from './templateContinuation.js';
import { parseTemplateContinuation, templatePreloadRevision } from '../state/templateContinuation.js';
import { templateReplayGenerationContext } from '../core/templateReplay.js';
if (parentPort) {
    try {
        const { kind, input } = workerData;
        const needsTemplates = kind === 'template' || kind === 'wi' && input.templates && input.entries.some((e) => e.templateCondition)
            || kind === 'assemble' && input.templates
                && (input.templateContinuation || input.templates.historyIdentities?.length || JSON.stringify(input).includes('<%') || JSON.stringify(input).includes('{{outletPromptsInjected:') || input.templates.entries.some((raw) => {
                    const entry = normalizeTemplateLore(raw);
                    return entry.enabled && (entry.templatePreload || entry.templateCondition || parseTemplatePlacement(entry.comment)
                        || /^\[(InitialVariables|RENDER:BEFORE|RENDER:AFTER)\]/i.test(entry.comment));
                }));
        const templateClass = needsTemplates ? (await import('./templateSandbox.js')).TemplateSandbox : null;
        // 输入解析、预加载与重放都计入计算预算；只有受信依赖和沙箱初始化走装载预算。
        await templateClass?.prepare(phase => parentPort.postMessage({ [phase]: true }));
        parentPort.postMessage({ ready: true });
        const beginComputing = () => parentPort.postMessage({ computing: true });
        beginComputing();
        let value;
        if (kind === 'assemble') {
            const sandbox = templateClass ? await prepareContinuedTemplate(templateClass, input.templates, input.templateContinuation) : null;
            beginComputing();
            try {
                const assembled = assembleTemplatePlan(input, sandbox);
                sandbox?.sticky('finish');
                value = { ...assembled, ...(sandbox ? { templateReplay: sandbox.replay(), templateMessageVariables: sandbox.messageVariables(),
                        templateContinuation: exportTemplateContinuation(sandbox, input.templates), templateRegexRules: sandbox.regexDescriptors(), templateHasMessageRegex: sandbox.hasMessageRegex() } : {}) };
            }
            finally {
                sandbox?.dispose();
            }
        }
        else if (kind === 'template') {
            const continuation = input.templateContinuation && parseTemplateContinuation(input.templateContinuation);
            if (continuation && (!input.replay || continuation.preloadRevision !== templatePreloadRevision(templateReplayGenerationContext(input.replay))
                || continuation.replay && JSON.stringify(continuation.replay) !== JSON.stringify(input.replay)))
                throw new Error('回复 sticky 状态与生成日志不一致');
            const sandbox = input.replay ? await templateClass.restore(input.replay, input.context) : await templateClass.create(input.context);
            beginComputing();
            try {
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
                value = { texts: rendered.map((result) => result.text), parts: rendered.map((result) => result.parts), variables: sandbox.variables(), messageVariables: sandbox.messageVariables(),
                    ...(input.templateContinuation ? { templateContinuation: { ...exportTemplateContinuation(sandbox, input.context, true), preloadRevision: input.templateContinuation.preloadRevision } } : {}) };
            }
            finally {
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
            value = { parts: presentTemplateDisplay(input.parts, input.rules, input.macroCtx) };
        }
        else
            throw new Error('未知提示词任务');
        if (JSON.stringify(value).length > 16 * 1024 * 1024)
            throw new Error('提示词计算结果超过 16 MiB 上限');
        parentPort.postMessage({ value });
    }
    catch (error) {
        parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
}
