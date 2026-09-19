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
 *    关键词命中进 turnContext；EJS 经注入的隔离执行器展开后进 turn，STscript 跳过。
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
 * - `standing`：缓存稳定前缀——历史前的静态角色/预设/世界书 + 非零深度静态注入。
 * - `turnContext`：关键词世界书、记忆、变化层、AN、本轮宏；最后保留历史后条目与 depth=0。
 * - `system`：standing + turnContext 的合并（预览/兼容旧调用方）。
 * live 路径把 standing 写入工具说明后的 system 段，turnContext 写入 runtime context；
 * 有尾部指令时由 pipeline 加本轮标记，避免宿主跨轮去重使指令留在旧历史位置。
 */
import { isSyntheticUserText } from './dshPrompt.js';
import { expandIdentityMacros, expandMacros, hasUnevaluatedScript } from './macros.js';
import { createMacroDependencyTracker } from './macroDependencies.js';
import { applyRegexToMessages } from './regex.js';
import { isStandingSafeEntry } from './worldbook.js';
import { hasEjs } from './template.js';
import { createPromptLayout, promptDepthPlacement, promptHistoryAnchors } from './promptLayout.js';
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
/** ST 完整历史的正向顺序：同深度先 order，再 assistant / user / system；同角色保持原栈顺序。 */
const DEPTH_ROLE_ORDER = { assistant: 0, user: 1, system: 2 };
function compareDepthInjections(a, b) {
    return a.order - b.order || DEPTH_ROLE_ORDER[a.role] - DEPTH_ROLE_ORDER[b.role];
}
const CLOCK_FROZEN = { time: '', date: '', datetime: '', weekday: '' };
/** 快照尾部「命中但未注入」清单最多列出的条数（超出折叠为「等 N 条」）。 */
const WI_TRUNCATED_HINT_MAX = 8;
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
/** lastmessage 包含最近角色回复；系统段与宿主合成输入都不是聊天正文。 */
function lastRealMessage(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i];
        if (message.role === 'assistant' || (message.role === 'user' && !isSyntheticUserText(message.content)))
            return message.content;
    }
    return '';
}
/**
 * 变化层条目本轮是否进快照渲染：无 keys = 常驻事实；有 keys = 本轮被 WI 引擎命中才注入。
 * 本函数由 assemble（渲染过滤）与 pipeline（进快照预算裁剪）共用，两处判定不得漂移。
 */
export function isDeltaRenderedInTurn(delta, activatedDeltaIds) {
    return delta.keys.length === 0 || activatedDeltaIds.has(delta.id);
}
export function assemblePrompt(input) {
    const log = [];
    const layoutHistory = promptHistoryAnchors(input.history, input.historyMessageIds, input.historyChatFlags);
    const chatHistory = input.history.filter((_, index) => layoutHistory[index].chat);
    let remainingChat = layoutHistory.filter(anchor => anchor.chat).length;
    const historyDepths = layoutHistory.map(anchor => { if (anchor.chat)
        remainingChat--; return remainingChat; });
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
        charPrompt: input.promptPreferences?.preferCharacterPrompt === false ? '' : input.macroCtx.charPrompt ?? input.card?.systemPrompt ?? '',
        charInstruction: input.promptPreferences?.preferCharacterInstructions === false ? '' : input.macroCtx.charInstruction ?? input.card?.postHistoryInstructions ?? '',
        lastMessage: input.macroCtx.lastMessage ?? lastRealMessage(chatHistory),
        lastCharMessage: input.macroCtx.lastCharMessage ?? lastRealCharMessage(chatHistory),
        outlets: undefined, // outlet 在世界书求值后填充，见下
        store: input.macroCtx.store ?? new Map(),
        lastUserMessage: input.macroCtx.lastUserMessage ?? lastRealUserMessage(chatHistory),
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
    const sendRegex = applyRegexToMessages(regexRes.messages, input.regexRules, { scope: 'prompt', timing: 'send' }, macroCtx);
    let history = sendRegex.messages;
    for (const e of [...inputRegex.errors, ...regexRes.errors, ...sendRegex.errors]) {
        log.push({ kind: 'regex-error', detail: `${e.ruleId}: ${e.message}` });
    }
    // ── 2. 世界书结果分桶 ────────────────────────────────────────────────────
    const wi = input.wi;
    const templateCache = new Map();
    const renderTemplate = (text, source = text, context = macroCtx) => {
        if (!hasEjs(text) && !input.processTemplateSequence)
            return text;
        if (!input.renderTemplate)
            throw new Error('EJS 模板需要隔离执行器');
        const cached = templateCache.get(source);
        if (cached !== undefined)
            return cached;
        let rendered;
        try {
            rendered = input.renderTemplate(text, source, context);
        }
        catch (error) {
            throw new Error(`模板「${source === text ? '文本' : source}」：${error instanceof Error ? error.message : String(error)}`);
        }
        templateCache.set(source, rendered);
        return rendered;
    };
    // 历史 EJS 仅处理模拟副本，真实宿主消息不在这个函数的写入范围。
    if (input.processTemplateSequence)
        history = history.map((message, index) => ({ ...message,
            content: renderTemplate(message.content, `history:${index}`, macroCtx) }));
    const originalHistory = new Set(history);
    const historyDepth = new Map(history.map((message, index) => [message, historyDepths[index]]));
    const historyAnchors = new Map(history.map((message, index) => [message, layoutHistory[index]]));
    const processedHistory = new Map();
    // 按实际求值顺序传播变量依赖，避免动态 setvar 的读取者误入稳定前缀。
    const conditionalFormats = input.preset.formatting?.worldInfo;
    const macroDependencies = createMacroDependencyTracker(macroCtx, [
        ...(input.potentialMacroSources ?? []),
        // 世界书格式仅在有命中正文时执行；即使首轮未命中，其变量写入也可能影响后续轮读取。
        ...(conditionalFormats ? [{ text: conditionalFormats, turnLocal: true }] : []),
    ]);
    const dynamic = (text, ctx = macroCtx) => macroDependencies.isDynamic(text, ctx);
    const expandTracked = (text, ctx, turnLocal) => {
        macroDependencies.record(text, ctx, turnLocal);
        return expandMacros(text, ctx);
    };
    const outlets = {};
    if (wi) {
        for (const [name, acts] of Object.entries(wi.outlets)) {
            // outlet 内容同样做宏展开（与定位条目一致）；此处 macroCtx.outlets 尚未赋值，
            // 故内容中嵌套的 {{outlet::X}} 不会递归解析（对齐「禁止嵌套 outlet」）。
            outlets[name] = joinContents(acts.map((a) => (hasUnevaluatedScript(a.entry.content) && !hasEjs(a.entry.content) ? '' : renderTemplate(expandTracked(a.entry.content, macroCtx, true), a.entry.key))));
        }
    }
    macroCtx.outlets = outlets;
    // 变量值按一份表顺序读写；是否能进入 standing 由来源依赖判定。分表会丢失动态
    // setvar 的后续 getvar，也会让后写的静态赋值无法覆盖 turn 中已有的旧值。
    const standingCtx = {
        ...macroCtx,
        outlets: {},
        vars: { ...macroCtx.vars, ...CLOCK_FROZEN },
        lastUserMessage: '',
        lastCharMessage: '',
        lastMessage: '',
    };
    const expandStanding = (text, ctx = standingCtx, source = text) => {
        const turnLocal = dynamic(text, ctx);
        const effective = turnLocal ? { ...ctx, ...macroCtx, vars: { ...macroCtx.vars, ...(ctx.vars?.original === undefined ? {} : { original: ctx.vars.original }) } } : ctx;
        return expandTracked(renderTemplate(expandTracked(text, effective, turnLocal), source, effective), effective, turnLocal);
    };
    const expandTurn = (text, source = text) => expandTracked(renderTemplate(expandTracked(text, macroCtx, true), source, macroCtx), macroCtx, true);
    /**
     * turn 侧消息按对象身份追踪，不按内容字节：两条展开后同字节的消息若分属 standing/turn，
     * 按字节匹配会把 standing 那条误踢进每轮重付的 turn 层（前缀缓存白丢）。
     */
    const turnMessages = new Set();
    const asTurn = (message) => {
        if (message.content.trim())
            turnMessages.add(message);
        return message;
    };
    const skippedScripts = new Set();
    const memoryPromptMessages = new Set();
    const worldStatePromptMessages = new Set();
    const worldInfoPromptMessages = new Set();
    const examplePromptMessages = new Set();
    const characterDefinitionMessages = new Set();
    const messageSources = new Map();
    const relativeOrders = new Map();
    const trackedMessage = (role, content, group, sourceKeys) => {
        const message = { role, content };
        group.add(message);
        messageSources.set(message, sourceKeys ?? [group === memoryPromptMessages ? 'memory'
                : group === worldStatePromptMessages ? 'world-state' : group === worldInfoPromptMessages ? 'world-info'
                    : group === examplePromptMessages ? 'card:examples' : 'character-definition']);
        return message;
    };
    const definition = (role, raw, group = characterDefinitionMessages, ctx = standingCtx, source = raw) => {
        const turnLocal = dynamic(raw, ctx);
        const message = trackedMessage(role, expandStanding(raw, ctx, source), group, [source]);
        return turnLocal ? asTurn(message) : message;
    };
    const skipScript = (label, text) => {
        if (hasEjs(text) && input.renderTemplate)
            return false;
        if (!hasUnevaluatedScript(text))
            return false;
        if (!skippedScripts.has(label)) {
            skippedScripts.add(label);
            log.push({ kind: 'dropped-script', detail: `${label} 含未执行 EJS/STscript，已跳过注入` });
        }
        return true;
    };
    const wiAt = (pos) => wi?.byPosition[pos] ?? [];
    /**
     * 世界书/记忆在 standing 与快照里默认是裸文本拼接，模型难以识别为「设定事实」。
     * 落消息时统一加来源标签（AN 走 wiText 不加，保留作者注释原始语义与尾部注意力位置）。
     */
    const WI_LABEL_STANDING = '【世界书·常驻】';
    const WI_LABEL_TURN = '【世界书·本轮触发】';
    const labelWi = (text, standingSide) => `${standingSide ? WI_LABEL_STANDING : WI_LABEL_TURN}\n${text}`;
    /** 常驻无脚本进 standing；关键词与隔离展开的 EJS 进 turn。 */
    const wiChunks = (pos) => {
        const standingParts = [];
        const turnParts = [];
        const standingSources = [];
        const turnSources = [];
        for (const a of wiAt(pos)) {
            // delta 内容由 worldState marker 统一落位；这里仍保留它参与引擎匹配/递归的结果。
            if (a.entry.source === 'delta')
                continue;
            if (skipScript(`世界书「${a.entry.key}」`, a.entry.content))
                continue;
            // standing/turn 分流与引擎的预算豁免共用同一判定（isStandingSafeEntry），不得漂移。
            const standingSafe = isStandingSafeEntry(a.entry) && !dynamic(a.entry.content);
            const text = (standingSafe ? expandStanding(a.entry.content, standingCtx, a.entry.key) : expandTurn(a.entry.content, a.entry.key)).trim();
            if (!text)
                continue;
            if (standingSafe) {
                standingParts.push(text);
                standingSources.push(a.entry.key);
            }
            else {
                turnParts.push(text);
                turnSources.push(a.entry.key);
            }
        }
        return { standing: joinContents(standingParts), turn: joinContents(turnParts), standingSources, turnSources };
    };
    const wiMessages = (pos, role) => {
        const { standing, turn, standingSources, turnSources } = wiChunks(pos);
        const out = [];
        if (!standing && !turn)
            return out;
        const format = input.preset.formatting?.worldInfo;
        if (format !== undefined) {
            if (skipScript('世界书格式模板', format))
                return out;
            // 只展开包装自身的宏，再在字面布局中保留正文的独立来源占位。先注册包装会把
            // {0} 藏进未展开来源；注册一个聚合父来源又会在 activewi 重组时冻结旧条目集合。
            // 已处理的正文不重新经过宏展开，模板阶段仍能逐条冻结世界书来源。
            const turnLocal = dynamic(format);
            const context = turnLocal ? macroCtx : standingCtx;
            const wrapper = format.trim() ? expandTracked(format, context, turnLocal) : '{0}';
            for (const [text, local, sources] of [[standing, turnLocal, standingSources], [turn, true, turnSources]]) {
                if (!text)
                    continue;
                const content = wrapper.replaceAll('{0}', () => text);
                if (!content.trim())
                    continue;
                const message = trackedMessage(role, content, worldInfoPromptMessages, ['preset:format:world-info', ...sources]);
                out.push(local ? asTurn(message) : message);
            }
        }
        else {
            if (standing)
                out.push(trackedMessage(role, labelWi(standing, true), worldInfoPromptMessages, standingSources));
            if (turn)
                out.push(asTurn(trackedMessage(role, labelWi(turn, false), worldInfoPromptMessages, turnSources)));
        }
        return out;
    };
    const wiTextSources = new Map();
    const wiText = (pos) => {
        const { standing, turn, standingSources, turnSources } = wiChunks(pos);
        wiTextSources.set(pos, [...standingSources, ...turnSources]);
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
        .filter((delta) => isDeltaRenderedInTurn(delta, activatedDeltaIds))
        .map((delta) => expandTurn(formatDelta(delta))));
    const memoryBodies = joinContents(input.memories.map((m) => expandTurn(m)));
    // 检索记忆同样加来源标签（与世界书标签同一目的：让模型识别为事实层而非叙述）。
    const memoryText = memoryBodies ? `【检索记忆】\n${memoryBodies}` : '';
    // 记忆/变化层永远进 turn：在创建消息处（markerContent / insertFallbackMarkers）按对象标记。
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
                    ? [definition(role, card.description, characterDefinitionMessages, standingCtx, 'card:description')]
                    : [];
            case Marker.CharPersonality:
                return card?.personality.trim()
                    ? [definition(role, input.preset.formatting?.personality ? input.preset.formatting.personality : card.personality, characterDefinitionMessages, standingCtx, 'card:personality')]
                    : [];
            case Marker.Scenario:
                return card?.scenario.trim()
                    ? [definition(role, input.preset.formatting?.scenario ? input.preset.formatting.scenario : card.scenario, characterDefinitionMessages, standingCtx, 'card:scenario')]
                    : [];
            case Marker.DialogueExamples: {
                if (!card)
                    return [];
                const blocks = splitExampleMessages(card.mesExample);
                const before = wiChunks(WIPosition.BeforeExampleMessages);
                const after = wiChunks(WIPosition.AfterExampleMessages);
                const out = [];
                if (before.standing)
                    out.push(trackedMessage(role, labelWi(before.standing, true), worldInfoPromptMessages, before.standingSources));
                if (before.turn)
                    out.push(asTurn(trackedMessage(role, labelWi(before.turn, false), worldInfoPromptMessages, before.turnSources)));
                out.push(...blocks.map((b, index) => definition(role, b, examplePromptMessages, standingCtx, `card:example:${index}`)));
                if (after.standing)
                    out.push(trackedMessage(role, labelWi(after.standing, true), worldInfoPromptMessages, after.standingSources));
                if (after.turn)
                    out.push(asTurn(trackedMessage(role, labelWi(after.turn, false), worldInfoPromptMessages, after.turnSources)));
                return out;
            }
            case Marker.PersonaDescription:
                return input.personaDescription.trim()
                    ? [definition(role, input.personaDescription, characterDefinitionMessages, standingCtx, 'persona')]
                    : [];
            case Marker.AgentMemory:
                return memoryText ? [asTurn(trackedMessage(role, memoryText, memoryPromptMessages))] : [];
            case Marker.WorldState:
                return deltaText ? [asTurn(trackedMessage(role, deltaText, worldStatePromptMessages))] : [];
            default:
                log.push({ kind: 'unknown-marker', detail: id });
                return [];
        }
    };
    // EM 依附的 marker 缺席时，其世界书条目无处落位——记日志（对齐 ST 语义：marker 即落位点）。
    // 只认 relative：in-chat 的 dialogueExamples marker 无深度锚定语义（下方第 5 步跳过），
    // 不能作为 EM 落位点，否则唯一的 marker 处于 in-chat 时条目被静默丢弃且无任何日志。
    if (wi) {
        const hasEmMarker = input.preset.entries.some((e) => e.marker && e.markerId === Marker.DialogueExamples && e.enabled && e.position === 'relative' && triggered(e));
        if (!hasEmMarker) {
            for (const pos of [WIPosition.BeforeExampleMessages, WIPosition.AfterExampleMessages]) {
                for (const a of wiAt(pos)) {
                    log.push({ kind: 'dropped-marker-content', detail: `dialogueExamples marker 缺席（in-chat 位置无锚定语义），丢弃 EM 条目 ${a.entry.key}` });
                }
            }
        }
    }
    // ── 4. relative 骨架（历史之前部分 + 历史之后部分） ──────────────────────
    const relative = input.preset.entries
        .filter((e) => e.enabled && e.position === 'relative' && triggered(e))
        .sort((a, b) => a.order - b.order);
    // 兜底注入按「预设里是否存在该 marker」判定，不限 relative——in-chat 的同名 marker 已有落位。
    const presentMarkerIds = new Set(input.preset.entries.filter((e) => e.enabled && e.marker && triggered(e)).map((e) => e.markerId));
    const beforeHistory = [];
    const afterHistory = [];
    const presetPromptMessages = new Set();
    /** 卡级覆盖替换启用槽位正文，沿用槽位角色/位置/深度；不另加重复消息或执行原文副作用。 */
    const presetMessage = (entry) => {
        const override = entry.forbidOverrides ? undefined
            : entry.identifier === 'main' && input.promptPreferences?.preferCharacterPrompt !== false ? card?.systemPrompt
                : entry.identifier === 'jailbreak' && input.promptPreferences?.preferCharacterInstructions !== false ? card?.postHistoryInstructions : undefined;
        const overridden = Boolean(override);
        const raw = overridden ? override : entry.content;
        if (!raw.trim() || skipScript(`预设「${entry.identifier}」`, raw))
            return null;
        const context = overridden ? { ...standingCtx, vars: { ...standingCtx.vars, original: entry.content } } : standingCtx;
        const message = definition(entry.role, raw, overridden ? characterDefinitionMessages : presetPromptMessages, context, overridden ? (entry.identifier === 'main' ? 'card:system' : 'card:post-history') : `preset:${entry.identifier}`);
        messageSources.set(message, [...new Set([`preset:${entry.identifier}`, ...(messageSources.get(message) ?? [])])]);
        message.content = message.content.trim();
        return message.content ? message : null;
    };
    let seenHistory = false;
    let insertedFallbackMarkers = false;
    const insertFallbackMarkers = () => {
        if (insertedFallbackMarkers)
            return;
        insertedFallbackMarkers = true;
        if (memoryText && !presentMarkerIds.has(Marker.AgentMemory)) {
            beforeHistory.push(asTurn(trackedMessage('system', memoryText, memoryPromptMessages)));
            log.push({ kind: 'auto-marker', detail: '预设缺少 agentMemory marker，已在 chatHistory 前自动注入检索记忆' });
        }
        if (deltaText && !presentMarkerIds.has(Marker.WorldState)) {
            beforeHistory.push(asTurn(trackedMessage('system', deltaText, worldStatePromptMessages)));
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
            if (content) {
                for (const message of content) {
                    relativeOrders.set(message, entry.order);
                    messageSources.set(message, [`preset:${entry.identifier}`, ...(messageSources.get(message) ?? [])]);
                }
                bucket.push(...content);
            }
            continue;
        }
        const message = presetMessage(entry);
        if (message) {
            relativeOrders.set(message, entry.order);
            bucket.push(message);
        }
    }
    // 没有 chatHistory marker 时，组装器仍会在骨架后追加历史；动态私有层紧贴该边界。
    if (!seenHistory)
        insertFallbackMarkers();
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
            // 每条解析结果的 turn 归属随 markerContent 创建时的标记走（静态 marker 内容 = 静态注入）。
            const resolved = markerContent(id, entry.role);
            if (resolved === null || resolved.length === 0)
                continue;
            for (const m of resolved) {
                depthInjections.push({ depth: entry.depth, order: entry.order, role: m.role, content: m.content, turn: turnMessages.has(m), worldinfo: worldInfoPromptMessages.has(m),
                    sourceKeys: [`preset:${entry.identifier}`, ...(messageSources.get(m) ?? [])] });
            }
            continue;
        }
        const message = presetMessage(entry);
        if (message)
            depthInjections.push({ depth: entry.depth, order: entry.order, role: message.role,
                content: message.content, turn: turnMessages.has(message), sourceKeys: messageSources.get(message) ?? [`preset:${entry.identifier}`] });
    }
    for (const a of wiAt(WIPosition.AtDepth)) {
        if (skipScript(`世界书 @D「${a.entry.key}」`, a.entry.content))
            continue;
        const stable = isStandingSafeEntry(a.entry) && !dynamic(a.entry.content);
        const content = (stable ? expandStanding(a.entry.content, standingCtx, a.entry.key) : expandTurn(a.entry.content, a.entry.key)).trim();
        if (!content)
            continue;
        depthInjections.push({
            depth: a.entry.depth,
            order: a.entry.order,
            role: WI_ROLE_MAP[a.entry.role],
            content,
            turn: !stable, // 确定常驻 @D 进 standing，其它按轮注入
            worldinfo: true,
            sourceKeys: [a.entry.key],
        });
    }
    const depthPrompt = input.card?.depthPrompt;
    if (depthPrompt?.prompt.trim()) {
        if (!skipScript('角色 depth_prompt', depthPrompt.prompt)) {
            // 静态 depth_prompt（无本轮宏）进 standing 钉死，不再每轮全价重付。
            const turnLocal = dynamic(depthPrompt.prompt);
            const content = (turnLocal ? expandTurn(depthPrompt.prompt, 'card:depth') : expandStanding(depthPrompt.prompt, standingCtx, 'card:depth')).trim();
            if (content) {
                depthInjections.push({
                    depth: depthPrompt.depth,
                    order: 0,
                    role: depthPrompt.role,
                    content,
                    turn: turnLocal,
                    sourceKeys: ['card:depth'],
                });
            }
        }
    }
    // AN bottom：全序列最末；AN top：历史之前
    const anTop = wiText(WIPosition.AuthorNoteTop);
    if (anTop)
        beforeHistory.push(asTurn(trackedMessage('system', anTop, worldInfoPromptMessages, wiTextSources.get(WIPosition.AuthorNoteTop))));
    const sessionNote = input.authorNote?.trim() ? expandTurn(input.authorNote).trim() : '';
    if (sessionNote)
        beforeHistory.push(asTurn(trackedMessage('system', `【作者注释】${sessionNote}`, worldInfoPromptMessages, ['author-note'])));
    const journalNote = input.journalText?.trim() ? expandTurn(input.journalText).trim() : '';
    if (journalNote)
        beforeHistory.push(asTurn(trackedMessage('system', `【角色笔记】${journalNote}`, worldInfoPromptMessages, ['journal'])));
    const anBottom = wiText(WIPosition.AuthorNoteBottom);
    const anBottomMessage = anBottom
        ? asTurn(trackedMessage('system', anBottom, worldInfoPromptMessages, wiTextSources.get(WIPosition.AuthorNoteBottom)))
        : null;
    if (skippedScripts.size > 0) {
        const note = `（已跳过 ${skippedScripts.size} 条未展开的脚本条目；需要设定细节时用 tavern_lore_read 按 uid/关键词取条。）`;
        afterHistory.push(asTurn({ role: 'system', content: note }));
    }
    // 世界书预算截断对模型可见：硬顶从「静默丢信息」变成「分页」——被裁条目以 uid 清单
    // 进快照尾部（turn 侧，体量小且只有发生截断时才出现），模型可按条 lore_read 补读。
    const truncated = wi?.truncated ?? [];
    if (truncated.length > 0) {
        const shown = truncated.slice(0, WI_TRUNCATED_HINT_MAX);
        const list = shown.map((t) => (t.label === t.uid ? t.uid : `${t.uid}「${t.label}」`)).join('、');
        const rest = truncated.length - shown.length;
        const note = `（本轮世界书有 ${truncated.length} 条命中但因预算未注入：${list}${rest > 0 ? ` 等 ${rest} 条` : ''}；需要正文用 tavern_lore_read 按 uid 取条。）`;
        afterHistory.push(asTurn({ role: 'system', content: note }));
    }
    if (input.transformPrompt) {
        history = history.map(m => ({ ...m, content: input.transformPrompt(m.content, { role: m.role, worldinfo: false, depth: historyDepth.get(m) ?? 0 }) }));
        // 重映射产生新对象；originalHistory/historyDepth 按对象身份追踪，必须随之重建，
        // 否则模板序列的 depth 归 0、history 标记落空、historyContent 与 asTurn 判定全部失效。
        originalHistory.clear();
        historyDepth.clear();
        historyAnchors.clear();
        history.forEach((message, index) => { originalHistory.add(message); historyDepth.set(message, historyDepths[index]); historyAnchors.set(message, layoutHistory[index]); });
        for (const m of [...beforeHistory, ...afterHistory, ...(anBottomMessage ? [anBottomMessage] : [])]) {
            const content = input.transformPrompt(m.content, { role: m.role, worldinfo: worldInfoPromptMessages.has(m), depth: 0 });
            if (content !== m.content) {
                m.content = content;
                asTurn(m);
            }
        }
        for (const injection of depthInjections) {
            const content = input.transformPrompt(injection.content, { role: injection.role, worldinfo: injection.worldinfo ?? false, depth: injection.depth });
            if (content !== injection.content) {
                injection.content = content;
                injection.turn = true;
            }
        }
    }
    // ── 6. 历史内插入（深 depth 先插，同 depth order 升序） ─────────────────
    const byDepth = new Map();
    const depthBindings = new Map();
    for (const inj of depthInjections) {
        if (inj.depth === 0)
            continue // depth 0 = 历史之后，单独处理
            ;
        (byDepth.get(inj.depth) ?? byDepth.set(inj.depth, []).get(inj.depth)).push(inj);
    }
    const depths = [...byDepth.keys()].sort((a, b) => b - a);
    const depthChatHistory = history.filter(message => historyAnchors.get(message)?.chat);
    for (const depth of depths) {
        // 模板缓冲与最终布局使用同一真实聊天边界；插件通知、system 与已插入片段不消耗 depth。
        const next = depthChatHistory[Math.max(0, depthChatHistory.length - depth)];
        const at = next ? history.indexOf(next) : 0;
        const group = byDepth.get(depth).sort(compareDepthInjections);
        history.splice(at, 0, ...group.map((g) => {
            const message = { role: g.role, content: g.content };
            depthBindings.set(message, g);
            return message;
        }));
    }
    const depth0 = depthInjections.filter((d) => d.depth === 0).sort(compareDepthInjections);
    // ── 7. 全量序列与预算裁剪（历史最后裁） ──────────────────────────────────
    const tail = [
        ...depth0.map((d) => {
            const message = { role: d.role, content: d.content };
            depthBindings.set(message, d);
            // tail 是新建对象，turn 归属从注入记录显式转标记（身份追踪见 turnMessages）。
            if (d.turn)
                turnMessages.add(message);
            return message;
        }),
        ...(anBottomMessage ? [anBottomMessage] : []),
        ...afterHistory,
    ];
    let templateTurnContext = [];
    const templateHistoryInsertions = new Map();
    let preciseTemplateHistory = true;
    let templateTailInsertions;
    if (input.processTemplateSequence) {
        const sequence = [...beforeHistory, ...history, ...tail];
        const items = sequence.map(message => ({ message,
            worldinfo: worldInfoPromptMessages.has(message) || depthBindings.get(message)?.worldinfo === true,
            depth: depthBindings.get(message)?.depth ?? historyDepth.get(message) ?? 0,
            history: originalHistory.has(message),
        }));
        const processed = input.processTemplateSequence(items);
        templateTailInsertions = processed.tailInsertions;
        preciseTemplateHistory = items.filter(item => item.history).every(item => item.historyInsertions !== undefined);
        for (const item of items)
            if (item.history && item.historyInsertions)
                templateHistoryInsertions.set(item.message, item.historyInsertions);
        for (const item of items)
            if (item.history && item.historyContent !== undefined)
                processedHistory.set(item.message, item.historyContent);
        templateTurnContext = processed.turnContext ?? [];
        if (processed.log)
            log.push(...processed.log);
        for (const item of items) {
            const message = item.message;
            const injection = depthBindings.get(message);
            if (item.originalContent !== message.content && !originalHistory.has(message)) {
                asTurn(message);
                if (injection)
                    injection.turn = true;
            }
            if (injection)
                injection.content = message.content;
        }
        // 原始历史即使没有文字仍保留身份（例如图片），后置 INSERT 必须能准确引用它。
        // 只有声明或变量写入的插件空输出由下面的统一清理删除。
    }
    for (const bucket of [beforeHistory, history, tail]) {
        for (let index = bucket.length - 1; index >= 0; index--) {
            const message = bucket[index];
            if (!originalHistory.has(message) && !message.content.trim())
                bucket.splice(index, 1);
        }
    }
    const liveOutsideHistory = [...beforeHistory, ...tail];
    // 在模拟裁剪前保留尾部的真实内容。后置条目即使完全静态也不能回到 system 前缀。
    const liveTail = [...tail];
    // 实际请求计划在模拟预算裁剪前保存插件正文；它只引用历史 ID，不携带经过正则的历史副本。
    const layoutFragments = [];
    const layoutMessageIndices = new Map();
    const firstChat = layoutHistory.find(anchor => anchor.chat);
    const lastChat = [...layoutHistory].reverse().find(anchor => anchor.chat);
    const tailSet = new Set(tail);
    for (const message of [...beforeHistory, ...history, ...tail]) {
        const anchor = historyAnchors.get(message);
        if (anchor) {
            const inserted = preciseTemplateHistory ? templateHistoryInsertions.get(message) : undefined;
            if (inserted)
                for (const side of ['before', 'after']) {
                    if (inserted[side].trim())
                        layoutFragments.push({ role: message.role, content: inserted[side],
                            sourceKeys: [`template:generate:history:${anchor.inputIndex}:${side}`], turnLocal: true,
                            placement: { kind: 'history-relative', anchor, side } });
                }
            continue;
        }
        const injection = depthBindings.get(message);
        const after = tailSet.has(message);
        if (!message.content.trim())
            continue;
        layoutMessageIndices.set(message, layoutFragments.length);
        layoutFragments.push({ role: message.role, content: message.content,
            sourceKeys: injection?.sourceKeys ?? messageSources.get(message) ?? ['assembly:notice'],
            turnLocal: injection?.turn ?? turnMessages.has(message),
            placement: injection ? promptDepthPlacement(layoutHistory, injection.depth, injection.order)
                : { kind: after ? 'after-history' : 'before-history',
                    ...((after ? lastChat : firstChat) ? { anchor: (after ? lastChat : firstChat) } : {}),
                    ...(relativeOrders.has(message) ? { order: relativeOrders.get(message) } : {}) },
        });
    }
    for (const content of templateTailInsertions ?? [])
        layoutFragments.push({ role: 'system', content,
            sourceKeys: ['template:generate:empty-sequence'], turnLocal: true, placement: { kind: 'after-history' } });
    if (!preciseTemplateHistory || (!layoutHistory.length && templateTailInsertions === undefined)) {
        for (const content of templateTurnContext)
            layoutFragments.push({ role: 'system', content,
                sourceKeys: ['template:legacy-turn-context'], turnLocal: true, compatibilityFallback: true,
                placement: { kind: 'after-history', ...(lastChat ? { anchor: lastChat } : {}) } });
    }
    const layout = createPromptLayout(layoutHistory, layoutFragments);
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
    const tailMessages = new Set(liveTail);
    const outsideHistory = liveOutsideHistory.filter(message => !tailMessages.has(message));
    // 插进历史中间的注入（@D / depth_prompt / 预设 in-chat）预览能看到；live 不能改日志，
    // 静态的（无本轮宏）并入 standing 钉死——字节稳定、命中前缀缓存，不再每轮全价重付；
    // 本轮才变的并入 turn 尾。
    const spliced = depthInjections.filter((d) => d.depth !== 0)
        .sort((a, b) => b.depth - a.depth || compareDepthInjections(a, b));
    const splicedStanding = spliced.filter((d) => !d.turn).map((d) => d.content);
    const splicedTurn = spliced.filter((d) => d.turn).map((d) => d.content);
    const standing = joinPromptParts([
        ...outsideHistory.filter((m) => !turnMessages.has(m)).map((m) => m.content),
        ...splicedStanding,
    ]);
    const turnContext = joinPromptParts([
        ...outsideHistory.filter((m) => turnMessages.has(m)).map((m) => m.content),
        ...splicedTurn,
        ...templateTurnContext,
        ...liveTail.map((m) => m.content),
    ]);
    const nonSystem = [...liveOutsideHistory].filter(message => message.role !== 'system');
    if (nonSystem.length || depthInjections.some(injection => injection.role !== 'system')) {
        log.push({ kind: 'live-compatibility', detail: '已保存预设 user/assistant 角色布局；DeepSeek 官方通道按原角色投影，其它通道映射为提示词文本。末尾 assistant 不等同于供应商专用助手预填。' });
    }
    if (depthInjections.some(injection => injection.depth > 0)) {
        log.push({ kind: 'live-compatibility', detail: '已冻结真实聊天身份与深度边界；DeepSeek 官方通道据此插入。system 深度按模型能力处理，仅支持首条 system 时合并系统指令；其它通道沿用 standing/tavern:turn 映射。原宿主历史正文保持不变。' });
    }
    const system = joinPromptParts([standing, turnContext]);
    return {
        messages,
        layout,
        messageProvenance: messages.map(message => {
            const anchor = historyAnchors.get(message);
            if (anchor)
                return { kind: 'history', anchor: { ...anchor } };
            const index = layoutMessageIndices.get(message);
            const entryKey = index === undefined ? undefined : layout.entries[index]?.key;
            if (entryKey === undefined)
                throw new Error('提示词消息缺少布局来源');
            return { kind: 'layout', entryKey };
        }),
        standing,
        turnContext,
        hasTurnTail: liveTail.length > 0,
        system,
        history: history.map(message => processedHistory.has(message) ? { ...message, content: processedHistory.get(message) } : message),
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
