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
    if (lower === 'trim' || lower === 'noop' || lower === 'newline')
        return lower === 'newline' ? '\n' : '';
    if (lower === 'lastusermessage' || lower === 'lastmessage' || lower === 'last_user_message') {
        return ctx.lastUserMessage ?? '';
    }
    if (lower.startsWith('//'))
        return '';
    if (lower.startsWith('outlet::')) {
        const outletName = raw.slice('outlet::'.length).trim();
        const content = ctx.outlets?.[outletName] ?? '';
        return content.replaceAll('{{', FROZEN_OPEN);
    }
    if (Object.hasOwn(clock, lower))
        return clock[lower];
    const eq = lower.indexOf('::');
    if (eq <= 0)
        return undefined;
    const cmd = lower.slice(0, eq);
    const rest = raw.slice(eq + 2);
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
 */
export function expandMacros(text, ctx, now = new Date()) {
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
                return applied;
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
/** 收集文本中出现的宏名（调试用）。 */
export function listMacros(text) {
    const out = [];
    for (const m of text.matchAll(MACRO_RE))
        out.push(m[1].trim());
    return out;
}
/** 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。 */
export function hasTurnLocalMacros(text) {
    return /\{\{\s*(outlet::|lastusermessage|lastmessage|last_user_message|time|date|datetime|weekday)/i.test(text);
}
/** SillyTavern EJS / STscript。本插件不执行，原文注入只会污染上下文。 */
export function hasUnevaluatedScript(text) {
    return /<%[_=-]?/.test(text) || /\{%\s*(if|for|set)\b/i.test(text);
}
