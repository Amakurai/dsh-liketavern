/** Markdown 缩进按四列制表位计算；原始字符下标仍用于返回展示边界。 */
function expandIndentTabs(value, initialColumn = 0) {
    if (!value.includes('\t'))
        return value;
    let columns = initialColumn, expanded = '';
    for (const char of value) {
        const width = char === '\t' ? 4 - columns % 4 : 1;
        expanded += char === '\t' ? ' '.repeat(width) : char;
        columns += width;
    }
    return expanded;
}
export function markdownCodeScanner(text) {
    if (!/[`~]/.test(text))
        return { inlineEnd: () => null, fence: () => null };
    const lines = [];
    const openings = new Map();
    const lineBreak = /\r?\n/g;
    let start = 0;
    for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
        lines.push({ start, end: match.index, next: lineBreak.lastIndex });
        start = lineBreak.lastIndex;
    }
    lines.push({ start, end: text.length, next: text.length });
    for (const [index, line] of lines.entries()) {
        const value = text.slice(line.start, line.end);
        const opening = /^((?: {0,3}>[ \t]?)* {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/.exec(value);
        if (!opening)
            continue;
        const prefix = opening[1], marker = opening[2], info = opening[3];
        if (marker[0] === '`' && info.includes('`'))
            continue;
        const contentPrefix = prefix.replace(/^(?: {0,3}>[ \t]?)*/, '');
        const quoteColumns = expandIndentTabs(prefix.slice(0, prefix.length - contentPrefix.length)).length;
        openings.set(line.start + prefix.length, { marker, info, line: index,
            listIndent: /[-+*]|\d[.)]/.test(contentPrefix) ? expandIndentTabs(contentPrefix, quoteColumns).length : 0,
            quoteDepth: prefix.match(/>/g)?.length ?? 0, standalone: /^ {0,3}$/.test(prefix) });
    }
    const inlineEnds = new Map();
    const waiting = new Map();
    const markers = /`+|~{3,}|\r?\n[ \t]*\r?\n/g;
    for (let token = markers.exec(text); token; token = markers.exec(text)) {
        const raw = token[0], at = token.index;
        // 空行和真正的围栏开始新块；行内代码不能跨这些边界配对。
        if (raw[0] === '\r' || raw[0] === '\n' || openings.has(at)) {
            waiting.clear();
            continue;
        }
        if (raw[0] !== '`')
            continue;
        const pending = waiting.get(raw.length);
        if (pending)
            for (const opening of pending)
                inlineEnds.set(opening, markers.lastIndex);
        waiting.delete(raw.length);
        let slashes = 0;
        for (let index = at - 1; index >= 0 && text[index] === '\\'; index--)
            slashes++;
        const width = raw.length - (slashes % 2);
        if (width) {
            const starts = waiting.get(width) ?? [];
            starts.push(at);
            waiting.set(width, starts);
        }
    }
    return {
        inlineEnd: at => inlineEnds.get(at) ?? null,
        fence: at => {
            const opening = openings.get(at);
            if (!opening)
                return null;
            const quoted = new RegExp('^(?: {0,3}>[ \\t]?){' + opening.quoteDepth + '}');
            const close = new RegExp('^ {' + opening.listIndent + ',' + (opening.listIndent + 3) + '}'
                + opening.marker[0] + '{' + opening.marker.length + ',}[ \\t]*$');
            for (let index = opening.line + 1; index < lines.length; index++) {
                const line = lines[index];
                const value = text.slice(line.start, line.end), prefix = quoted.exec(value)?.[0];
                if (prefix !== undefined && close.test(expandIndentTabs(value.slice(prefix.length), expandIndentTabs(prefix).length)))
                    return { info: opening.info, contentStart: lines[opening.line].next,
                        contentEnd: line.start, end: line.next, closed: true, standalone: opening.standalone };
            }
            return { info: opening.info, contentStart: lines[opening.line].next, contentEnd: text.length, end: text.length, closed: false, standalone: opening.standalone };
        },
    };
}
