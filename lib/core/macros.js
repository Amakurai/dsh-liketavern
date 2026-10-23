/** 只匹配不含花括号的最内层宏，便于 `{{setvar::x::{{char}}}}` 由内向外展开。 */
const MACRO_RE = /\{\{(?!\s*\}\})([^{}]+)\}\}/g;
const MAX_PASSES = 8;
/** ST evaluateMacros 的旧式非花括号宏；老卡片的开场白、描述与世界书键常用。 */
const LEGACY_MACRO_RE = /<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi;
function expandLegacyMacros(text, ctx, postProcess) {
    if (!text.includes('<'))
        return text;
    return text.replace(LEGACY_MACRO_RE, (_raw, name) => {
        const value = name.toLowerCase() === 'user' ? ctx.user : ctx.char;
        return postProcess ? postProcess(value) : value;
    });
}
/** 内部占位标记必须避开本次所有文本来源，私用区字符本身也可能是角色使用的图标。 */
function markerFor(name, text, ctx) {
    const reserved = [text, ...Object.values(ctx).filter((value) => typeof value === 'string'),
        ...Object.values(ctx.vars ?? {}), ...Object.values(ctx.outlets ?? {}), ...(ctx.store?.values() ?? []),
        ctx.readonlyStatData === undefined ? '' : JSON.stringify(ctx.readonlyStatData)].join('\n');
    let index = 0;
    let marker = `\uE000tavern${name}${index}\uE001`;
    while (reserved.includes(marker))
        marker = `\uE000tavern${name}${++index}\uE001`;
    return marker;
}
function pad2s(n) {
    return n < 10 ? `0${n}` : String(n);
}
function defaultVars(now) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
        time: `${pad2s(now.getHours())}:${pad2s(now.getMinutes())}`,
        date: `${now.getFullYear()}-${pad2s(now.getMonth() + 1)}-${pad2s(now.getDate())}`,
        datetime: `${now.getFullYear()}-${pad2s(now.getMonth() + 1)}-${pad2s(now.getDate())} ${pad2s(now.getHours())}:${pad2s(now.getMinutes())}`,
        weekday: weekdays[now.getDay()],
        isodate: `${now.getFullYear()}-${pad2s(now.getMonth() + 1)}-${pad2s(now.getDate())}`,
        isotime: `${pad2s(now.getHours())}:${pad2s(now.getMinutes())}`,
    };
}
function storeOf(ctx) {
    if (!ctx.store)
        ctx.store = new Map();
    return ctx.store;
}
function splitOnce(rest) {
    const i = rest.indexOf('::');
    if (i < 0)
        return [rest, ''];
    return [rest.slice(0, i), rest.slice(i + 2)];
}
/** 同一种子每次调用生成独立流；同一 turn 多步组装应各拿一份新流。 */
export function createTurnRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function hashToSeed(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function rollChoice(options, random, numericRange) {
    if (options.length === 0)
        return '';
    if (numericRange && options.length === 2 && options.every((o) => /^-?\d+$/.test(o))) {
        const a = Number(options[0]);
        const b = Number(options[1]);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return String(lo + Math.floor(random() * (hi - lo + 1)));
    }
    return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}
function parseChoiceMacro(inner) {
    const match = /^(random|pick)\s*(::|:)([\s\S]*)$/i.exec(inner.trimStart());
    if (!match)
        return null;
    const kind = match[1].toLowerCase() === 'pick' ? 'pick' : 'random';
    const rest = match[3] ?? '';
    // 对齐 ST：`::` 列表原样切分不修剪；逗号列表支持 `\,` 转义并逐项修剪。两者都保留空选项——
    // 卡片常写 {{random::，偶尔::}} 表示「有时什么都不加」，丢掉空项会让它恒定输出非空那一项。
    if (rest.includes('::'))
        return { kind, options: rest.split('::') };
    const options = rest.split(/(?<!\\),/).map((s) => s.trim().replaceAll('\\,', ','));
    return { kind, options: options.length === 1 && options[0] === '' ? [] : options };
}
/** ST 骰子：NdM±K、dM 或纯数字 M（= 1dM）。个数与面数有界，非法返回 null。 */
function rollDice(expression, random) {
    const match = /^(\d*)\s*d\s*(\d+)\s*([+-]\s*\d+)?$/i.exec(expression) ?? /^()(\d+)()$/.exec(expression);
    if (!match)
        return null;
    const count = match[1] ? Number(match[1]) : 1;
    const sides = Number(match[2]);
    const modifier = match[3] ? Number(match[3].replace(/\s+/g, '')) : 0;
    if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !Number.isSafeInteger(sides) || sides < 1 || sides > 1_000_000
        || !Number.isSafeInteger(modifier))
        return null;
    let total = modifier;
    for (let i = 0; i < count; i++)
        total += 1 + Math.min(sides - 1, Math.floor(random() * sides));
    return String(total);
}
const FIELD_MACRO_COMMANDS = new Set([
    'description', 'chardescription', 'personality', 'charpersonality', 'scenario', 'charscenario',
    'persona', 'charfirstmessage', 'firstmessage', 'greeting', 'charversion', 'charcreatornotes',
    'creatornotes', 'chardepthprompt', 'mesexamplesraw', 'mesexamples', 'charprompt', 'charinstruction', 'charjailbreak', 'original',
]);
const GET_VAR_COMMANDS = ['getvar', 'getlocalvar', 'getglobalvar'];
const HAS_VAR_COMMANDS = ['hasvar', 'haslocalvar', 'hasglobalvar', 'varexists', 'globalvarexists'];
const DELETE_VAR_COMMANDS = ['deletevar', 'flushvar', 'deleteglobalvar', 'flushglobalvar'];
const SET_VAR_COMMANDS = ['setvar', 'setlocalvar', 'setglobalvar'];
const ADD_VAR_COMMANDS = ['addvar', 'addlocalvar', 'addglobalvar'];
const INC_VAR_COMMANDS = ['incvar', 'inclocalvar', 'incglobalvar'];
const DEC_VAR_COMMANDS = ['decvar', 'declocalvar', 'decglobalvar'];
function isGetVar(inner) {
    // 删除与读取同趟按出现顺序执行：「先读后清」（{{getvar::x}}{{flushvar::x}}）不能因删除先跑而读空。
    return /^(getvar|getlocalvar|getglobalvar|hasvar|haslocalvar|hasglobalvar|varexists|globalvarexists|deletevar|flushvar|deleteglobalvar|flushglobalvar)\s*::/i.test(inner.trim());
}
function applyCommand(inner, ctx, clock, pickRandom) {
    const raw = inner.trim();
    const lower = raw.toLowerCase();
    if (lower === 'char' || lower === 'charname')
        return ctx.char;
    if (lower === 'user' || lower === 'username')
        return ctx.user;
    if (lower === 'description' || lower === 'chardescription')
        return ctx.description ?? '';
    if (lower === 'personality' || lower === 'charpersonality')
        return ctx.personality ?? '';
    if (lower === 'scenario' || lower === 'charscenario')
        return ctx.scenario ?? '';
    if (lower === 'persona')
        return ctx.persona ?? '';
    if (lower === 'charfirstmessage' || lower === 'firstmessage' || lower === 'greeting')
        return ctx.firstMessage ?? '';
    if (lower === 'charversion')
        return ctx.charVersion ?? '';
    if (lower === 'charcreatornotes' || lower === 'creatornotes')
        return ctx.creatorNotes ?? '';
    if (lower === 'chardepthprompt')
        return ctx.charDepthPrompt ?? '';
    if (lower === 'mesexamplesraw' || lower === 'mesexamples')
        return ctx.mesExamples ?? '';
    if (lower === 'charprompt')
        return ctx.charPrompt ?? '';
    if (lower === 'charinstruction' || lower === 'charjailbreak')
        return ctx.charInstruction ?? '';
    if (lower === 'group' || lower === 'groupnotmuted')
        return ctx.char;
    if (lower === 'notchar')
        return ctx.user;
    if (lower === 'space')
        return ' ';
    if (/^banned\s+"[^"]*"$/i.test(raw))
        return '';
    if (lower === 'trim' || lower === 'noop' || lower === 'newline')
        return lower === 'newline' ? '\n' : '';
    if (lower === 'lastmessage')
        return ctx.lastMessage ?? '';
    if (lower === 'lastusermessage' || lower === 'last_user_message') {
        return ctx.lastUserMessage ?? '';
    }
    if (lower === 'lastcharmessage' || lower === 'last_char_message') {
        return ctx.lastCharMessage ?? '';
    }
    if (lower.startsWith('//'))
        return '';
    // ST 同时接受 {{roll:1d6}} 与 {{roll 1d6}}。
    const roll = /^roll(?:\s*:|\s+)\s*(.*)$/i.exec(raw);
    if (roll)
        return rollDice(roll[1].trim(), ctx.random ?? Math.random) ?? '';
    const reversed = /^reverse\s*:([\s\S]*)$/i.exec(raw);
    if (reversed)
        return [...reversed[1]].reverse().join('');
    const choices = parseChoiceMacro(inner);
    if (choices) {
        // pick 有聊天身份时走确定性流，不消费本轮 random，{{random}} 的取值不随 pick 数量平移。
        const random = choices.kind === 'pick' && pickRandom ? pickRandom(raw) : ctx.random ?? Math.random;
        return rollChoice(choices.options, random, choices.kind === 'random');
    }
    if (lower.startsWith('outlet::')) {
        const outletName = raw.slice('outlet::'.length).trim();
        const content = ctx.outlets && Object.hasOwn(ctx.outlets, outletName) ? ctx.outlets[outletName] : '';
        return content;
    }
    if (raw.startsWith('outletPromptsInjected:'))
        return `{{${raw}}}`;
    if (Object.hasOwn(clock, lower))
        return clock[lower];
    const trimmed = inner.trimStart();
    const eq = trimmed.indexOf('::');
    if (eq <= 0)
        return undefined;
    // 宏名与 :: 之间允许空格（isGetVar 同规则）：不 trim 会让 {{getvar ::x}} 在正式趟漏解析。
    const cmd = trimmed.slice(0, eq).trim().toLowerCase();
    const rest = trimmed.slice(eq + 2);
    const variableKey = splitOnce(rest)[0].trim();
    const mvuPath = variableKey.replace(/\[(["']?)([^\]"']+)\1\]/g, '.$2').split('.');
    if (ctx.readonlyStatData !== undefined && mvuPath[0] === 'stat_data') {
        if ([...SET_VAR_COMMANDS, ...ADD_VAR_COMMANDS, ...INC_VAR_COMMANDS, ...DEC_VAR_COMMANDS, ...DELETE_VAR_COMMANDS].includes(cmd)) {
            throw new Error('MVU stat_data 是只读快照，不能通过宏修改');
        }
        if (GET_VAR_COMMANDS.includes(cmd) || HAS_VAR_COMMANDS.includes(cmd)) {
            let value = ctx.readonlyStatData;
            for (const part of mvuPath.slice(1)) {
                if (!part || ['__proto__', 'constructor', 'prototype'].includes(part))
                    throw new Error('MVU 宏变量路径无效');
                value = value && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined;
            }
            if (HAS_VAR_COMMANDS.includes(cmd))
                return value === undefined ? 'false' : 'true';
            return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
        }
    }
    if (SET_VAR_COMMANDS.includes(cmd)) {
        const [name, value] = splitOnce(rest);
        const key = name.trim();
        if (key)
            storeOf(ctx).set(key, value);
        return '';
    }
    if (GET_VAR_COMMANDS.includes(cmd)) {
        const key = rest.trim();
        return storeOf(ctx).get(key) ?? '';
    }
    if (HAS_VAR_COMMANDS.includes(cmd))
        return storeOf(ctx).has(rest.trim()) ? 'true' : 'false';
    if (DELETE_VAR_COMMANDS.includes(cmd)) {
        storeOf(ctx).delete(rest.trim());
        return '';
    }
    // 对齐 ST：incvar/decvar 返回新值（addvar 返回空串）。
    if (INC_VAR_COMMANDS.includes(cmd) || DEC_VAR_COMMANDS.includes(cmd)) {
        return addVariable(storeOf(ctx), rest.trim(), INC_VAR_COMMANDS.includes(cmd) ? '1' : '-1');
    }
    if (ADD_VAR_COMMANDS.includes(cmd)) {
        const [name, value] = splitOnce(rest);
        addVariable(storeOf(ctx), name.trim(), value);
        return '';
    }
    return undefined;
}
/**
 * ST addLocalVariable：旧值是 JSON 数组则追加一项；旧值或增量不是数字时按字符串拼接
 * （{{addvar::log::B}} 累积文本，不能把原有文本覆盖成数字）；否则数值相加。返回新值。
 */
function addVariable(store, key, value) {
    const previous = store.get(key) ?? '';
    const current = previous || '0';
    try {
        const parsed = JSON.parse(current);
        if (Array.isArray(parsed)) {
            parsed.push(value);
            const next = JSON.stringify(parsed);
            store.set(key, next);
            return String(parsed);
        }
    }
    catch {
        // 不是 JSON：按数字或字符串处理。
    }
    const increment = value.trim() === '' ? Number.NaN : Number(value);
    const base = current.trim() === '' ? Number.NaN : Number(current);
    if (Number.isNaN(increment) || Number.isNaN(base)) {
        const next = previous + value;
        store.set(key, next);
        return next;
    }
    const sum = base + increment;
    if (Number.isNaN(sum))
        return '';
    store.set(key, String(sum));
    return String(sum);
}
/**
 * 展开 text 中的宏。outlet 替换结果不二次扫描（SillyTavern：禁止嵌套 outlet）。
 * setvar/getvar 经 MacroContext.store 在一次组装内跨条目共享。
 *
 * postProcess 只作用于每个宏解析出来的值（不碰模板里的原文），调用方用它做
 * 正则转义或 `$` 保护。now 保持第三位，老调用方（只传 text/ctx 或再带 now）不受影响。
 */
function applyPostMarkers(value, open, close, fn) {
    if (!value.includes(open))
        return value;
    let out = '';
    let cursor = 0;
    let depth = 0;
    let span = '';
    while (cursor < value.length) {
        const nextOpen = value.indexOf(open, cursor);
        const nextClose = value.indexOf(close, cursor);
        if (nextOpen < 0 && nextClose < 0) {
            const tail = value.slice(cursor);
            if (depth > 0)
                span += tail;
            else
                out += tail;
            break;
        }
        const isOpen = nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose);
        const at = isOpen ? nextOpen : nextClose;
        const chunk = value.slice(cursor, at);
        if (depth > 0)
            span += chunk;
        else
            out += chunk;
        if (isOpen) {
            depth++;
            cursor = at + open.length;
        }
        else {
            if (depth > 0) {
                depth--;
                if (depth === 0) {
                    out += fn(span);
                    span = '';
                }
            }
            cursor = at + close.length;
        }
    }
    if (depth > 0 && span)
        out += fn(span);
    return out;
}
export function expandMacros(text, ctx, now = new Date(), postProcess) {
    // ST 先替换旧式宏（preEnvMacros），值同样经过 postProcess。
    if (!text.includes('{{'))
        return expandLegacyMacros(text, ctx, postProcess);
    const postOpen = postProcess ? markerFor('PostOpen', text, ctx) : undefined;
    const postClose = postProcess ? markerFor('PostClose', text, ctx) : undefined;
    const legacy = expandLegacyMacros(text, ctx, postOpen && postClose ? (v) => v ? `${postOpen}${v}${postClose}` : v : undefined);
    if (!legacy.includes('{{'))
        return legacy;
    const clock = { ...defaultVars(now), ...ctx.vars };
    const frozenOpen = markerFor('FrozenOpen', legacy, ctx);
    const frozenClose = `${frozenOpen}close`;
    // ST 的 {{trim}} 连同两侧换行一起删除，且在变量与 {{newline}} 之后求值：先留占位，全部展开后再收掉。
    const trimMarker = markerFor('Trim', legacy, ctx);
    const trimRe = new RegExp(`(?:\\r?\\n)*${trimMarker}(?:\\r?\\n)*`, 'g');
    const thawRaw = (value) => value.replace(trimRe, '').replaceAll(frozenClose, '}').replaceAll(frozenOpen, '{');
    const thaw = (value) => {
        const unfreezed = thawRaw(value);
        return postProcess && postOpen && postClose ? applyPostMarkers(unfreezed, postOpen, postClose, postProcess) : unfreezed;
    };
    let current = legacy;
    // 原文哈希让不同条目里的同一组选项互相独立；同一段原文里同组选项按出现次序各取一次。
    // 不用字符偏移：其它宏（如本轮台词）展开后长度会变，偏移会让结果跨轮漂移。
    const pickSeed = ctx.pickSeed;
    const pickCounts = new Map();
    let textSeed;
    const pickRandom = pickSeed === undefined ? undefined : (inner) => {
        const occurrence = pickCounts.get(inner) ?? 0;
        pickCounts.set(inner, occurrence + 1);
        textSeed ??= hashToSeed(text);
        return createTurnRandom(hashToSeed(`${pickSeed}\0${textSeed}\0${inner}\0${occurrence}`));
    };
    const replaceInnermost = (skipGet, unknowns) => {
        current = current.replace(MACRO_RE, (raw, inner) => {
            if (postOpen && postClose)
                inner = inner.replaceAll(postOpen, '').replaceAll(postClose, '');
            if (skipGet && isGetVar(inner))
                return raw;
            if (inner.trim().toLowerCase() === 'trim')
                return trimMarker;
            const applied = applyCommand(inner, ctx, clock, pickRandom);
            if (applied !== undefined) {
                const isOutlet = inner.trim().toLowerCase().startsWith('outlet::');
                const isFieldMacro = FIELD_MACRO_COMMANDS.has(inner.trim().toLowerCase());
                const resolved = isFieldMacro ? expandLegacyMacros(applied, ctx) : applied;
                const value = isOutlet ? resolved.replaceAll('{', frozenOpen).replaceAll('}', frozenClose) : resolved;
                // 转义等后处理先作用于原文，再冻结双向花括号，避免截断外层 setvar。
                return postOpen && postClose && value
                    ? `${postOpen}${value}${postClose}` : value;
            }
            unknowns?.push(inner.trim());
            return raw;
        });
    };
    try {
        for (let pass = 0; pass < MAX_PASSES && current.includes('{{'); pass++) {
            const before = current;
            // 先展开 setvar/char 等，避免同串里 {{getvar}} 在写入前被读成空。
            replaceInnermost(true, null);
            if (current !== before)
                continue;
            const unknowns = [];
            replaceInnermost(false, unknowns);
            if (current === before || pass === MAX_PASSES - 1) {
                for (const name of unknowns)
                    ctx.onUnknown?.(name);
                break;
            }
        }
        return thaw(current);
    }
    finally {
        // setvar 可以捕获 outlet 内容；调用结束不能把本次内部占位符留在共享变量表里。
        for (const [key, value] of ctx.store ?? []) {
            if (value.includes(frozenOpen) || value.includes(trimMarker) || (postOpen && value.includes(postOpen))) {
                const cleaned = postOpen && postClose ? value.replaceAll(postOpen, '').replaceAll(postClose, '') : value;
                ctx.store.set(key, thawRaw(cleaned));
            }
        }
    }
}
const IDENTITY_MACRO_RE = /\{\{\s*(char|charname|user|username)\s*\}\}/gi;
/**
 * 只展开身份宏。用于开场白展示、世界书扫描、入模历史——这些地方不该跑 setvar/时钟。
 * `{{user}}` 变成当前人设名，才能和世界书键互相命中。旧式 `<USER>`/`<BOT>`/`<CHAR>` 同样是身份宏。
 */
export function expandIdentityMacros(text, ctx) {
    const legacy = expandLegacyMacros(text, ctx);
    if (!legacy.includes('{{'))
        return legacy;
    return legacy.replace(IDENTITY_MACRO_RE, (_raw, name) => {
        const k = name.toLowerCase();
        return k === 'user' || k === 'username' ? ctx.user : ctx.char;
    });
}
/**
 * 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。
 * {{pick}} 按聊天身份确定、跨轮不变，不算本轮宏（组装链路总会提供 pickSeed）。
 */
export function hasTurnLocalMacros(text) {
    if (text.includes('<%'))
        return true;
    // 原生 MVU 的 stat_data 是轮初剧情快照；读取它的宏和 EJS 一样不能跨轮钉死。
    if (/\{\{\s*(?:getvar|getlocalvar|getglobalvar|hasvar|haslocalvar|hasglobalvar|varexists|globalvarexists)\s*::\s*stat_data(?:[.\[]|\s*\}\})/i.test(text))
        return true;
    return /\{\{\s*(outlet::|outletPromptsInjected:|lastusermessage|lastmessage|last_user_message|lastcharmessage|last_char_message|time|date|datetime|weekday|isodate|isotime|roll(?:\s*:|\s+\S)|random\s*:)/i.test(text);
}
/** 检测尚未处理的 EJS / STscript；EJS 由隔离执行器展开，STscript 仍不执行。 */
export function hasUnevaluatedScript(text) {
    return /<%[_=-]?/.test(text) || /\{%\s*(if|for|set)\b/i.test(text);
}
