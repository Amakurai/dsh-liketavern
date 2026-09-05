import { parseTemplatePlacement } from './templatePlacement.js';
export function normalizeTemplateLore(entry) {
    if (!entry.content.startsWith('@@') || entry.content.startsWith('@@@'))
        return entry;
    const lines = entry.content.split(/\r?\n/);
    const decorators = new Map();
    while (lines[0]?.startsWith('@@') && !lines[0].startsWith('@@@')) {
        const line = lines.shift().slice(2);
        const space = line.search(/\s/);
        decorators.set(space < 0 ? line : line.slice(0, space), space < 0 ? '' : line.slice(space).trim());
    }
    let comment = entry.comment;
    const positions = {
        generate_before: '[GENERATE:BEFORE]', generate_after: '[GENERATE:AFTER]',
        render_before: '[RENDER:BEFORE]', render_after: '[RENDER:AFTER]', initial_variables: '[InitialVariables]',
    };
    const modes = Object.keys(positions).filter(key => decorators.has(key));
    if (modes.length > 1)
        throw new Error(`世界书「${comment}」包含冲突的模板位置装饰器`);
    if (modes[0]) {
        const mode = modes[0], argument = decorators.get(mode);
        let position = positions[mode];
        if (mode === 'generate_before' || mode === 'generate_after') {
            const side = mode === 'generate_before' ? 'BEFORE' : 'AFTER';
            if (argument) {
                if (/^-?\d+$/.test(argument))
                    position = `[GENERATE:${argument}:${side}]`;
                else if (/^REGEX:/i.test(argument))
                    position = `[GENERATE:${side}:REGEX:${argument.slice(6)}]`;
                else
                    throw new Error(`世界书「${comment}」的 @@${mode} 参数需要整数下标或 REGEX:模式`);
                parseTemplatePlacement(position);
            }
        }
        comment = `${position} ${comment.replace(/^\[(?:GENERATE|RENDER|InitialVariables)[^\]]*\]\s*/i, '')}`;
    }
    const special = /^\[(?:GENERATE|RENDER|InitialVariables)\b|^@INJECT\b/i.test(comment);
    const enabled = !decorators.has('dont_activate') && (entry.enabled || special && decorators.has('always_enabled'));
    if (enabled && !/^\[RENDER:(BEFORE|AFTER)\]/i.test(comment) && (decorators.has('iframe') || decorators.has('message_formatting')))
        throw new Error(`世界书「${comment}」的 iframe/message_formatting 需要 RENDER 位置`);
    const condition = decorators.get('if');
    if (condition !== undefined && !condition)
        throw new Error(`世界书「${comment}」的 @@if 条件为空`);
    if (condition && /^\[InitialVariables\]/i.test(comment))
        throw new Error('InitialVariables 暂不支持 @@if 条件');
    let content = lines.join('\n');
    // 每条目本来就有独立词法上下文；显式块同时保护多个 RENDER 条目合并后的声明。
    if (decorators.has('private'))
        content = `<% { %>${content}<% } %>`;
    return { ...entry, comment, content, enabled, constant: entry.constant || decorators.has('activate'),
        templateCondition: condition ?? entry.templateCondition,
        templatePreload: !decorators.has('dont_preload') && (decorators.has('preload') || decorators.has('only_preload')),
        templateOnlyPreload: decorators.has('only_preload'),
        templateDontActivate: decorators.has('dont_activate'),
        templateIframe: decorators.has('iframe') ? decorators.get('iframe') : entry.templateIframe,
        templateMessageFormatting: decorators.has('message_formatting') || entry.templateMessageFormatting,
        templatePreprocessing: decorators.has('preprocessing') || /^\[Preprocessing\]/i.test(comment) };
}
/** ST 特殊条目只映射到 Tavern 自有通道；绝对消息定位需要独立适配，不能悄悄降级。 */
export function templateLoreEntries(entries) {
    return entries.map(entry => {
        if (!entry.enabled)
            return entry;
        const label = entry.comment;
        if (entry.templateOnlyPreload || /^\[InitialVariables\]/i.test(label) || /^\[RENDER:(BEFORE|AFTER)\]/i.test(label))
            return { ...entry, enabled: false };
        const placement = parseTemplatePlacement(label);
        if (placement)
            return { ...entry, constant: placement.kind === 'insert' || entry.constant, content: `<% /* positioned template */ %>${entry.content}` };
        if (/^\[(?:GENERATE|RENDER|PRELOAD)\b/i.test(label) || /@INJECT\b/.test(entry.content) || /^@INJECT\b/i.test(label)) {
            throw new Error(`世界书「${label}」使用尚未支持的 ST 模板注入定位`);
        }
        return entry;
    });
}
