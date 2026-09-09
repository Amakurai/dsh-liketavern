/** 函数可独立 toString 注入 iframe；parseYaml 与不调用访问器的有界 json 复制器必须由沙箱显式提供。 */
export function createHelperMvuInitialData(sources, greeting, existing, parseYaml, json) {
    const LIMIT = 1024 * 1024, encoder = new TextEncoder();
    const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const uid = (value) => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
    // 先复制整个入口，避免读取未验证的访问器，并把多个来源的总输入限制在同一个预算内。
    const input = json({ sources, greeting, existing }, LIMIT);
    if (!Array.isArray(input.sources) || typeof input.greeting !== 'string' || !record(input.existing))
        throw new Error('MVU 初始化输入无效');
    const books = input.sources.map(value => {
        if (!record(value) || typeof value.name !== 'string' || !value.name.trim() || ['__proto__', 'prototype', 'constructor'].includes(value.name) || !Array.isArray(value.entries)
            || value.role !== undefined && value.role !== 'global' && value.role !== 'character')
            throw new Error('MVU 初始化世界书来源无效');
        for (const entry of value.entries) {
            if (!record(entry) || !uid(entry.uid) || typeof entry.comment !== 'string' || typeof entry.content !== 'string')
                throw new Error('MVU 初始化世界书条目无效');
        }
        return value;
    });
    const result = input.existing;
    const checkInternal = (value) => {
        if (Array.isArray(value))
            for (const item of value)
                checkInternal(item);
        else if (record(value))
            for (const key of Object.keys(value)) {
                if (key === '$internal')
                    throw new Error('MVU 初值不能包含内部状态字段 $internal');
                checkInternal(value[key]);
            }
    };
    checkInternal(result);
    let stat = result.stat_data === undefined ? {} : result.stat_data;
    if (!record(stat))
        throw new Error('MVU 初始化 stat_data 必须是普通对象');
    let initialized = {};
    const prior = result.initialized_lorebooks;
    if (Array.isArray(prior)) {
        for (const name of prior) {
            if (typeof name !== 'string' || !name.trim() || ['__proto__', 'prototype', 'constructor'].includes(name))
                throw new Error('MVU 旧初始化世界书记录无效');
            initialized[name] = [];
        }
    }
    else if (prior !== undefined) {
        if (!record(prior))
            throw new Error('MVU 初始化世界书记录必须是对象或旧书名数组');
        for (const [name, values] of Object.entries(prior)) {
            if (!name.trim() || !Array.isArray(values) || !values.every(uid))
                throw new Error('MVU 初始化世界书 uid 记录无效');
            initialized[name] = [...values];
        }
    }
    let parsedBytes = 0;
    const merge = (target, patch) => {
        for (const [key, value] of Object.entries(patch)) {
            const before = target[key];
            if (record(before) && record(value))
                merge(before, value);
            else if (Array.isArray(before) && Array.isArray(value) && JSON.stringify(before) !== JSON.stringify(value)) {
                // 上游 correctlyMerge 的数组覆盖规则尚未纳入适配；显式拒绝，避免 VWD 与模板数组被悄悄改写。
                throw new Error('暂不支持同一世界书或开场白初值中的重叠数组，请先合并对应条目');
            }
            else
                target[key] = value;
        }
        return target;
    };
    const blocks = (text) => {
        const values = [], tags = /<\s*\/?\s*initvar\b[^>]*>/gi;
        let begin;
        for (let match = tags.exec(text); match; match = tags.exec(text)) {
            if (!/^<\s*\/?\s*initvar\s*>$/i.test(match[0]))
                throw new Error('MVU initvar 标签不支持属性');
            if (/^<\s*\//.test(match[0])) {
                if (begin === undefined)
                    throw new Error('MVU initvar 标签没有对应起始标签');
                values.push(text.slice(begin, match.index));
                begin = undefined;
            }
            else {
                if (begin !== undefined)
                    throw new Error('MVU initvar 标签不能嵌套');
                begin = match.index + match[0].length;
            }
        }
        if (begin !== undefined || /<\s*\/?\s*initvar\b[^>]*$/i.test(text))
            throw new Error('MVU initvar 标签未闭合');
        return values;
    };
    const parse = (text) => {
        if (text.includes('<%'))
            throw new Error('MVU 初值包含尚未展开的 EJS 模板，当前初始化不执行表达式');
        let source = text.trim();
        if (source.startsWith('```')) {
            const fence = /^```(?:json|ya?ml)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(source);
            if (!fence)
                throw new Error('MVU 初值代码围栏必须完整且使用 JSON/YAML');
            source = fence[1].trim();
        }
        if (!source)
            throw new Error('MVU 初值内容为空');
        let parsed;
        try {
            parsed = json(parseYaml(source), LIMIT);
        }
        catch (error) {
            throw new Error('MVU 初值 JSON/YAML 解析失败：' + (error instanceof Error ? error.message : String(error)));
        }
        if (!record(parsed))
            throw new Error('MVU 初值根必须是普通 JSON/YAML 对象');
        checkInternal(parsed);
        parsedBytes += encoder.encode(JSON.stringify(parsed)).length;
        if (parsedBytes > LIMIT)
            throw new Error('MVU 初始化解析结果超过 1 MiB 预算');
        return parsed;
    };
    const entries = (book) => book.entries.filter(entry => entry.comment.toLowerCase().includes('[initvar]'));
    const ids = (book) => [...new Set(entries(book).map(entry => entry.uid))];
    const greetingBlocks = blocks(input.greeting);
    if (greetingBlocks.length) {
        stat = {};
        for (const text of greetingBlocks)
            merge(stat, parse(text));
        // 开场白初值替代角色书；旧全局记录也须重置，使全局缺省值能补入新开场白。
        initialized = {};
        for (const book of books)
            if (book.role === 'character')
                initialized[book.name] = ids(book);
    }
    const ordered = [...books.filter(book => book.role !== 'character'), ...books.filter(book => book.role === 'character')];
    for (const book of ordered) {
        if (Object.hasOwn(initialized, book.name))
            continue;
        let merged = {};
        for (const entry of entries(book)) {
            const wrapped = blocks(entry.content);
            if (wrapped.length)
                for (const text of wrapped)
                    merged = merge(merged, parse(text));
            else
                merged = merge(merged, parse(entry.content));
        }
        // 同书递归合并，跨书只补缺失的顶层键；既存状态和较早的全局书优先。
        stat = { ...merged, ...stat };
        initialized[book.name] = ids(book);
    }
    result.stat_data = stat;
    result.initialized_lorebooks = initialized;
    if (result.display_data === undefined)
        result.display_data = {};
    if (result.delta_data === undefined)
        result.delta_data = {};
    return json(result, LIMIT);
}
