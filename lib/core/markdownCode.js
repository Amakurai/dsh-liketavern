export function markdownCodeScanner(text) {
    /** 四列缩进计算留在工厂内部，整个扫描器可原样注入 MVU 沙箱，不引用外部闭包。 */
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
    const fenceResults = new Map();
    const unclosedCache = new Map();
    return {
        inlineEnd: at => inlineEnds.get(at) ?? null,
        fence: at => {
            const known = fenceResults.get(at);
            if (known)
                return known;
            const opening = openings.get(at);
            if (!opening)
                return null;
            const cacheKey = opening.quoteDepth + ':' + opening.listIndent + ':' + opening.marker[0];
            const cached = unclosedCache.get(cacheKey);
            if (cached && opening.line >= cached.fromLine && opening.line < cached.untilLine && opening.marker.length >= cached.minLen) {
                const result = { info: opening.info, contentStart: lines[opening.line].next, contentEnd: cached.endPos, end: cached.endPos, closed: false, standalone: opening.standalone };
                fenceResults.set(at, result);
                return result;
            }
            const quoted = new RegExp('^(?: {0,3}>[ \\t]?){' + opening.quoteDepth + '}');
            const close = new RegExp('^ {' + opening.listIndent + ',' + (opening.listIndent + 3) + '}'
                + opening.marker[0] + '{' + opening.marker.length + ',}[ \\t]*$');
            let endPos = text.length, untilLine = lines.length;
            for (let index = opening.line + 1; index < lines.length; index++) {
                const line = lines[index];
                const value = text.slice(line.start, line.end), prefix = quoted.exec(value)?.[0];
                if (prefix === undefined) {
                    endPos = line.start;
                    untilLine = index;
                    break;
                }
                if (close.test(expandIndentTabs(value.slice(prefix.length), expandIndentTabs(prefix).length))) {
                    const result = { info: opening.info, contentStart: lines[opening.line].next,
                        contentEnd: line.start, end: line.next, closed: true, standalone: opening.standalone };
                    fenceResults.set(at, result);
                    return result;
                }
            }
            if (!cached || opening.line >= cached.untilLine || untilLine > cached.untilLine || (untilLine === cached.untilLine && (opening.marker.length < cached.minLen || (opening.marker.length === cached.minLen && opening.line < cached.fromLine)))) {
                unclosedCache.set(cacheKey, { fromLine: opening.line, minLen: opening.marker.length, untilLine, endPos });
            }
            const result = { info: opening.info, contentStart: lines[opening.line].next, contentEnd: endPos, end: endPos, closed: false, standalone: opening.standalone };
            fenceResults.set(at, result);
            return result;
        },
    };
}
