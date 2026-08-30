import { assemblePrompt, defaultPreset, isDeltaRenderedInTurn } from '../core/assemble.js';
import { isSyntheticUserText } from '../core/dshPrompt.js';
import { createTurnRandom, hashToSeed } from '../core/macros.js';
import { memorySearchOptions, selectMemoryBodies } from '../core/memoryRetrieval.js';
import { clipToTokenBudget, estimateTokens } from '../core/tokenize.js';
import { EMPTY_TIMER_STATE } from '../core/types.js';
import { evaluateWorldInfo } from '../core/worldbook.js';
import { clipWorldDeltasForTurn } from '../core/turnBudget.js';
import { DEFAULT_USER_NAME } from '../core/persona.js';
import { parseLorebook } from '../state/lorebook.js';
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
    const ws = await state.workspace(binding.cardId);
    const groups = [];
    // 全局世界书
    for (const id of binding.lorebookIds) {
        groups.push(await state.loadLorebookEntries(id, 'global'));
    }
    // 主世界书（Character Lore）：绑定指定库文件 > 卡内嵌书（card.json / assets/character-book.json）
    if (binding.characterLorebookId) {
        groups.push(await state.loadLorebookEntries(binding.characterLorebookId, 'character'));
    }
    else {
        const embedded = await state.loadCharacterLorebookRaw(binding.cardId);
        if (embedded)
            groups.push(parseLorebook(embedded.json, { source: 'character', sourceRef: binding.cardId }));
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
    const { state, sessionId } = input;
    // turn/start 的监听器异步开 WAL；提示词/工具热路径必须等它完成后才能产生工作区写入。
    await state.waitForSessionTasks(sessionId);
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        return null;
    const charWs = await state.loadCharacter(binding.cardId);
    if (!charWs)
        return null;
    const card = charWs.card;
    const ws = await state.workspace(binding.cardId);
    const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset();
    const persona = await state.resolvePersona(binding.personaId);
    const userName = persona?.name ?? DEFAULT_USER_NAME;
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
    const lastUserMessage = pendingFresh.at(-1) ?? [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const config = state.config;
    const contextWindow = await resolveContextWindow(input);
    const turn = state.currentTurns.get(sessionId) ?? -1;
    const turnSeed = hashToSeed(`${sessionId}:${turn}`);
    const macroCtx = {
        char: card.name,
        user: userName,
        lastUserMessage,
        random: createTurnRandom(turnSeed ^ 0x9e3779b9),
    };
    // ── WI / 记忆 / 变化层：每 turn 评估一次并缓存 ──
    // 缓存只服务「live 且已知 turn 号」的评估：
    // preview（预览提示词 / 代答）用空定时器评估，既不能复用本轮 live 的结果，也绝不能写进缓存——
    // 否则本 turn 的 live 评估会沿用这份无定时器的结果，sticky/cooldown 被免定时器地决定且永不落盘。
    // 且 idle 时 turn 恒为 -1，各次预览之间也不该互相复用（绑定/世界书/记忆随时可能被编辑）。
    // 代价是每次预览/代答多评估一次世界书——正确且便宜。
    const cacheable = input.mode === 'live' && turn >= 0;
    let wi;
    let memories;
    let deltas;
    let lastCharMessage;
    let journalText;
    const cached = cacheable ? state.wiCache.get(sessionId) : undefined;
    if (cached && cached.turn === turn) {
        // 同轮后续步：lastCharMessage / journalText 一并复用——history 增长（assistant 文本）
        // 与 journal 中途编辑不得改变快照字节，否则宿主按字节去重失效、每步多付一份快照。
        ;
        ({ wi, memories, deltas, lastCharMessage, journalText } = cached);
    }
    else {
        const { entries, deltas: liveDeltas } = await loadBoundLoreEntries(state, binding);
        deltas = liveDeltas;
        const timerState = input.mode === 'live' ? await state.loadTimers(binding.cardId, sessionId) : structuredClone(EMPTY_TIMER_STATE);
        const reservedTokens = estimateTokens(scanMessages.map((m) => m.content).join('\n'));
        wi = evaluateWorldInfo({
            entries,
            messages: scanMessages,
            settings: config.worldInfo,
            timerState,
            contextWindowTokens: contextWindow,
            reservedTokens,
            estimateTokens,
            random: createTurnRandom(turnSeed),
            macroCtx: { char: card.name, user: userName },
        });
        if (input.mode === 'live') {
            await state.saveTimers(binding.cardId, sessionId, wi.timerState);
        }
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
        if (cacheable)
            state.wiCache.set(sessionId, { turn, wi, memories, deltas, lastCharMessage, journalText });
    }
    // 变化层进快照前按预算裁剪：预算只覆盖真正会渲染的条目（无键常驻 + 本轮被引擎命中的
    // 有键条目，判定与 assemble 共用 isDeltaRenderedInTurn），未命中的有键变化不占快照预算。
    // 从最新往旧保留（WORLD_DELTA_TURN_BUDGET），更旧的不随快照每轮重付，
    // 模型可经 tavern_lore_read(source=delta) 按条补读。
    // 引擎触发改用全量 delta（上面 evaluateWorldInfo 的 entries），裁剪只影响展示层。
    const activatedDeltaIds = new Set(wi.activated.filter((a) => a.entry.source === 'delta').map((a) => a.entry.uid));
    const deltaClip = clipWorldDeltasForTurn(deltas.filter((d) => isDeltaRenderedInTurn(d, activatedDeltaIds)), estimateTokens);
    const assembled = assemblePrompt({
        preset,
        card,
        personaDescription: persona?.description ?? '',
        history: scanMessages,
        wi,
        memories,
        worldDeltas: deltaClip.kept,
        authorNote: binding.authorNote ?? '',
        journalText,
        // 显式冻结 lastCharMessage（同轮复用缓存值），不让 assemble 回退到随 history 增长的现算值。
        macroCtx: { ...macroCtx, lastCharMessage },
        regexRules: await state.rulesFor(binding),
        // ST injection_trigger 评估用：当前正常发信是 normal；continue/impersonate 经 PipelineInput 传入。
        generationType: input.generationType ?? 'normal',
        estimateTokens,
        budget: {
            maxTokens: contextWindow,
            reserveForOutput: config.sampling.maxTokens ?? FALLBACK_RESERVE_OUTPUT,
        },
    });
    const logLines = formatLogs(wi, assembled);
    // turn 尾巴体积(缓存观测):快照对新请求永远是未缓存前缀,体积即每轮全价重付的量。
    logLines.push(`[turn:tail] turnContext≈${estimateTokens(assembled.turnContext)} tokens`);
    if (deltaClip.dropped > 0) {
        logLines.push(`[turn:tail] 变化层超预算裁掉 ${deltaClip.dropped} 条（tavern_lore_read source=delta 可补读）`);
    }
    state.recordTriggerLog(sessionId, logLines);
    return {
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
