/**
 * Prompt 组装管线（纯函数），对齐 SillyTavern Prompt Manager 语义：
 *
 * 1. 输入侧正则（input/send 然后 prompt/assemble）作用于历史副本，不动存储原文。
 * 2. 预设骨架定序：relative 条目按 order 升序置于历史之前；in-chat 条目按
 *    depth 插入历史（depth 0 = 最后一条之后），同深度按 order 升序。
 *    条目带 injection_trigger 时只在当前生成场景（generationType，现有 normal）
 *    命中才纳入序列（对齐 ST shouldTrigger）；ST 对未触发的 main 留空占位是为了
 *    扩展 relative 插入，本插件没有该机制，直接排除。
 * 3. marker 占位替换：chatHistory / worldInfoBefore / worldInfoAfter /
 *    charDescription / charPersonality / scenario / dialogueExamples /
 *    personaDescription / agentMemory（新增）/ worldState（新增）。第三方 ST 预设通常
 *    没有后两种私有 marker，存在动态内容时自动在 chatHistory 前补虚拟 system 注入。
 *    内容 marker（chatHistory/dialogueExamples 之外）放在 in-chat 位置时，解析出的
 *    内容按 depth 注入历史（对齐 ST：系统提示合并时继承 marker 的 injection_*）。
 *    chatHistory / dialogueExamples 在 ST 里只按栈位锚定、in-chat 深度无意义，跳过并记日志。
 * 4. 世界书落位：before/afterCharDefs 经 marker；变化层先参与世界书触发，但统一从
 *    worldState 落位，避免命中后在 worldInfo 与 worldState 重复注入；EM top/bottom 依附
 *    dialogueExamples marker（marker 缺席则记日志丢弃）；AN top 置于历史之前、
 *    AN bottom 置于全序列最末；@D 按 depth/role 插入历史。
 *    世界书：常驻且无本轮宏的进 standing（会话钉死后不随预算抖动）；
 *    关键词命中进 turnContext；含 EJS/STscript 的条目不注入（本插件不执行脚本）。
 * 5. 宏展开（{{char}}/{{user}}/{{description}}/{{persona}}/{{outlet::Name}}/{{setvar}} 等），
 *    outlet 内容来自世界书结果。
 *    卡级 system_prompt / post_history_instructions 里的 {{original}} 引用预设 main /
 *    jailbreak 原文（对齐 ST preparePrompt(prompt, original)）；预设对应槽位
 *    forbid_overrides=true 时卡级覆盖不注入。
 *    历史里的 {{user}}/{{char}} 在正则之前先展开，开场白才能按人设名匹配。
 * 6. Token 预算裁剪：历史永远最后裁（裁最旧的消息）；非历史内容按
 *    agentMemory → worldState → worldInfo → 示例 → 角色定义 的顺序裁。
 *
 * 输出三通道（dsh 不复制 ST「每轮整包塞进 system」）：
 * - `messages`：SillyTavern 语义全量序列（预览/调试）。
 * - `standing`：缓存稳定前缀——角色定义 + 预设骨架 + 常驻世界书（无脚本/记忆/时钟）。
 * - `turnContext`：本轮才变的触发层——关键词世界书、记忆、变化层、AN、本轮宏。
 * - `system`：standing + turnContext 的合并（预览/兼容旧调用方）。
 * live 路径把 standing 写入 system 段（order 210，在工具说明之后）、
 * turnContext 写入 runtime context；standing 再按会话指纹钉死字节。
 */
import { isSyntheticUserText } from './dshPrompt.js';
import { expandIdentityMacros, expandMacros, hasTurnLocalMacros, hasUnevaluatedScript } from './macros.js';
import { applyRegexToMessages } from './regex.js';
import { Marker, WIPosition, WIRole, } from './types.js';
const WI_ROLE_MAP = {
    [WIRole.System]: 'system',
    [WIRole.User]: 'user',
    [WIRole.Assistant]: 'assistant',
};
function joinContents(parts) {
    return parts.filter((p) => p.trim().length > 0).join('\n\n');
}
/** mes_example 按 <START> 切块（对齐 SillyTavern）。 */
export function splitExampleMessages(mesExample) {
    return mesExample
        .split(/<START>/i)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}
const CLOCK_FROZEN = { time: '', date: '', datetime: '', weekday: '' };
function joinPromptParts(parts) {
    return parts.filter((p) => p.trim().length > 0).join('\n\n');
}
/** 跳过 dsh runtime-context 快照，避免把每轮变化的 user 消息当成 {{lastusermessage}}。 */
function lastRealUserMessage(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role !== 'user')
            continue;
        if (isSyntheticUserText(m.content))
            continue;
        return m.content;
    }
    return '';
}
/** 最近一条 assistant 消息（{{lastCharMessage}}；assistant 文本无合成快照问题）。 */
function lastRealCharMessage(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === 'assistant')
            return m.content;
    }
    return '';
}
export function assemblePrompt(input) {
    const log = [];
    const unknownMacros = new Set();
    const generationType = (input.generationType ?? 'normal').toLowerCase();
    // injection_trigger（对齐 ST shouldTrigger）：空/缺省 = 全场景；否则须含当前场景。
    const triggered = (e) => (e.injectionTrigger?.length ?? 0) === 0 || e.injectionTrigger.includes(generationType);
    const macroCtx = {
        ...input.macroCtx,
        // 卡字段/人设/开场白宏：调用方可显式覆盖，缺省从组装输入取
        description: input.macroCtx.description ?? input.card?.description ?? '',
        personality: input.macroCtx.personality ?? input.card?.personality ?? '',
        scenario: input.macroCtx.scenario ?? input.card?.scenario ?? '',
        persona: input.macroCtx.persona ?? input.personaDescription,
        firstMessage: input.macroCtx.firstMessage ?? input.card?.firstMes ?? '',
        lastCharMessage: input.macroCtx.lastCharMessage ?? lastRealCharMessage(input.history),
        outlets: undefined, // outlet 在世界书求值后填充，见下
        store: input.macroCtx.store ?? new Map(),
        lastUserMessage: input.macroCtx.lastUserMessage ?? lastRealUserMessage(input.history),
        onUnknown: (name) => {
            if (!unknownMacros.has(name)) {
                unknownMacros.add(name);
                log.push({ kind: 'unknown-macro', detail: `{{${name}}}` });
            }
        },
    };
    const namedHistory = input.history.map((m) => m.content.includes('{{') ? { ...m, content: expandIdentityMacros(m.content, macroCtx) } : m);
    // ── 1. 输入侧正则（历史副本：先 input/send，再 prompt/assemble） ──────────
    const inputRegex = applyRegexToMessages(namedHistory, input.regexRules, { scope: 'input', timing: 'send' }, macroCtx);
    const regexRes = applyRegexToMessages(inputRegex.messages, input.regexRules, { scope: 'prompt', timing: 'assemble' }, macroCtx);
    let history = regexRes.messages;
    for (const e of [...inputRegex.errors, ...regexRes.errors]) {
        log.push({ kind: 'regex-error', detail: `${e.ruleId}: ${e.message}` });
    }
    // ── 2. 世界书结果分桶 ────────────────────────────────────────────────────
    const wi = input.wi;
    const outlets = {};
    if (wi) {
        for (const [name, acts] of Object.entries(wi.outlets)) {
            // outlet 内容同样做宏展开（与定位条目一致）；此处 macroCtx.outlets 尚未赋值，
            // 故内容中嵌套的 {{outlet::X}} 不会递归解析（对齐「禁止嵌套 outlet」）。
            outlets[name] = joinContents(acts.map((a) => (hasUnevaluatedScript(a.entry.content) ? '' : expandMacros(a.entry.content, macroCtx))));
        }
    }
    macroCtx.outlets = outlets;
    // standing 用独立 store：本轮 setvar（含 lastusermessage）不得泄漏进骨架 getvar。
    const turnStore = macroCtx.store ?? new Map();
    macroCtx.store = turnStore;
    const standingStore = new Map();
    const standingCtx = {
        ...macroCtx,
        store: standingStore,
        outlets: {},
        vars: { ...macroCtx.vars, ...CLOCK_FROZEN },
        lastUserMessage: '',
        lastCharMessage: '',
    };
    const expandStanding = (text, ctx = standingCtx) => {
        const out = expandMacros(text, ctx);
        for (const [k, v] of standingStore) {
            if (!turnStore.has(k))
                turnStore.set(k, v);
        }
        return out;
    };
    const expandTurn = (text) => expandMacros(text, macroCtx);
    const turnContents = new Set();
    const markTurn = (content) => {
        if (content.trim())
            turnContents.add(content);
        return content;
    };
    const skippedScripts = new Set();
    const memoryPromptMessages = new Set();
    const worldStatePromptMessages = new Set();
    const worldInfoPromptMessages = new Set();
    const examplePromptMessages = new Set();
    const characterDefinitionMessages = new Set();
    const trackedMessage = (role, content, group) => {
        const message = { role, content };
        group.add(message);
        return message;
    };
    const skipScript = (label, text) => {
        if (!hasUnevaluatedScript(text))
            return false;
        if (!skippedScripts.has(label)) {
            skippedScripts.add(label);
            log.push({ kind: 'dropped-script', detail: `${label} 含未执行 EJS/STscript，已跳过注入` });
        }
        return true;
    };
    const wiAt = (pos) => wi?.byPosition[pos] ?? [];
    /** 常驻无脚本进 standing；关键词命中进 turn；EJS 丢弃。 */
    const wiChunks = (pos) => {
        const standingParts = [];
        const turnParts = [];
        for (const a of wiAt(pos)) {
            // delta 内容由 worldState marker 统一落位；这里仍保留它参与引擎匹配/递归的结果。
            if (a.entry.source === 'delta')
                continue;
            if (skipScript(`世界书「${a.entry.key}」`, a.entry.content))
                continue;
            const standingSafe = a.entry.constant && !hasTurnLocalMacros(a.entry.content);
            const text = (standingSafe ? expandStanding(a.entry.content) : expandTurn(a.entry.content)).trim();
            if (!text)
                continue;
            if (standingSafe)
                standingParts.push(text);
            else
                turnParts.push(text);
        }
        return { standing: joinContents(standingParts), turn: joinContents(turnParts) };
    };
    const wiMessages = (pos, role) => {
        const { standing, turn } = wiChunks(pos);
        const out = [];
        if (standing)
            out.push(trackedMessage(role, standing, worldInfoPromptMessages));
        if (turn)
            out.push(trackedMessage(role, markTurn(turn), worldInfoPromptMessages));
        return out;
    };
    const wiText = (pos) => {
        const { standing, turn } = wiChunks(pos);
        return joinContents([standing, turn]);
    };
    // ── 3. marker 内容解析 ───────────────────────────────────────────────────
    const card = input.card;
    const activatedDeltaIds = new Set((wi?.activated ?? []).filter((activation) => activation.entry.source === 'delta').map((activation) => activation.entry.uid));
    const formatDelta = (delta) => {
        if (delta.type === 'update')
            return `【当前状态·更新】${delta.content}`;
        if (delta.type === 'invalidate')
            return `【当前状态·已失效】${delta.content}`;
        return delta.content;
    };
    const deltaText = joinContents(input.worldDeltas
        // 无 keys 的状态是常驻事实；有 keys 的状态只在本轮由 WI 引擎命中后注入。
        .filter((delta) => delta.keys.length === 0 || activatedDeltaIds.has(delta.id))
        .map((delta) => expandTurn(formatDelta(delta))));
    const memoryText = joinContents(input.memories.map((m) => expandTurn(m)));
    if (deltaText)
        markTurn(deltaText);
    if (memoryText)
        markTurn(memoryText);
    const markerContent = (id, role) => {
        switch (id) {
            case Marker.ChatHistory:
                return null; // 历史由骨架流程特殊处理
            case Marker.WorldInfoBefore:
                return wiMessages(WIPosition.BeforeCharDefs, role);
            case Marker.WorldInfoAfter:
                return wiMessages(WIPosition.AfterCharDefs, role);
            case Marker.CharDescription:
                return card?.description.trim()
                    ? [trackedMessage(role, expandStanding(card.description), characterDefinitionMessages)]
                    : [];
            case Marker.CharPersonality:
                return card?.personality.trim()
                    ? [trackedMessage(role, expandStanding(card.personality), characterDefinitionMessages)]
                    : [];
            case Marker.Scenario:
                return card?.scenario.trim()
                    ? [trackedMessage(role, expandStanding(card.scenario), characterDefinitionMessages)]
                    : [];
            case Marker.DialogueExamples: {
                if (!card)
                    return [];
                const blocks = splitExampleMessages(card.mesExample);
                const before = wiChunks(WIPosition.BeforeExampleMessages);
                const after = wiChunks(WIPosition.AfterExampleMessages);
                const out = [];
                if (before.standing)
                    out.push(trackedMessage(role, before.standing, worldInfoPromptMessages));
                if (before.turn)
                    out.push(trackedMessage(role, markTurn(before.turn), worldInfoPromptMessages));
                out.push(...blocks.map((b) => trackedMessage(role, expandStanding(b), examplePromptMessages)));
                if (after.standing)
                    out.push(trackedMessage(role, after.standing, worldInfoPromptMessages));
                if (after.turn)
                    out.push(trackedMessage(role, markTurn(after.turn), worldInfoPromptMessages));
                return out;
            }
            case Marker.PersonaDescription:
                return input.personaDescription.trim()
                    ? [trackedMessage(role, expandStanding(input.personaDescription), characterDefinitionMessages)]
                    : [];
            case Marker.AgentMemory:
                return memoryText ? [trackedMessage(role, memoryText, memoryPromptMessages)] : [];
            case Marker.WorldState:
                return deltaText ? [trackedMessage(role, deltaText, worldStatePromptMessages)] : [];
            default:
                log.push({ kind: 'unknown-marker', detail: id });
                return [];
        }
    };
    // EM 依附的 marker 缺席时，其世界书条目无处落位——记日志（对齐 ST 语义：marker 即落位点）
    if (wi) {
        const hasEmMarker = input.preset.entries.some((e) => e.marker && e.markerId === Marker.DialogueExamples && e.enabled && triggered(e));
        if (!hasEmMarker) {
            for (const pos of [WIPosition.BeforeExampleMessages, WIPosition.AfterExampleMessages]) {
                for (const a of wiAt(pos)) {
                    log.push({ kind: 'dropped-marker-content', detail: `dialogueExamples marker 缺席，丢弃 EM 条目 ${a.entry.key}` });
                }
            }
        }
    }
    // ── 4. relative 骨架（历史之前部分 + 历史之后部分） ──────────────────────
    const relative = input.preset.entries
        .filter((e) => e.enabled && e.position === 'relative' && triggered(e))
        .sort((a, b) => a.order - b.order || a.identifier.localeCompare(b.identifier));
    // 兜底注入按「预设里是否存在该 marker」判定，不限 relative——in-chat 的同名 marker 已有落位。
    const presentMarkerIds = new Set(input.preset.entries.filter((e) => e.enabled && e.marker && triggered(e)).map((e) => e.markerId));
    const beforeHistory = [];
    const afterHistory = [];
    let seenHistory = false;
    let insertedFallbackMarkers = false;
    const insertFallbackMarkers = () => {
        if (insertedFallbackMarkers)
            return;
        insertedFallbackMarkers = true;
        if (memoryText && !presentMarkerIds.has(Marker.AgentMemory)) {
            beforeHistory.push(trackedMessage('system', memoryText, memoryPromptMessages));
            log.push({ kind: 'auto-marker', detail: '预设缺少 agentMemory marker，已在 chatHistory 前自动注入检索记忆' });
        }
        if (deltaText && !presentMarkerIds.has(Marker.WorldState)) {
            beforeHistory.push(trackedMessage('system', deltaText, worldStatePromptMessages));
            log.push({ kind: 'auto-marker', detail: '预设缺少 worldState marker，已在 chatHistory 前自动注入世界状态' });
        }
    };
    for (const entry of relative) {
        if (entry.marker && entry.markerId === Marker.ChatHistory) {
            insertFallbackMarkers();
            seenHistory = true;
            continue;
        }
        const bucket = seenHistory ? afterHistory : beforeHistory;
        if (entry.marker) {
            const content = markerContent(entry.markerId ?? '', entry.role);
            if (content)
                bucket.push(...content);
            continue;
        }
        if (!entry.content.trim())
            continue;
        if (skipScript(`预设「${entry.identifier}」`, entry.content))
            continue;
        const turnLocal = hasTurnLocalMacros(entry.content);
        const text = (turnLocal ? expandTurn(entry.content) : expandStanding(entry.content)).trim();
        if (!text)
            continue; // setvar/注释/trim 预处理后为空，不进模型
        if (turnLocal)
            markTurn(text);
        bucket.push({ role: entry.role, content: text });
    }
    // 没有 chatHistory marker 时，组装器仍会在骨架后追加历史；动态私有层紧贴该边界。
    if (!seenHistory)
        insertFallbackMarkers();
    // 卡片级 system_prompt / post_history_instructions。
    // {{original}} 引用预设 main / jailbreak 原文（对齐 ST preparePrompt(prompt, original)）：
    // 经 vars 注入，只在展开卡级覆盖时可见；原文里的宏随多轮展开正常展开。
    // 预设槽位 forbid_overrides=true 时拒绝卡级覆盖（对齐 ST preparePromptsForChatCompletion）。
    const slotEntry = (identifier) => input.preset.entries.find((e) => e.identifier === identifier && !e.marker && triggered(e));
    const withOriginal = (original) => ({
        ...standingCtx,
        vars: { ...standingCtx.vars, original },
    });
    const mainEntry = slotEntry('main');
    if (card?.systemPrompt.trim() && mainEntry?.forbidOverrides !== true) {
        beforeHistory.unshift(trackedMessage('system', expandStanding(card.systemPrompt, withOriginal(mainEntry?.content ?? '')), characterDefinitionMessages));
    }
    const jailbreakEntry = slotEntry('jailbreak');
    if (card?.postHistoryInstructions.trim() && jailbreakEntry?.forbidOverrides !== true) {
        afterHistory.push(trackedMessage('system', expandStanding(card.postHistoryInstructions, withOriginal(jailbreakEntry?.content ?? '')), characterDefinitionMessages));
    }
    // ── 5. 深度注入合并：预设 in-chat 条目 + 世界书 @D ───────────────────────
    const depthInjections = [];
    for (const entry of input.preset.entries) {
        if (!entry.enabled || entry.position !== 'in-chat' || !triggered(entry))
            continue;
        if (entry.marker) {
            const id = entry.markerId ?? '';
            // chatHistory / dialogueExamples 在 ST 里只按栈位锚定，in-chat 深度无意义——跳过并记日志。
            if (id === Marker.ChatHistory || id === Marker.DialogueExamples) {
                log.push({ kind: 'dropped-marker-content', detail: `in-chat 位置的 ${id} marker 无深度锚定语义（ST 按栈位锚定），已跳过` });
                continue;
            }
            // 其余内容 marker：对齐 ST「系统提示合并时继承 marker 的 injection_*」，解析内容按 depth 注入。
            const resolved = markerContent(id, entry.role);
            if (resolved === null || resolved.length === 0)
                continue;
            for (const m of resolved) {
                depthInjections.push({ depth: entry.depth, order: entry.order, role: m.role, content: m.content });
            }
            continue;
        }
        if (!entry.content.trim())
            continue;
        if (skipScript(`预设 in-chat「${entry.identifier}」`, entry.content))
            continue;
        const turnLocal = hasTurnLocalMacros(entry.content);
        const content = (turnLocal ? expandTurn(entry.content) : expandStanding(entry.content)).trim();
        if (!content)
            continue;
        if (turnLocal)
            markTurn(content);
        depthInjections.push({ depth: entry.depth, order: entry.order, role: entry.role, content });
    }
    for (const a of wiAt(WIPosition.AtDepth)) {
        if (skipScript(`世界书 @D「${a.entry.key}」`, a.entry.content))
            continue;
        const content = expandTurn(a.entry.content).trim();
        if (!content)
            continue;
        markTurn(content);
        depthInjections.push({
            depth: a.entry.depth,
            order: a.entry.order,
            role: WI_ROLE_MAP[a.entry.role],
            content,
        });
    }
    const depthPrompt = input.card?.depthPrompt;
    if (depthPrompt?.prompt.trim()) {
        if (!skipScript('角色 depth_prompt', depthPrompt.prompt)) {
            const content = expandTurn(depthPrompt.prompt).trim();
            if (content) {
                markTurn(content);
                depthInjections.push({
                    depth: depthPrompt.depth,
                    order: 0,
                    role: depthPrompt.role,
                    content,
                });
            }
        }
    }
    // AN bottom：全序列最末；AN top：历史之前
    const anTop = wiText(WIPosition.AuthorNoteTop);
    if (anTop)
        beforeHistory.push(trackedMessage('system', markTurn(anTop), worldInfoPromptMessages));
    const sessionNote = input.authorNote?.trim() ? expandTurn(input.authorNote).trim() : '';
    if (sessionNote)
        beforeHistory.push(trackedMessage('system', markTurn(`【作者注释】${sessionNote}`), worldInfoPromptMessages));
    const journalNote = input.journalText?.trim() ? expandTurn(input.journalText).trim() : '';
    if (journalNote)
        beforeHistory.push(trackedMessage('system', markTurn(`【角色笔记】${journalNote}`), worldInfoPromptMessages));
    const anBottom = wiText(WIPosition.AuthorNoteBottom);
    const anBottomMessage = anBottom
        ? trackedMessage('system', markTurn(anBottom), worldInfoPromptMessages)
        : null;
    if (skippedScripts.size > 0) {
        const note = `（已跳过 ${skippedScripts.size} 条未展开的脚本条目；需要设定细节时用 tavern_lore_read 按 uid/关键词取条。）`;
        afterHistory.push({ role: 'system', content: markTurn(note) });
    }
    // ── 6. 历史内插入（深 depth 先插，同 depth order 升序） ─────────────────
    const byDepth = new Map();
    for (const inj of depthInjections) {
        if (inj.depth === 0)
            continue // depth 0 = 历史之后，单独处理
            ;
        (byDepth.get(inj.depth) ?? byDepth.set(inj.depth, []).get(inj.depth)).push(inj);
    }
    const depths = [...byDepth.keys()].sort((a, b) => b - a);
    for (const depth of depths) {
        const at = Math.max(0, history.length - depth);
        const group = byDepth.get(depth).sort((a, b) => a.order - b.order);
        history.splice(at, 0, ...group.map((g) => ({ role: g.role, content: g.content })));
    }
    const depth0 = depthInjections.filter((d) => d.depth === 0).sort((a, b) => a.order - b.order);
    // ── 7. 全量序列与预算裁剪（历史最后裁） ──────────────────────────────────
    const tail = [
        ...depth0.map((d) => ({ role: d.role, content: d.content })),
        ...(anBottomMessage ? [anBottomMessage] : []),
        ...afterHistory,
    ];
    const estimate = (m) => input.estimateTokens(m.content);
    const totalBudget = Math.max(0, input.budget.maxTokens - input.budget.reserveForOutput);
    const tokensOf = (msgs) => msgs.reduce((s, m) => s + estimate(m), 0);
    const tokensBefore = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail);
    const trimmedSections = [];
    // 非历史裁剪优先级（先裁动态）：agentMemory → worldState → worldInfo → 角色定义/示例
    const trimNonHistory = (predicate, label) => {
        let tokens = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail);
        if (tokens <= totalBudget)
            return;
        for (const bucket of [beforeHistory, tail]) {
            for (let i = bucket.length - 1; i >= 0 && tokens > totalBudget; i--) {
                const m = bucket[i];
                if (!predicate(m))
                    continue;
                bucket.splice(i, 1);
                tokens -= estimate(m);
                trimmedSections.push(label);
            }
        }
    };
    trimNonHistory((m) => memoryPromptMessages.has(m), 'agentMemory');
    trimNonHistory((m) => worldStatePromptMessages.has(m), 'worldState');
    trimNonHistory((m) => worldInfoPromptMessages.has(m), 'worldInfo');
    trimNonHistory((m) => examplePromptMessages.has(m), 'dialogueExamples');
    trimNonHistory((m) => characterDefinitionMessages.has(m), 'characterDefinitions');
    // 历史裁剪：丢最旧的消息（保留最新用户输入）
    {
        let tokens = tokensOf(beforeHistory) + tokensOf(history) + tokensOf(tail);
        while (tokens > totalBudget && history.length > 1) {
            const dropped = history.shift();
            tokens -= estimate(dropped);
            trimmedSections.push('history');
        }
    }
    const messages = [...beforeHistory, ...history, ...tail];
    const tokensAfter = tokensOf(messages);
    for (const label of trimmedSections)
        log.push({ kind: 'trim', detail: label });
    // ── 8. dsh 通道：standing（稳定前缀）与 turnContext（本轮触发层）分开 ──
    const outsideHistory = [...beforeHistory, ...tail];
    const standing = joinPromptParts(outsideHistory.filter((m) => !turnContents.has(m.content)).map((m) => m.content));
    // 插进历史中间的 @D / depth_prompt / in-chat 预览能看到；live 不能改日志，并入 turn 尾。
    const splicedLive = depthInjections.filter((d) => d.depth !== 0).map((d) => d.content);
    const turnContext = joinPromptParts([
        ...outsideHistory.filter((m) => turnContents.has(m.content)).map((m) => m.content),
        ...splicedLive,
    ]);
    const system = joinPromptParts([standing, turnContext]);
    return {
        messages,
        standing,
        turnContext,
        system,
        history,
        log,
        stats: { tokensBefore, tokensAfter, trimmedSections },
    };
}
/** 导出一个最小可用预设（ST 默认骨架 + 本插件 marker）。 */
export function defaultPreset() {
    const entry = (partial) => ({
        role: 'system',
        enabled: true,
        position: 'relative',
        depth: 4,
        order: 100,
        content: '',
        marker: false,
        ...partial,
    });
    let order = 0;
    const next = () => (order += 10);
    return {
        name: 'Tavern 默认预设',
        identifier: 'tavern-default',
        entries: [
            entry({
                identifier: 'main',
                name: 'Main Prompt',
                order: next(),
                content: 'Write {{char}}\'s next reply in a fictional roleplay between {{char}} and {{user}}.',
            }),
            entry({ identifier: Marker.WorldInfoBefore, name: 'World Info (before)', marker: true, markerId: Marker.WorldInfoBefore, order: next() }),
            entry({ identifier: Marker.PersonaDescription, name: 'Persona Description', marker: true, markerId: Marker.PersonaDescription, order: next() }),
            entry({ identifier: Marker.CharDescription, name: 'Char Description', marker: true, markerId: Marker.CharDescription, order: next() }),
            entry({ identifier: Marker.CharPersonality, name: 'Char Personality', marker: true, markerId: Marker.CharPersonality, order: next() }),
            entry({ identifier: Marker.Scenario, name: 'Scenario', marker: true, markerId: Marker.Scenario, order: next() }),
            entry({ identifier: Marker.AgentMemory, name: '检索记忆', marker: true, markerId: Marker.AgentMemory, order: next() }),
            entry({ identifier: Marker.WorldState, name: '世界状态变化层', marker: true, markerId: Marker.WorldState, order: next() }),
            entry({ identifier: 'nsfw', name: 'Auxiliary Prompt', order: next(), content: '' }),
            entry({ identifier: Marker.WorldInfoAfter, name: 'World Info (after)', marker: true, markerId: Marker.WorldInfoAfter, order: next() }),
            entry({ identifier: Marker.DialogueExamples, name: 'Dialogue Examples', marker: true, markerId: Marker.DialogueExamples, order: next() }),
            entry({ identifier: Marker.ChatHistory, name: 'Chat History', marker: true, markerId: Marker.ChatHistory, order: next() }),
            entry({ identifier: 'jailbreak', name: 'Post-History Instructions', order: next(), content: '' }),
        ],
    };
}
