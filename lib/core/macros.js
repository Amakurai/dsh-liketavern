/** 只匹配不含花括号的最内层宏，便于 `{{setvar::x::{{char}}}}` 由内向外展开。 */
const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_PASSES = 8;
/** outlet 替换结果里的 `{{` 冻结，避免二次扫描（禁止嵌套 outlet）。 */
const FROZEN_OPEN = '\uE000';
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
    const match = /^(random|pick)\s*(::|:)\s*(.*)$/i.exec(inner.trim());
    if (!match)
        return null;
    const kind = match[1].toLowerCase() === 'pick' ? 'pick' : 'random';
    const rest = match[3] ?? '';
    const parts = rest.includes('::') ? rest.split('::') : rest.split(',');
    return { kind, options: parts.map((s) => s.trim()).filter(Boolean) };
}
function isGetVar(inner) {
    return /^(getvar|getlocalvar|getglobalvar)\s*::/i.test(inner.trim());
}
function applyCommand(inner, ctx, clock) {
    const raw = inner.trim();
    const lower = raw.toLowerCase();
    if (lower === 'char' || lower === 'charname')
        return ctx.char;
    if (lower === 'user' || lower === 'username')
        return ctx.user;
    if (lower === 'description')
        return ctx.description ?? '';
    if (lower === 'personality')
        return ctx.personality ?? '';
    if (lower === 'scenario')
        return ctx.scenario ?? '';
    if (lower === 'persona')
        return ctx.persona ?? '';
    if (lower === 'charfirstmessage' || lower === 'firstmessage')
        return ctx.firstMessage ?? '';
    if (lower === 'trim' || lower === 'noop' || lower === 'newline')
        return lower === 'newline' ? '\n' : '';
    if (lower === 'lastusermessage' || lower === 'lastmessage' || lower === 'last_user_message') {
        return ctx.lastUserMessage ?? '';
    }
    if (lower === 'lastcharmessage' || lower === 'last_char_message') {
        return ctx.lastCharMessage ?? '';
    }
    if (lower.startsWith('//'))
        return '';
    const choices = parseChoiceMacro(raw);
    if (choices)
        return rollChoice(choices.options, ctx.random ?? Math.random, choices.kind === 'random');
    if (lower.startsWith('outlet::')) {
        const outletName = raw.slice('outlet::'.length).trim();
        const content = ctx.outlets?.[outletName] ?? '';
        return content.replaceAll('{{', FROZEN_OPEN);
    }
    if (raw.startsWith('outletPromptsInjected:'))
        return `{{${raw}}}`;
    if (Object.hasOwn(clock, lower))
        return clock[lower];
    const eq = lower.indexOf('::');
    if (eq <= 0)
        return undefined;
    // 宏名与 :: 之间允许空格（isGetVar 同规则）：不 trim 会让 {{getvar ::x}} 在正式趟漏解析。
    const cmd = lower.slice(0, eq).trim();
    const rest = raw.slice(eq + 2);
    const variableKey = splitOnce(rest)[0].trim();
    const mvuPath = variableKey.replace(/\[(["']?)([^\]"']+)\1\]/g, '.$2').split('.');
    if (ctx.readonlyStatData !== undefined && mvuPath[0] === 'stat_data') {
        if (['setvar', 'setlocalvar', 'setglobalvar', 'addvar'].includes(cmd))
            throw new Error('MVU stat_data 是只读快照，不能通过宏修改');
        if (['getvar', 'getlocalvar', 'getglobalvar'].includes(cmd)) {
            let value = ctx.readonlyStatData;
            for (const part of mvuPath.slice(1)) {
                if (!part || ['__proto__', 'constructor', 'prototype'].includes(part))
                    throw new Error('MVU 宏变量路径无效');
                value = value && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined;
            }
            return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
        }
    }
    if (cmd === 'setvar' || cmd === 'setlocalvar' || cmd === 'setglobalvar') {
        const [name, value] = splitOnce(rest);
        const key = name.trim();
        if (key)
            storeOf(ctx).set(key, value);
        return '';
    }
    if (cmd === 'getvar' || cmd === 'getlocalvar' || cmd === 'getglobalvar') {
        const key = rest.trim();
        return storeOf(ctx).get(key) ?? '';
    }
    if (cmd === 'addvar') {
        const [name, deltaRaw] = splitOnce(rest);
        const key = name.trim();
        const prev = Number(storeOf(ctx).get(key) ?? '0');
        const delta = Number(deltaRaw);
        const next = (Number.isFinite(prev) ? prev : 0) + (Number.isFinite(delta) ? delta : 0);
        storeOf(ctx).set(key, String(next));
        return '';
    }
    return undefined;
}
/**
 * 展开 text 中的宏。outlet 替换结果不二次扫描（SillyTavern：禁止嵌套 outlet）。
 * setvar/getvar 经 MacroContext.store 在一次组装内跨条目共享。
 *
 * postProcess 只作用于每个宏解析出来的值（不碰模板里的原文），调用方用它做
 * 正则转义或 `$` 保护。now 保持第三位，老调用方（只传 text/ctx 或再带 now）不受影响。
 */
export function expandMacros(text, ctx, now = new Date(), postProcess) {
    if (!text.includes('{{'))
        return text;
    const clock = { ...defaultVars(now), ...ctx.vars };
    let current = text;
    const replaceInnermost = (skipGet, unknowns) => {
        current = current.replace(MACRO_RE, (raw, inner) => {
            if (skipGet && isGetVar(inner))
                return raw;
            const applied = applyCommand(inner, ctx, clock);
            if (applied !== undefined)
                return postProcess ? postProcess(applied) : applied;
            unknowns?.push(inner.trim());
            return raw;
        });
    };
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
    return current.replaceAll(FROZEN_OPEN, '{{');
}
const IDENTITY_MACRO_RE = /\{\{\s*(char|charname|user|username)\s*\}\}/gi;
/**
 * 只展开身份宏。用于开场白展示、世界书扫描、入模历史——这些地方不该跑 setvar/时钟。
 * `{{user}}` 变成当前人设名，才能和世界书键互相命中。
 */
export function expandIdentityMacros(text, ctx) {
    if (!text.includes('{{'))
        return text;
    return text.replace(IDENTITY_MACRO_RE, (_raw, name) => {
        const k = name.toLowerCase();
        return k === 'user' || k === 'username' ? ctx.user : ctx.char;
    });
}
/** 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。 */
export function hasTurnLocalMacros(text) {
    if (text.includes('<%'))
        return true;
    return /\{\{\s*(outlet::|outletPromptsInjected:|lastusermessage|lastmessage|last_user_message|lastcharmessage|last_char_message|time|date|datetime|weekday|random\s*:|pick\s*:)/i.test(text);
}
/** 检测尚未处理的 EJS / STscript；EJS 由隔离执行器展开，STscript 仍不执行。 */
export function hasUnevaluatedScript(text) {
    return /<%[_=-]?/.test(text) || /\{%\s*(if|for|set)\b/i.test(text);
}
