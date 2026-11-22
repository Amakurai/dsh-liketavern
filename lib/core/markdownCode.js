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
        return { inlineEnd: () => null, inlineSpan: () => null, fence: () => null };
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
    const inlineSpans = new Map();
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
            for (const opening of pending) {
                inlineEnds.set(opening.at, markers.lastIndex);
                inlineEnds.set(opening.start, markers.lastIndex);
                const span = { start: opening.start, end: markers.lastIndex, width: raw.length };
                inlineSpans.set(opening.at, span);
                inlineSpans.set(opening.start, span);
            }
        waiting.delete(raw.length);
        let slashes = 0;
        for (let index = at - 1; index >= 0 && text[index] === '\\'; index--)
            slashes++;
        const escaped = slashes % 2;
        const width = raw.length - escaped;
        if (width) {
            const starts = waiting.get(width) ?? [];
            starts.push({ at, start: at + escaped });
            waiting.set(width, starts);
        }
    }
    const fenceResults = new Map();
    const unclosedCache = new Map();
    return {
        inlineEnd: at => inlineEnds.get(at) ?? null,
        inlineSpan: at => inlineSpans.get(at) ?? null,
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
function hasTableCodeIndent(line) {
    let cols = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ')
            cols += 1;
        else if (ch === '\t')
            cols += 4 - (cols % 4);
        else
            break;
        if (cols >= 4)
            return true;
    }
    return false;
}
function splitGfmTableCells(content) {
    const trimmed = content.trim();
    if (!trimmed || !trimmed.includes('|'))
        return null;
    const pipeIndices = [];
    let slashes = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '\\') {
            slashes++;
            continue;
        }
        if (ch === '|' && slashes % 2 === 0)
            pipeIndices.push(i);
        slashes = 0;
    }
    if (pipeIndices.length === 0)
        return null;
    const start = pipeIndices[0] === 0 ? 1 : 0;
    const lastPipe = pipeIndices[pipeIndices.length - 1];
    const end = lastPipe === trimmed.length - 1 && lastPipe >= start ? trimmed.length - 1 : trimmed.length;
    const cells = [];
    let cellStart = start;
    for (const pipe of pipeIndices) {
        if (pipe < start || pipe >= end)
            continue;
        cells.push(trimmed.slice(cellStart, pipe).trim());
        cellStart = pipe + 1;
    }
    cells.push(trimmed.slice(cellStart, end).trim());
    return cells;
}
/**
 * 识别文本中属于 GFM 表格的行号（0 基），跳过围栏代码块。
 * 放在 `markdownCodeScanner` 之外以保持扫描器本体无外部闭包依赖。
 */
export function findGfmTableLines(text, code) {
    const tableLines = new Set();
    if (!text.includes('|') || !text.includes('-'))
        return tableLines;
    const lines = [];
    const lineBreak = /\r?\n/g;
    let start = 0;
    for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
        lines.push({ start, end: match.index, next: lineBreak.lastIndex });
        start = lineBreak.lastIndex;
    }
    lines.push({ start, end: text.length, next: text.length });
    if (lines.length < 2)
        return tableLines;
    const scanner = code ?? markdownCodeScanner(text);
    const inFence = new Set();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const value = text.slice(line.start, line.end);
        const opening = /^((?: {0,3}>[ \t]?)* {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})/.exec(value);
        if (!opening)
            continue;
        const fence = scanner.fence(line.start + opening[1].length);
        if (!fence)
            continue;
        let j = i;
        while (j < lines.length && lines[j].start < fence.end) {
            inFence.add(j);
            j++;
        }
        i = Math.max(i, j - 1);
    }
    const stripQuote = (value) => {
        const m = /^((?: {0,3}>[ \t]?)*)(.*)$/.exec(value);
        return { depth: m[1].match(/>/g)?.length ?? 0, content: m[2] };
    };
    for (let i = 0; i < lines.length - 1; i++) {
        if (inFence.has(i) || inFence.has(i + 1))
            continue;
        const head = stripQuote(text.slice(lines[i].start, lines[i].end));
        const delim = stripQuote(text.slice(lines[i + 1].start, lines[i + 1].end));
        if (head.depth !== delim.depth)
            continue;
        if (hasTableCodeIndent(head.content) || hasTableCodeIndent(delim.content))
            continue;
        const delimCells = splitGfmTableCells(delim.content);
        if (!delimCells || delimCells.length === 0 || !delimCells.every(cell => /^:?-{1,}:?$/.test(cell)))
            continue;
        const headCells = splitGfmTableCells(head.content);
        if (!headCells || headCells.length !== delimCells.length)
            continue;
        tableLines.add(i);
        tableLines.add(i + 1);
        let j = i + 2;
        while (j < lines.length && !inFence.has(j)) {
            const row = stripQuote(text.slice(lines[j].start, lines[j].end));
            if (row.depth !== head.depth || hasTableCodeIndent(row.content))
                break;
            const trimmed = row.content.trim();
            if (!trimmed || /^#{1,6}(?:[ \t]|$)/.test(trimmed))
                break;
            if (splitGfmTableCells(row.content) === null)
                break;
            tableLines.add(j);
            j++;
        }
        i = j - 1;
    }
    return tableLines;
}
