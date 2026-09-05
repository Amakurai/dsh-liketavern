/** 解析完全来自数据边界的对象，拒绝重复身份、额外字段与无界计数。 */
export function parseTemplateStickyState(value) {
    const object = (value, keys) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
            throw new Error('sticky 状态对象损坏');
        return value;
    };
    const text = (value, max = 4096) => { if (typeof value !== 'string' || value.length > max)
        throw new Error('sticky 状态文本无效'); return value; };
    const count = (value) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('sticky 状态计数无效'); return value; };
    const finite = (value) => { if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('sticky 必须是有限数值'); };
    const list = (value) => { if (!Array.isArray(value) || value.length > 4096)
        throw new Error('sticky 状态条目超过上限'); return value; };
    const unique = (values) => { if (new Set(values).size !== values.length)
        throw new Error('sticky 状态身份重复'); };
    const data = object(value, ['version', 'revision', 'callbackSerial', 'prompts', 'regex', 'tombstones']);
    if (data.version !== 1)
        throw new Error('sticky 状态版本无效');
    count(data.revision);
    count(data.callbackSerial);
    const prompts = list(data.prompts).map(raw => {
        const item = object(raw, ['key', 'uid', 'prompt', 'order', 'sticky']);
        text(item.key);
        text(item.uid);
        text(item.prompt, 1024 * 1024);
        finite(item.sticky);
        if (typeof item.order !== 'number' || !Number.isFinite(item.order))
            throw new Error('sticky 顺序无效');
        return item;
    });
    unique(prompts.map(item => JSON.stringify([item.key, item.uid])));
    if (prompts.reduce((size, item) => size + item.prompt.length, 0) > 1024 * 1024 || new Set(prompts.map(item => item.key)).size > 1024)
        throw new Error('sticky 注入总量超过上限');
    const regex = object(data.regex, ['basic', 'generate', 'message']), tombstones = object(data.tombstones, ['prompts', 'basic', 'generate', 'message']);
    for (const channel of ['basic', 'generate', 'message']) {
        const rules = list(regex[channel]).map(raw => {
            const item = object(raw, ['uuid', 'source', 'flags', 'sticky', 'revision', 'replacement', 'options']);
            text(item.uuid);
            text(item.source, 1024 * 1024);
            const flags = text(item.flags, 16);
            finite(item.sticky);
            count(item.revision);
            if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length || flags.includes('u') && flags.includes('v'))
                throw new Error('sticky 正则标志无效');
            if (item.revision > data.revision)
                throw new Error('sticky 注册修订无效');
            const replacement = object(item.replacement, ['kind', 'value', 'id', 'identity']);
            if (replacement.kind === 'text') {
                text(replacement.value, 1024 * 1024);
                if ('id' in replacement || 'identity' in replacement)
                    throw new Error('sticky 替换描述无效');
            }
            else if (replacement.kind === 'callback') {
                text(replacement.identity);
                if (count(replacement.id) < 1 || replacement.id > data.callbackSerial || 'value' in replacement || channel === 'basic')
                    throw new Error('sticky 回调引用无效');
            }
            else
                throw new Error('sticky 替换类型无效');
            const options = object(item.options, ['user', 'assistant', 'system', 'worldinfo', 'message', 'generate', 'basic', 'order', 'before', 'after', 'minDepth', 'maxDepth']);
            for (const key of ['user', 'assistant', 'system', 'worldinfo', 'message', 'generate', 'basic', 'before', 'after'])
                if (typeof options[key] !== 'boolean')
                    throw new Error('sticky 正则选项无效');
            finite(options.order);
            for (const key of ['minDepth', 'maxDepth'])
                if (options[key] !== null)
                    finite(options[key]);
            if (options.basic !== (channel === 'basic') || options.generate !== (channel === 'generate') || options.message !== (channel === 'message'))
                throw new Error('sticky 正则阶段无效');
            return item;
        });
        unique(rules.map(rule => rule.uuid));
        const removed = list(tombstones[channel]).map(item => text(item));
        unique(removed);
        if (rules.some(rule => removed.includes(rule.uuid)))
            throw new Error('sticky 活跃规则与墓碑冲突');
    }
    const removed = list(tombstones.prompts).map(raw => { const item = object(raw, ['key', 'uid']); return JSON.stringify([text(item.key), text(item.uid)]); });
    unique(removed);
    if (prompts.some(item => removed.includes(JSON.stringify([item.key, item.uid]))))
        throw new Error('sticky 活跃注入与墓碑冲突');
    if (JSON.stringify(value).length > 2 * 1024 * 1024)
        throw new Error('sticky 状态超过 2 MiB 上限');
    return structuredClone(value);
}
export function hasTemplateStickyClosures(state) {
    return [...state.regex.generate, ...state.regex.message].some(rule => rule.replacement.kind === 'callback');
}
