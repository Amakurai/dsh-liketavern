import { defaultPreset } from '../core/assemble.js';
import { BOUND_DISCIPLINE, TURN_PLAYBOOK, isSyntheticUserText } from '../core/dshPrompt.js';
import { hashToSeed } from '../core/macros.js';
import { memorySearchOptions, selectMemoryBodies } from '../core/memoryRetrieval.js';
import { clipToTokenBudget, estimateTokens } from '../core/tokenize.js';
import { EMPTY_TIMER_STATE } from '../core/types.js';
import { isolated } from './isolated.js';
import { standingFingerprint } from '../core/standingPin.js';
import { DEFAULT_USER_NAME } from '../core/persona.js';
import { parseLorebook } from '../state/lorebook.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { loadTemplateState, saveTemplateState } from '../state/template.js';
import { loadHelperState } from '../state/helper.js';
import { latestTemplateHelperMvu, projectTemplateHelperMvu } from '../core/templateHelperMvu.js';
import { currentHelperMvuTemplateData } from './helperMvuTemplateSnapshot.js';
import { templateGenerationContext } from '../state/templateGeneration.js';
import { templateCardData } from '../core/templateAssets.js';
import { normalizeTemplateLore } from '../core/templateLore.js';
import { buildTemplateMessageHistory } from './templateMessageHistory.js';
import { mergeTemplateMessageVariables, visibleTemplateMessageVariables } from '../core/templateMessageVariables.js';
import { loadTemplateAvatars } from './templateAvatar.js';
import { resolveTemplateContinuation } from '../state/templateContinuation.js';
const FALLBACK_CONTEXT_WINDOW = 131072;
const FALLBACK_RESERVE_OUTPUT = 8192;
/** deriveMessages 拍平：只取 text 块拼成纯文本；空消息丢弃。 */
export function flattenMessages(messages, charName, userName) {
    const out = [];
    for (const m of messages) {
        const text = m.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
        if (!text.trim())
            continue;
        const name = m.role === 'assistant' ? charName : m.role === 'user' ? userName : undefined;
        out.push({ role: m.role, content: text, ...(name ? { name } : {}) });
    }
    return out;
}
/** 解析模型上下文窗口；任何失败都回退默认值。元数据经 TavernState 进程内缓存，每步调用不重复解析。 */
async function resolveContextWindow(input) {
    const provider = input.agent?.options.provider;
    const model = input.agent?.options.model;
    if (!input.llm || !provider || !model)
        return FALLBACK_CONTEXT_WINDOW;
    try {
        const info = await input.state.resolveModelInfoCached(input.llm, provider, model);
        return info.context?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
    }
    catch {
        return FALLBACK_CONTEXT_WINDOW;
    }
}
export async function loadBoundLoreEntries(state, binding) {
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId);
    const groups = [];
    // 全局世界书
    for (const id of binding.lorebookIds) {
        groups.push(await state.loadLorebookEntries(id, 'global'));
    }
    // 主世界书（Character Lore）：绑定指定库文件 > 卡内嵌书（card.json / assets/character-book.json）
    if (binding.characterLorebookId) {
        groups.push(await state.loadLorebookEntries(binding.characterLorebookId, 'character'));
    }
    else if (binding.useEmbeddedLorebook !== false) {
        const embedded = await state.loadCharacterLorebookRaw(binding.cardId);
        if (embedded)
            groups.push(parseLorebook(embedded.json, { source: 'character', sourceRef: binding.cardId }));
    }
    for (const id of new Set(binding.characterLorebookIds ?? [])) {
        if (id !== binding.characterLorebookId)
            groups.push(await state.loadLorebookEntries(id, 'character'));
    }
    // 聊天世界书（会话级，存工作区）
    const chatRaw = await ws.fs.readText('assets/chat-lorebook.json');
    if (chatRaw !== null) {
        try {
            groups.push(parseLorebook(JSON.parse(chatRaw), { source: 'chat', sourceRef: 'chat-lorebook' }));
        }
        catch {
            // 坏文件跳过
        }
    }
    // 人设世界书
    const persona = await state.resolvePersona(binding.personaId);
    if (persona?.lorebookId) {
        groups.push(await state.loadLorebookEntries(persona.lorebookId, 'persona'));
    }
    const base = groups.flat();
    // 变化层：ref 的 order 解析先查 character 条目，再查其余
    const deltas = await ws.deltas.list();
    const resolveRefOrder = (ref) => {
        const bySource = (source) => base.find((e) => e.source === source && e.uid === ref)?.order;
        return bySource('character') ?? base.find((e) => e.uid === ref)?.order ?? null;
    };
    const deltaEntries = ws.deltas.toEngineEntries(deltas, resolveRefOrder);
    return { entries: [...base, ...deltaEntries], deltas };
}
/** 组装一次 Tavern 提示词。绑定缺失或角色不存在时返回 null。 */
export async function runTavernPipeline(input) {
    await input.state.waitForSessionTasks(input.sessionId);
    const binding = await input.state.loadBinding(input.sessionId);
    if (!binding)
        return null;
    const ws = await input.state.storyWorkspace(binding.cardId, binding.storyId);
    return withWorkspaceLock(ws.fs.root, () => runTavernPipelineLocked(input, binding));
}
async function runTavernPipelineLocked(input, expected) {
    const { state, sessionId } = input;
    // turn/start 的监听器异步开 WAL；提示词/工具热路径必须等它完成后才能产生工作区写入。
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        return null;
    if (binding.cardId !== expected.cardId || binding.storyId !== expected.storyId)
        throw new Error('组装排队期间剧情绑定已变化');
    const activeTurn = state.currentTurns.get(sessionId);
    const previous = state.turnPlans.get(sessionId);
    if (input.mode === 'live' && activeTurn !== undefined && previous?.turn === activeTurn) {
        if (previous.cardId !== binding.cardId || previous.storyId !== binding.storyId)
            throw new Error('生成期间绑定已变化，请在下一轮继续');
        return previous.result;
    }
    const pendingPlan = state.pendingTurnPlans.get(sessionId);
    if (input.mode === 'live' && pendingPlan) {
        if (activeTurn === pendingPlan.turn) {
            if (pendingPlan.cardId !== binding.cardId || pendingPlan.storyId !== binding.storyId)
                throw new Error('生成期间绑定已变化，请在下一轮继续');
            return pendingPlan.publish();
        }
        state.pendingTurnPlans.delete(sessionId);
    }
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId);
    const templateState = await loadTemplateState(ws.fs);
    const generation = templateState.generation;
    if (input.mode === 'live' && generation?.sessionId === sessionId && generation.cardId === binding.cardId && generation.storyId === binding.storyId) {
        let recoveryTurn = activeTurn;
        if (recoveryTurn === undefined && generation.status === 'prepared') {
            const events = input.agent?.session.snapshotEvents();
            const last = events && [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end');
            if (last?.type !== 'turn/start' || last.data.turn !== generation.turn)
                throw new Error('模板计划等待恢复：请先完成当前宿主轮次，不能重新执行已提交模板');
            recoveryTurn = last.data.turn;
        }
        if (recoveryTurn === generation.turn) {
            if (generation.status !== 'prepared')
                throw new Error('该轮模板已经结束，请开启新一轮，不能重复执行');
            const floor = await ws.wal.validateFloor(generation.floor);
            if (floor.committed)
                throw new Error('模板计划恢复缺少未提交的原剧情楼层');
            const open = state.openFloors.get(sessionId);
            if (open && (open.cardId !== binding.cardId || open.storyId !== binding.storyId || open.floor !== generation.floor))
                throw new Error('模板计划恢复的剧情楼层冲突');
            const restored = restorePipelineResult(generation);
            state.currentTurns.set(sessionId, generation.turn);
            state.openFloors.set(sessionId, { cardId: generation.cardId, storyId: generation.storyId, floor: generation.floor });
            state.turnPlans.set(sessionId, { turn: generation.turn, cardId: generation.cardId, storyId: generation.storyId, result: restored });
            return restored;
        }
    }
    const charWs = await state.loadCharacter(binding.cardId);
    if (!charWs)
        return null;
    const card = charWs.card;
    const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset();
    const persona = await state.resolvePersona(binding.personaId);
    const userName = persona?.name ?? DEFAULT_USER_NAME;
    const standingKey = standingFingerprint(binding, { name: userName, description: persona?.description ?? '' }, state.standingRevTags(binding, { personaLorebookId: persona?.lorebookId ?? null }), input.generationType ?? 'normal');
    const rawHistory = input.agent
        ? flattenMessages(input.agent.session.deriveMessages(), card.name, userName)
        : (input.historyOverride ?? []);
    const history = rawHistory.filter((m) => !(m.role === 'user' && isSyntheticUserText(m.content)));
    // 待入日志的本轮输入：去重（已入日志的不再追加）。同轮第 2 步起 history 末条已是
    // assistant，只比末条会把已入日志的输入重复追加到扫描尾部——pending 按插入顺序落在
    // history 尾部，取尾部最多 pending 条数的 user 消息逐条抵消（同文本连发也只抵消
    // 已入日志的条数）。合成 user 文本（runtime context 快照、同轮写入确认、续写指令）
    // 不经 inbox 也进不了 {{lastusermessage}} 与世界书扫描——它们不是用户台词。
    const pending = (state.pendingInputs.get(sessionId) ?? []).filter((t) => !isSyntheticUserText(t));
    const pendingFresh = [...pending];
    let scannedUsers = 0;
    for (let i = history.length - 1; i >= 0 && pendingFresh.length > 0 && scannedUsers < pending.length; i--) {
        const message = history[i];
        if (message.role !== 'user')
            continue;
        scannedUsers++;
        const at = pendingFresh.lastIndexOf(message.content);
        if (at >= 0)
            pendingFresh.splice(at, 1);
    }
    const scanMessages = [
        ...history,
        ...pendingFresh.map((content) => ({ role: 'user', content, name: userName })),
    ];
    const messageProjection = input.agent ? buildTemplateMessageHistory(input.agent.session.deriveMessages(), state.pendingTemplateInputs.get(sessionId) ?? [], card.name, userName, input.agent.session.snapshotEvents?.() ?? []) : undefined;
    const templateHistory = messageProjection?.history ?? scanMessages;
    const historyIdentities = messageProjection?.identities ?? templateHistory.map((_, index) => ({
        messageId: `preview:${sessionId}:${state.currentTurns.get(sessionId) ?? -1}:${index}`, swipeId: 0,
    }));
    // 使用宿主真实可见身份；无身份的纯文本预览不能猜测消息对应关系或读入其它剧情数据。
    let helperMvu;
    if (messageProjection && binding.helperMvu === true && state.config.interactiveCards && binding.interactiveCards !== false) {
        const helper = await loadHelperState(ws.fs);
        const current = currentHelperMvuTemplateData(input.agent.session.snapshotEvents(), helper.scopes);
        if (current !== undefined)
            helperMvu = projectTemplateHelperMvu(helper.scopes, historyIdentities, current);
    }
    const lastUserMessage = pendingFresh.at(-1) ?? [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const config = state.config;
    const contextWindow = await resolveContextWindow(input);
    const turn = state.currentTurns.get(sessionId) ?? -1;
    const turnSeed = hashToSeed(`${sessionId}:${turn}`);
    const macroCtx = {
        char: card.name,
        user: userName,
        lastUserMessage,
        now: new Date(),
        readonlyStatData: latestTemplateHelperMvu(helperMvu, historyIdentities),
    };
    // ── WI / 记忆 / 变化层：每 turn 评估一次并缓存 ──
    // 缓存只服务「live 且已知 turn 号」的评估：
    // preview（预览提示词 / 代答）用空定时器评估，既不能复用本轮 live 的结果，也绝不能写进缓存——
    // 否则本 turn 的 live 评估会沿用这份无定时器的结果，sticky/cooldown 被免定时器地决定且永不落盘。
    // 且 idle 时 turn 恒为 -1，各次预览之间也不该互相复用（绑定/世界书/记忆随时可能被编辑）。
    // 代价是每次预览/代答多评估一次世界书——正确且便宜。
    const cacheable = input.mode === 'live' && turn >= 0;
    let memories;
    let deltas;
    let lastCharMessage;
    let journalText;
    const lore = await loadBoundLoreEntries(state, binding);
    lore.entries = lore.entries.map(normalizeTemplateLore);
    const templateContext = {
        variables: templateState.variables, char: card.name, user: userName,
        card: templateCardData(card),
        entries: lore.entries, presets: preset.entries.filter(e => e.enabled), history: templateHistory,
        historyIdentities, messageVariables: visibleTemplateMessageVariables(templateState.messageVariables, historyIdentities),
        ...(helperMvu ? { helperMvu } : {}),
        ...await loadTemplateAvatars(state, binding.cardId, persona),
        now: macroCtx.now.getTime(), seed: turnSeed, phase: 'generate',
        sessionId, cardId: binding.cardId, generationType: input.generationType ?? 'normal', model: input.agent?.options.model ?? '',
    };
    {
        deltas = lore.deltas;
        // 记忆检索：本轮输入 + 最近 N 条历史做查询
        const queryMessages = [pendingFresh.join('\n'), ...scanMessages.slice(-config.memory.queryMessages).map((m) => m.content)]
            .filter((t) => t.trim())
            .join('\n');
        memories = [];
        if (queryMessages.trim()) {
            const hits = await ws.memory.search(queryMessages, memorySearchOptions(config.memory.retrievalTopK, config.memory.halfLifeDays));
            memories = selectMemoryBodies(hits, config.memory.retrievalTokenBudget);
        }
        // 同轮冻结的宏输入：第 1 步取当前 history 的最近 assistant 正文（{{lastcharmessage}} 用），
        // 后续步 history 增长也不变；journal 同理只在本轮首次评估读一次盘。
        lastCharMessage = [...history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
        journalText = '';
        if (binding.injectJournal) {
            const rawJournal = await ws.fs.readText('journal.md');
            if (rawJournal?.trim())
                journalText = clipToTokenBudget(rawJournal, 800).text;
        }
    }
    const assembled = await isolated('assemble', {
        templates: templateContext,
        templateContinuation: resolveTemplateContinuation(templateState),
        wiEvaluation: {
            entries: lore.entries, messages: scanMessages, settings: state.worldInfoFor(binding),
            timerState: input.mode === 'live' ? await state.loadTimers(binding.cardId, sessionId, binding.storyId) : structuredClone(EMPTY_TIMER_STATE),
            contextWindowTokens: contextWindow, reservedTokens: estimateTokens(scanMessages.map(m => m.content).join('\n')),
            seed: turnSeed, macroCtx: { char: card.name, user: userName },
        },
        preset,
        card,
        personaDescription: persona?.description ?? '',
        history: scanMessages,
        wi: null,
        memories,
        worldDeltas: deltas,
        authorNote: binding.authorNote ?? '',
        journalText,
        // 显式冻结 lastCharMessage（同轮复用缓存值），不让 assemble 回退到随 history 增长的现算值。
        macroCtx: { ...macroCtx, lastCharMessage },
        regexRules: await state.rulesFor(binding),
        // ST injection_trigger 评估用：当前正常发信是 normal；continue/impersonate 经 PipelineInput 传入。
        generationType: input.generationType ?? 'normal',
        seed: turnSeed ^ 0x9e3779b9,
        budget: {
            maxTokens: contextWindow,
            reserveForOutput: config.sampling.maxTokens ?? FALLBACK_RESERVE_OUTPUT,
        },
    });
    const wi = assembled.evaluatedWi;
    templateContext.regexRules = assembled.templateRegexRules;
    templateContext.hasMessageRegex = assembled.templateHasMessageRegex;
    // live 通道独立预算；历史的压缩由宿主处理，不能用模拟历史长度裁掉角色定义。
    const minimumLiveTokens = estimateTokens([BOUND_DISCIPLINE, assembled.standing, TURN_PLAYBOOK, assembled.turnContext].join('\n\n'));
    const available = contextWindow - (config.sampling.maxTokens ?? FALLBACK_RESERVE_OUTPUT);
    if (input.mode === 'live' && minimumLiveTokens > available)
        throw new Error('角色设定与本轮上下文已超过模型可用窗口，请缩减设定或提高上下文容量');
    const logLines = formatLogs(wi, assembled);
    logLines.push(`[live:budget] 插件通道≈${minimumLiveTokens} tokens；不含宿主 system/tools/历史，模拟裁剪不影响这些通道`);
    // turn 尾巴体积(缓存观测):快照对新请求永远是未缓存前缀,体积即每轮全价重付的量。
    logLines.push(`[turn:tail] turnContext≈${estimateTokens(assembled.turnContext)} tokens`);
    if (assembled.deltaDropped) {
        logLines.push(`[turn:tail] 变化层超预算裁掉 ${assembled.deltaDropped} 条（tavern_lore_read source=delta 可补读）`);
    }
    const result = {
        templateContext,
        templateReplay: assembled.templateReplay,
        standingKey,
        sampling: structuredClone(config.sampling),
        standing: assembled.standing,
        turnContext: assembled.turnContext,
        system: assembled.system,
        messages: assembled.messages,
        history: assembled.history,
        assembled,
        logLines,
        userName,
        personaDescription: persona?.description ?? '',
        personaLorebookId: persona?.lorebookId ?? null,
        wiBudget: wi.budget,
    };
    const entry = input.mode === 'live' ? state.openFloors.get(sessionId) : undefined;
    const writable = entry && entry.cardId === binding.cardId && entry.storyId === binding.storyId;
    const variablesChanged = assembled.templateVariables && JSON.stringify(assembled.templateVariables) !== JSON.stringify(templateState.variables);
    if (input.mode === 'live' && (variablesChanged || result.templateReplay) && !writable)
        throw new Error('模板写变量需要在绑定角色后开启新的一轮');
    const persistedGeneration = result.templateReplay && writable && binding.storyId ? {
        version: 1, status: 'prepared', sessionId, cardId: binding.cardId, storyId: binding.storyId, turn, floor: entry.floor, replay: result.templateReplay,
        regexRules: templateContext.regexRules, hasMessageRegex: templateContext.hasMessageRegex,
        plan: { standingKey: result.standingKey, sampling: result.sampling, standing: result.standing, turnContext: result.turnContext, messages: result.messages,
            history: result.history, logLines: result.logLines, userName: result.userName, personaDescription: result.personaDescription,
            personaLorebookId: result.personaLorebookId, wiBudget: result.wiBudget, assembleLog: result.assembled.log, stats: result.assembled.stats },
    } : undefined;
    // 变量发生变化时，定时器必须与变量同文件提交；否则第二个 rename 失败会让重试多 tick 一次。
    // 先冻结待提交闭包，但不发布 turnPlans。提交报错后保留绝对快照，重试不再运行第三方代码。
    const publish = async () => {
        if (writable) {
            const latestBinding = await state.loadBinding(sessionId);
            const latestFloor = state.openFloors.get(sessionId);
            if (latestBinding?.cardId !== binding.cardId || latestBinding?.storyId !== binding.storyId
                || latestFloor?.floor !== entry.floor || latestFloor.cardId !== binding.cardId || latestFloor.storyId !== binding.storyId
                || (cacheable && (state.currentTurns.get(sessionId) !== turn || entry.floor !== `${sessionId}#t${turn}`)))
                throw new Error('模板提交前剧情绑定或楼层已变化');
            if (variablesChanged || persistedGeneration || assembled.templateMessageVariables) {
                await saveTemplateState(ws.fs.withFloor(entry.floor), { ...templateState, variables: assembled.templateVariables ?? templateState.variables,
                    ...(assembled.templateMessageVariables ? { messageVariables: mergeTemplateMessageVariables(templateState.messageVariables, assembled.templateMessageVariables, historyIdentities) } : {}),
                    ...(assembled.templateContinuation ? { continuation: assembled.templateContinuation } : {}),
                    wiTimers: { ...templateState.wiTimers, [sessionId]: wi.timerState },
                    ...(persistedGeneration ? { generation: persistedGeneration } : {}) });
            }
            else {
                await state.saveTimers(binding.cardId, sessionId, wi.timerState, entry.floor, binding.storyId);
            }
        }
        state.recordTriggerLog(sessionId, logLines);
        if (cacheable) {
            state.wiCache.set(sessionId, { turn, wi, memories, deltas, lastCharMessage, journalText });
            state.turnPlans.set(sessionId, { turn, cardId: binding.cardId, storyId: binding.storyId, result });
            state.pendingTurnPlans.delete(sessionId);
        }
        return result;
    };
    if (cacheable && writable)
        state.pendingTurnPlans.set(sessionId, { turn, cardId: binding.cardId, storyId: binding.storyId, floor: entry.floor, publish });
    return publish();
}
/** 从单份持久快照恢复所有入模字节与采样；不读取当前资产、不重跑 WI 或模板。 */
function restorePipelineResult(generation) {
    const { assembleLog, stats, ...plan } = generation.plan;
    const system = [plan.standing, plan.turnContext].filter(Boolean).join('\n\n');
    return { ...plan, system, templateContext: templateGenerationContext(generation), templateReplay: generation.replay,
        assembled: { messages: plan.messages, history: plan.history, standing: plan.standing, turnContext: plan.turnContext, system, log: assembleLog, stats } };
}
function formatLogs(wi, assembled) {
    const lines = [];
    for (const entry of wi.log) {
        lines.push(`[wi:${entry.kind}] ${entry.entryKey} — ${entry.detail}`);
    }
    lines.push(`[wi:budget] limit=${wi.budget.limit} used=${wi.budget.used}${wi.budget.overflowed ? '（溢出）' : ''}`);
    if (wi.truncated.length > 0) {
        lines.push(`[wi:truncated] ${wi.truncated.length} 条命中但因预算未注入（快照尾部已附 uid 清单）`);
    }
    for (const entry of assembled.log) {
        lines.push(`[assemble:${entry.kind}] ${entry.detail}`);
    }
    const { tokensBefore, tokensAfter, trimmedSections } = assembled.stats;
    lines.push(`[assemble:budget] ${tokensBefore} → ${tokensAfter} tokens${trimmedSections.length ? `；裁剪：${trimmedSections.join(', ')}` : ''}`);
    return lines;
}
