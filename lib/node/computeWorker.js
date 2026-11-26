/** worker 的纯计算入口；不读取工作区，不接触宿主、会话或网络。重模板依赖按需动态装载，纯正则与无模板组装走快路径。 */
import { parentPort } from 'node:worker_threads';
import { applyRegexRules } from '../core/regex.js';
import { measureTemplateJson, templateExecutionBudget } from '../core/templateBudget.js';
/** 按任务类别懒加载重依赖，保证纯正则渲染冷启动不解析 QuickJS/模板编排模块。 */
let displayModPromise;
const loadDisplay = () => (displayModPromise ??= import('./templateDisplay.js'));
let wiModsPromise;
const loadWiMods = () => (wiModsPromise ??= Promise.all([
    import('../core/worldbook.js'),
    import('../core/macros.js'),
    import('../core/tokenize.js'),
]).then(([wb, macros, tok]) => ({
    evaluateWorldInfo: wb.evaluateWorldInfo,
    createTurnRandom: macros.createTurnRandom,
    estimateTokens: tok.estimateTokens,
})));
let loreModsPromise;
const loadLoreMods = () => (loreModsPromise ??= Promise.all([
    import('../core/templateLore.js'),
    import('../core/templatePlacement.js'),
]).then(([lore, placement]) => ({
    normalizeTemplateLore: lore.normalizeTemplateLore,
    parseTemplatePlacement: placement.parseTemplatePlacement,
})));
let planModPromise;
const loadPlan = () => (planModPromise ??= import('./templatePlan.js'));
let replayCoreModPromise;
const loadReplayCore = () => (replayCoreModPromise ??= import('../core/templateReplay.js'));
let templateRuntimeModsPromise;
const loadTemplateRuntimeMods = () => (templateRuntimeModsPromise ??= Promise.all([
    import('./templateSandbox.js'),
    import('./templateContinuation.js'),
    import('../state/templateContinuation.js'),
    import('./templateOutlets.js'),
    import('./templateWorkerCache.js'),
]).then(([sandbox, cont, stateCont, outlets, cache]) => ({
    TemplateSandbox: sandbox.TemplateSandbox,
    prepareContinuedTemplate: cont.prepareContinuedTemplate,
    exportTemplateContinuation: cont.exportTemplateContinuation,
    parseTemplateContinuation: stateCont.parseTemplateContinuation,
    templatePreloadRevision: stateCont.templatePreloadRevision,
    containsTemplateOutlet: outlets.containsTemplateOutlet,
    TemplateWorkerCache: cache.TemplateWorkerCache,
    templateWorkerCacheKey: cache.templateWorkerCacheKey,
})));
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
let sandboxCache;
function safeDispose(sandbox) {
    try {
        sandbox?.dispose();
    }
    catch { }
}
async function compute(request) {
    const requestId = request.id;
    let cacheKey, cacheHit = false;
    let templateClass = null;
    const send = (message) => parentPort.postMessage({ id: requestId, ...message });
    try {
        const { kind, input } = request;
        let replayWork = 0;
        if (request.budget === undefined && (input.replay || input.templateContinuation?.replay)) {
            const { measureTemplateReplayWork } = await loadReplayCore();
            replayWork = Math.max(input.replay ? measureTemplateReplayWork(input.replay) : 0, input.templateContinuation?.replay ? measureTemplateReplayWork(input.templateContinuation.replay) : 0);
        }
        const budget = request.budget ?? templateExecutionBudget(Math.max(measureTemplateJson(input), replayWork), undefined, kind === 'render' || kind === 'display' || kind === 'renderBatch' ? 'display' : 'template');
        const assembleTemplates = kind === 'assemble' && input.templates
            ? {
                ...input.templates,
                entries: input.templates.entries ?? input.wiEvaluation?.entries ?? [],
                presets: input.templates.presets ?? input.preset.entries.filter((e) => e.enabled),
            }
            : undefined;
        const hasActiveTemplateState = Boolean(assembleTemplates && (assembleTemplates.helperMvu !== undefined
            || Object.keys(assembleTemplates.variables.global).length
            || Object.keys(assembleTemplates.variables.local).length
            || Object.keys(assembleTemplates.variables.message).length
            || Object.keys(assembleTemplates.messageVariables?.snapshots ?? {}).length));
        let needsTemplates = false;
        if (kind === 'template') {
            needsTemplates = true;
        }
        else if (kind === 'wi' && input.templates && input.entries.length > 0) {
            const { normalizeTemplateLore } = await loadLoreMods();
            needsTemplates = input.entries.some((raw) => {
                const entry = normalizeTemplateLore(raw);
                return entry.enabled && Boolean(entry.templateCondition);
            });
        }
        else if (kind === 'assemble' && assembleTemplates) {
            // 禁用历史 EJS 求值时（live 管线），历史正文与 lastUserMessage/lastCharMessage/lastMessage
            // 里的字面 `<%` 不应触发 QuickJS 冷启动。
            const historyFlags = Array.isArray(input.historyTemplateFlags) ? input.historyTemplateFlags : undefined;
            const scanHistory = historyFlags
                ? input.history.filter((_, index) => historyFlags[index] !== false)
                : input.history;
            const scanMacroCtx = historyFlags && historyFlags.every(flag => !flag)
                ? { ...input.macroCtx, lastUserMessage: '', lastCharMessage: '', lastMessage: '' }
                : input.macroCtx;
            needsTemplates = Boolean(input.templateContinuation || hasActiveTemplateState || assembleTemplates.regexRules?.length
                || [input.card, input.preset, input.personaDescription, scanHistory, input.wi, input.wiEvaluation?.entries,
                    input.memories, input.worldDeltas, input.authorNote, input.journalText,
                    input.regexRules, scanMacroCtx, assembleTemplates.variables,
                    assembleTemplates.messageVariables, assembleTemplates.entries, assembleTemplates.presets].some(hasTemplateText));
            if (!needsTemplates) {
                const entriesToCheck = input.wiEvaluation?.entries && input.wiEvaluation.entries !== assembleTemplates.entries
                    ? [...assembleTemplates.entries, ...input.wiEvaluation.entries]
                    : assembleTemplates.entries;
                if (entriesToCheck.length > 0) {
                    const { normalizeTemplateLore, parseTemplatePlacement } = await loadLoreMods();
                    needsTemplates = entriesToCheck.some((raw) => {
                        const entry = normalizeTemplateLore(raw);
                        // 预处理必须计入：仅靠 @@preprocessing（正文装饰器）或 [Preprocessing]（注释标记）触发的条目
                        // 可能完全没有 EJS，漏判会让预处理静默不执行（键与正文不展开），而不是明确失败。
                        return entry.enabled && (entry.templatePreload || entry.templatePreprocessing || /^\[Preprocessing\]/i.test(entry.comment)
                            || entry.templateCondition || parseTemplatePlacement(entry.comment)
                            || /^\[(InitialVariables|RENDER:BEFORE|RENDER:AFTER)\]/i.test(entry.comment)
                            || /^\[(?:GENERATE|RENDER|PRELOAD)\b/i.test(entry.comment) || /^\s*@INJECT\b/.test(entry.content) || /^@INJECT\b/i.test(entry.comment));
                    });
                }
            }
        }
        const runtimeMods = needsTemplates ? await loadTemplateRuntimeMods() : null;
        templateClass = runtimeMods?.TemplateSandbox ?? null;
        // 输入解析、预加载与重放都计入计算预算；只有受信依赖和沙箱初始化走装载预算。
        await templateClass?.prepare(phase => send({ [phase]: true }));
        const beginComputing = () => send({ computing: true });
        beginComputing();
        const incomingReplay = kind === 'assemble' ? input.templateContinuation?.replay : kind === 'template' ? input.replay : undefined;
        const incomingContext = kind === 'assemble' ? assembleTemplates : input.context;
        const incomingKey = runtimeMods
            ? ('incomingKey' in request ? request.incomingKey : runtimeMods.templateWorkerCacheKey(incomingReplay, incomingContext))
            : undefined;
        const ensureCache = () => (sandboxCache ??= new runtimeMods.TemplateWorkerCache());
        if (!needsTemplates || kind === 'wi' || kind === 'render' || kind === 'display' || kind === 'renderBatch')
            cacheKey = sandboxCache?.key;
        else if (!incomingKey)
            sandboxCache?.clear();
        const restoreCached = () => {
            const cached = ensureCache().take(incomingKey, incomingReplay, budget.inputChars);
            cacheHit = Boolean(cached);
            return cached;
        };
        let value;
        if (kind === 'assemble') {
            const { assembleTemplatePlan } = await loadPlan();
            const assembleInput = assembleTemplates ? { ...input, templates: assembleTemplates } : input;
            const sandbox = runtimeMods && assembleTemplates ? await runtimeMods.prepareContinuedTemplate(runtimeMods.TemplateSandbox, assembleTemplates, input.templateContinuation, restoreCached) : null;
            beginComputing();
            let retained = false;
            try {
                const assembled = assembleTemplatePlan(assembleInput, sandbox);
                sandbox?.sticky('finish');
                // replay() 必须是最后一次查询；它也记录变量导出，缓存 VM 必须与回传日志精确对齐。
                const result = { ...assembled, ...(sandbox && runtimeMods && assembleTemplates ? { templateMessageVariables: sandbox.messageVariables(),
                        templateContinuation: runtimeMods.exportTemplateContinuation(sandbox, assembleTemplates), templateRegexRules: sandbox.regexDescriptors(), templateHasMessageRegex: sandbox.hasMessageRegex(), templateReplay: sandbox.replay() } : {}) };
                value = result;
                if (sandbox && assembleTemplates && result.templateReplay) {
                    cacheKey = ensureCache().keep(sandbox, result.templateReplay, assembleTemplates);
                    retained = true;
                }
            }
            finally {
                if (!retained)
                    safeDispose(sandbox);
            }
        }
        else if (kind === 'template') {
            const [{ templateReplayGenerationContext }, { normalizeTemplateLore }, { renderTemplateDisplay }] = await Promise.all([
                loadReplayCore(),
                loadLoreMods(),
                loadDisplay(),
            ]);
            const continuation = input.templateContinuation && runtimeMods.parseTemplateContinuation(input.templateContinuation);
            if (continuation && (!input.replay || continuation.preloadRevision !== runtimeMods.templatePreloadRevision(templateReplayGenerationContext(input.replay))
                || continuation.replay && JSON.stringify(continuation.replay) !== JSON.stringify(input.replay)))
                throw new Error('回复 sticky 状态与生成日志不一致');
            let sandbox;
            let freshRenderRecording = false;
            if (input.replay) {
                sandbox = restoreCached() ?? await templateClass.rebuild(input.replay);
            }
            else if (input.context.phase === 'render'
                && input.context.helperMvu === undefined
                && Object.keys(input.context.messageVariables?.snapshots ?? {}).length === 0) {
                // 纯文本卡走快路径后，回复阶段首次按需建沙箱：以空历史 generate 基线开启录制并经 resume 切入 render，
                // 既不破坏 render 初始空快照校验（且排除带 helperMvu 的场景），又使回复注册跨轮 sticky 闭包时导出的 replay 满足 phase === 'generate' 与操作录制契约。
                freshRenderRecording = true;
                const generateBase = {
                    ...input.context,
                    phase: 'generate',
                    history: [],
                    historyIdentities: [],
                    messageVariables: { version: 1, snapshots: {} },
                    renderMessages: undefined,
                };
                sandbox = await templateClass.create(generateBase, true);
                try {
                    sandbox.sticky('begin');
                    sandbox.sticky('finish');
                    sandbox.resume(input.context);
                }
                catch (error) {
                    safeDispose(sandbox);
                    throw error;
                }
            }
            else {
                sandbox = await templateClass.create(input.context);
            }
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
                    const raw = sandbox.render(text);
                    const rendered = runtimeMods.containsTemplateOutlet(raw) ? sandbox.resolveOutlets(raw) : raw;
                    return { text: rendered, parts: [{ kind: 'markdown', text: rendered }] };
                });
                // replay() 必须是最后一次查询；先读取 variables / messageVariables，再按需导出跨轮 continuation，确保缓存 VM 与日志对齐。
                // 调用方显式传入 replay 但未请求 templateContinuation 时保持既有返回结构，不额外附带 continuation。
                const variables = sandbox.variables();
                const messageVariables = sandbox.messageVariables();
                let templateContinuation;
                if (input.templateContinuation || freshRenderRecording) {
                    const exportedContinuation = runtimeMods.exportTemplateContinuation(sandbox, input.context, true);
                    if (input.templateContinuation) {
                        templateContinuation = { ...exportedContinuation, preloadRevision: input.templateContinuation.preloadRevision };
                    }
                    else if (exportedContinuation.replay
                        || exportedContinuation.state.prompts.length
                        || exportedContinuation.state.regex.basic.length
                        || exportedContinuation.state.regex.generate.length
                        || exportedContinuation.state.regex.message.length
                        || exportedContinuation.state.tombstones.prompts.length
                        || exportedContinuation.state.tombstones.basic.length
                        || exportedContinuation.state.tombstones.generate.length
                        || exportedContinuation.state.tombstones.message.length) {
                        templateContinuation = exportedContinuation;
                    }
                }
                const result = {
                    texts: rendered.map((r) => r.text),
                    parts: rendered.map((r) => r.parts),
                    variables,
                    messageVariables,
                    ...(templateContinuation ? { templateContinuation } : {}),
                };
                value = result;
                if (result.templateContinuation?.replay) {
                    cacheKey = ensureCache().keep(sandbox, result.templateContinuation.replay, input.context);
                    retained = true;
                }
            }
            finally {
                if (!retained)
                    safeDispose(sandbox);
            }
        }
        else if (kind === 'wi') {
            const [{ evaluateWorldInfo, createTurnRandom, estimateTokens }, loreMods] = await Promise.all([
                loadWiMods(),
                input.templates ? loadLoreMods() : Promise.resolve(null),
            ]);
            const sandbox = templateClass ? await templateClass.create(input.templates) : null;
            beginComputing();
            try {
                const entries = (loreMods ? input.entries.map(loreMods.normalizeTemplateLore) : input.entries).map((entry) => {
                    if (!entry.enabled || !entry.templateCondition)
                        return entry;
                    if (!sandbox.condition(entry.templateCondition))
                        return { ...entry, enabled: false };
                    return { ...entry, content: `<% /* conditional lore */ %>${entry.content}` };
                });
                value = evaluateWorldInfo({ ...input, entries, estimateTokens, random: createTurnRandom(input.seed) });
            }
            finally {
                safeDispose(sandbox);
            }
        }
        else if (kind === 'render') {
            beginComputing();
            value = applyRegexRules(input.text, input.rules, { scope: 'output', timing: 'render', ...(input.depth !== undefined ? { depth: input.depth } : {}) }, input.macroCtx);
        }
        else if (kind === 'display') {
            const { presentTemplateDisplayResult } = await loadDisplay();
            beginComputing();
            value = presentTemplateDisplayResult(input.parts, input.rules, input.macroCtx, input.depth);
        }
        else if (kind === 'renderBatch') {
            const needsDisplay = input.items.some(item => item.kind === 'display');
            const displayMod = needsDisplay ? await loadDisplay() : null;
            beginComputing();
            value = input.items.map((item) => {
                try {
                    if (item.kind === 'render') {
                        return { ok: true, kind: 'render', value: applyRegexRules(item.text, input.rules, { scope: 'output', timing: 'render', ...(item.depth !== undefined ? { depth: item.depth } : {}) }, input.macroCtx) };
                    }
                    return { ok: true, kind: 'display', value: displayMod.presentTemplateDisplayResult(item.parts, input.rules, input.macroCtx, item.depth) };
                }
                catch (error) {
                    const message = error instanceof Error ? (error.message || error.name || '展示正则计算失败') : (String(error) || '展示正则计算失败');
                    return { ok: false, error: message };
                }
            });
        }
        else
            throw new Error('未知提示词任务');
        measureTemplateJson(value, budget.outputChars);
        send({ value, cacheKey, cacheHit });
    }
    catch (error) {
        sandboxCache?.clear();
        // 空消息错误不能被 host 当成成功：这里保证 error 字段始终是非空失败原因。
        const message = error instanceof Error ? (error.message || error.name || '模板计算失败') : (String(error) || '模板计算失败');
        send({ error: message });
    }
    finally {
        templateClass?.clearPhaseReporter?.();
    }
}
if (parentPort)
    parentPort.on('message', request => { void compute(request); });
