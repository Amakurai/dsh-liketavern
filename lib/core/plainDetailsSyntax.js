/**
 * 纯文本/Markdown `<details>` 语法与标签词表共享内核：
 * 统一承载标准 HTML/SVG/MathML 元素表、机读标签表、`<summary>`（含未闭合退化）扫描、
 * 引用块去壳与代码安全闭合定位，避免 `htmlFragment`、`displaySanitize` 与 `plainDetails`
 * 各自维护口径导致相邻折叠块拆分漂移或循环依赖。
 */
import { findGfmTableLines, markdownCodeScanner } from './markdownCode.js';
export const DISPLAY_META_TAGS = [
    'initvar',
    'UpdateVariable',
    'JSONPatch',
    'Analysis',
    'think',
    'thinking',
    'StatusPlaceHolderImpl',
];
const DISPLAY_META_NAMES = new Set(DISPLAY_META_TAGS.map(tag => tag.toLowerCase()));
/** 是否为展示层应隐藏的机读块标签名（忽略大小写）。 */
export function isDisplayMetaTagName(name) {
    return DISPLAY_META_NAMES.has(name.toLowerCase());
}
// 机读协议常用全大写标签；HTML 本身不区分大小写，不能把 <DIV>/<BR> 当协议删掉。
const HTML_ELEMENT_NAMES = new Set(('a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blockquote body br button canvas '
    + 'caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed '
    + 'fencedframe fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr '
    + 'html i iframe img input ins kbd keygen label legend li link main map mark marquee menu menuitem meta meter nav nobr noframes '
    + 'noscript object ol optgroup option output p param picture plaintext portal pre progress q rb rp rt rtc ruby s samp '
    + 'script search section select slot small source span strike strong style sub summary sup svg table tbody td '
    + 'template textarea tfoot th thead time title tr track tt u ul var video wbr xmp '
    + 'animatemotion animatetransform circle clippath defs ellipse feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix '
    + 'fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage '
    + 'femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence filter foreignobject g image '
    + 'line lineargradient mask mpath path pattern polygon polyline radialgradient rect stop symbol text textpath tref tspan use view '
    + 'annotation-xml maction math menclose merror mfenced mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow mspace '
    + 'msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics').split(' '));
/** 是否为标准 HTML / SVG / MathML 元素名（忽略大小写）。 */
export function isKnownHtmlElementName(name) {
    return HTML_ELEMENT_NAMES.has(name.toLowerCase());
}
export const MAX_PLAIN_DETAILS_CHARS = 256 * 1024;
export const MAX_PLAIN_DETAILS_DEPTH = 8;
export const MAX_PLAIN_DETAILS_BLOCKS = 64;
export const DETAILS_OPEN_RE = /<details(?:\s+(open(?:\s*=\s*(?:""|''|"open"|'open'|open))?))?\s*>/iy;
export const DETAILS_CLOSE_RE = /^<\/details\s*>/i;
const DETAILS_TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
export const SUMMARY_CANDIDATE_RE = /^<summary(?=[\t\n\f\r />])/i;
export const SUMMARY_OPEN_RE = /<summary\s*>/iy;
const SUMMARY_CLOSE_RE = /<\/summary\s*>/iy;
const SUMMARY_SCAN_RE = /<|`+|\r?\n/g;
export const BR_CANDIDATE_RE = /^<br(?=[\t\n\f\r />])/i;
export const BR_PLAIN_RE = /<br\s*\/?>/iy;
export const HR_CANDIDATE_RE = /^<hr(?=[\t\n\f\r />])/i;
export const HR_PLAIN_RE = /<hr\s*\/?>/iy;
export const AUTOLINK_CANDIDATE_RE = /<[^\s<>]+>/y;
export const BODY_TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)(?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/y;
export const CUSTOM_ELEMENT_NAME_RE = /^[a-z][\w.]*-[\w.-]*$/i;
export const RESIDUAL_TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)((?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?)>/y;
const DETAILS_BOUNDARY_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const STANDALONE_BR_LINE_RE = /^(?:<br\s*\/?>[ \t]*)+$/i;
const LEADING_BR_LINE_RE = /^<br\s*\/?>/i;
const FENCE_OPEN_LINE_RE = /^(?:(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)?(?:`{3,}[^`\r\n]*|~{3,}[^\r\n]*)$/;
const HEADING_LINE_RE = /^#{1,6}[ \t]+\S/;
const UNORDERED_LIST_LINE_RE = /^[-*+][ \t]+\S/;
const ORDERED_LIST_LINE_RE = /^\d{1,9}[.)][ \t]+\S/;
const THEMATIC_BREAK_LINE_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const DETAILS_OPEN_LINE_RE = /^<details(?:\s+(?:open(?:\s*=\s*(?:""|''|"open"|'open'|open))?))?\s*>/i;
const HR_OPEN_LINE_RE = /^<hr\s*\/?>/i;
const TAG_OPEN_HEAD_RE = /^<([A-Za-z][\w:-]*)(?=[\t\n\f\r />])/;
const STANDALONE_CUSTOM_TAG_LINE_RE = /^<([A-Za-z][\w.:-]*)(?:[ \t]+[^"'<>=\r\n]+)?\s*>$/;
const ST_COMMENT_MACRO_RE = /\{\{\s*\/\/[^{}]*\}\}/g;
const EMAIL_AUTOLINK_RE = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/;
const URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>]+>$/;
const AUTOLINK_SCHEMES = new Set([
    'http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'urn', 'irc', 'ircs',
    'ws', 'wss', 'ssh', 'git', 'file', 'magnet', 'news', 'xmpp', 'sip',
    'sips', 'sms', 'geo', 'data', 'blob', 'javascript', 'vbscript',
]);
const SUMMARY_NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ensp: '\u2002',
    emsp: '\u2003',
    thinsp: '\u2009',
    mdash: '\u2014',
    ndash: '\u2013',
    hellip: '\u2026',
    bull: '\u2022',
    middot: '\u00b7',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    laquo: '\u00ab',
    raquo: '\u00bb',
    times: '\u00d7',
    divide: '\u00f7',
    plusmn: '\u00b1',
    minus: '\u2212',
    ne: '\u2260',
    le: '\u2264',
    ge: '\u2265',
    infin: '\u221e',
    deg: '\u00b0',
    yen: '\u00a5',
    euro: '\u20ac',
    pound: '\u00a3',
    cent: '\u00a2',
    sect: '\u00a7',
    para: '\u00b6',
    copy: '\u00a9',
    reg: '\u00ae',
    trade: '\u2122',
    rarr: '\u2192',
    larr: '\u2190',
    uarr: '\u2191',
    darr: '\u2193',
    harr: '\u2194',
    hearts: '\u2665',
    spades: '\u2660',
    clubs: '\u2663',
    diams: '\u2666',
    loz: '\u25ca',
    check: '\u2713',
    cross: '\u2717',
    starf: '\u2605',
};
export function decodeSummaryEntities(text) {
    if (!text.includes('&'))
        return text;
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (raw, dec, hex, named) => {
        if (named !== undefined) {
            const key = named.toLowerCase();
            return Object.hasOwn(SUMMARY_NAMED_ENTITIES, key) ? SUMMARY_NAMED_ENTITIES[key] : raw;
        }
        const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
        if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
            return raw;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff)
            return raw;
        if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
            || (codePoint >= 0x7f && codePoint <= 0x9f)) {
            return raw;
        }
        return String.fromCodePoint(codePoint);
    });
}
export function skipIgnorableHtml(text, start) {
    let cursor = start;
    while (cursor < text.length) {
        while (cursor < text.length && /\s/.test(text[cursor]))
            cursor++;
        if (text.startsWith('<!--', cursor)) {
            const end = text.indexOf('-->', cursor + 4);
            if (end < 0)
                return null;
            cursor = end + 3;
            continue;
        }
        break;
    }
    return cursor;
}
function indentColumns(line) {
    let columns = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ')
            columns += 1;
        else if (ch === '\t')
            columns += 4 - (columns % 4);
        else
            break;
    }
    return columns;
}
function stripIndentColumns(line, target) {
    if (!/\S/.test(line))
        return '';
    let columns = 0;
    let index = 0;
    while (index < line.length && columns < target) {
        const ch = line[index];
        if (ch === ' ') {
            columns += 1;
            index += 1;
        }
        else if (ch === '\t') {
            const next = columns + (4 - (columns % 4));
            if (next > target)
                return ' '.repeat(next - target) + line.slice(index + 1);
            columns = next;
            index += 1;
        }
        else {
            break;
        }
    }
    return line.slice(index);
}
/** 剥离 HTML 缩进习惯产生的公共前导空白，避免被 CommonMark 误识别为四空格缩进代码块。 */
export function dedentCommonIndent(text) {
    if (!text)
        return text;
    const lines = [];
    const lineBreak = /\r?\n/g;
    let start = 0;
    let minIndent = Number.POSITIVE_INFINITY;
    for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
        const line = text.slice(start, match.index);
        lines.push({ text: line, breakText: match[0] });
        if (/\S/.test(line))
            minIndent = Math.min(minIndent, indentColumns(line));
        start = lineBreak.lastIndex;
    }
    const tail = text.slice(start);
    lines.push({ text: tail, breakText: '' });
    if (/\S/.test(tail))
        minIndent = Math.min(minIndent, indentColumns(tail));
    if (!Number.isFinite(minIndent) || minIndent <= 0)
        return text;
    return lines.map(line => stripIndentColumns(line.text, minIndent) + line.breakText).join('');
}
export function isAutolinkToken(token) {
    if (EMAIL_AUTOLINK_RE.test(token))
        return true;
    if (!/\s/.test(token)) {
        const uri = URI_AUTOLINK_RE.exec(token);
        if (uri && (token.includes('://') || AUTOLINK_SCHEMES.has(uri[1].toLowerCase())))
            return true;
    }
    return false;
}
function splitGfmPipeCells(trimmed) {
    if (!trimmed || !trimmed.includes('|'))
        return null;
    const pipes = [];
    let slashes = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '\\') {
            slashes++;
            continue;
        }
        if (ch === '|' && slashes % 2 === 0)
            pipes.push(i);
        slashes = 0;
    }
    if (pipes.length === 0)
        return null;
    const start = pipes[0] === 0 ? 1 : 0;
    const lastPipe = pipes[pipes.length - 1];
    const end = lastPipe === trimmed.length - 1 && lastPipe >= start ? trimmed.length - 1 : trimmed.length;
    const cells = [];
    let cellStart = start;
    for (const pipe of pipes) {
        if (pipe < start || pipe >= end)
            continue;
        cells.push(trimmed.slice(cellStart, pipe).trim());
        cellStart = pipe + 1;
    }
    cells.push(trimmed.slice(cellStart, end).trim());
    return cells;
}
function isGfmTableStart(headerTrimmed, delimTrimmed) {
    if (!headerTrimmed.includes('|') || !delimTrimmed.includes('-'))
        return false;
    const delimCells = splitGfmPipeCells(delimTrimmed);
    if (!delimCells || delimCells.length === 0 || !delimCells.every(cell => /^:?-{1,}:?$/.test(cell)))
        return false;
    const headerCells = splitGfmPipeCells(headerTrimmed);
    return headerCells !== null && headerCells.length === delimCells.length;
}
function lineBoundsAt(text, lineStart) {
    let end = lineStart;
    while (end < text.length) {
        const ch = text[end];
        if (ch === '\r') {
            return { end, next: text[end + 1] === '\n' ? end + 2 : end + 1 };
        }
        if (ch === '\n') {
            return { end, next: end + 1 };
        }
        end++;
    }
    return { end, next: text.length };
}
/**
 * 识别未闭合 `<summary>` 后可无歧义作为正文起点的行边界：
 * 空行、独立 `<br>` 间隔行、代码围栏、标题/列表/引用/分隔线/GFM 表格，
 * 以及嵌套纯 `<details>`、`<hr>`、机读块与独立行自定义伪标签。
 * 普通纯文本续行返回 `null`，保持无空行纯文本回退 iframe 的保守契约。
 */
function classifyBodyStartLine(text, lineStart, lineEnd, nextLineStart) {
    const trimmed = text.slice(lineStart, lineEnd).trim();
    if (!trimmed)
        return { kind: 'blank', bodyStart: nextLineStart };
    if (STANDALONE_BR_LINE_RE.test(trimmed))
        return { kind: 'br-line', bodyStart: nextLineStart };
    if (LEADING_BR_LINE_RE.test(trimmed))
        return { kind: 'block', bodyStart: lineStart };
    if (FENCE_OPEN_LINE_RE.test(trimmed))
        return { kind: 'fence', bodyStart: lineStart };
    if (HEADING_LINE_RE.test(trimmed)
        || UNORDERED_LIST_LINE_RE.test(trimmed)
        || ORDERED_LIST_LINE_RE.test(trimmed)
        || trimmed.startsWith('>')
        || THEMATIC_BREAK_LINE_RE.test(trimmed)
        || DETAILS_OPEN_LINE_RE.test(trimmed)
        || HR_OPEN_LINE_RE.test(trimmed)) {
        return { kind: 'block', bodyStart: lineStart };
    }
    if (trimmed.startsWith('<')) {
        const head = TAG_OPEN_HEAD_RE.exec(trimmed);
        if (head && isDisplayMetaTagName(head[1]))
            return { kind: 'block', bodyStart: lineStart };
        const standalone = STANDALONE_CUSTOM_TAG_LINE_RE.exec(trimmed);
        if (standalone) {
            const name = standalone[1];
            if (!isKnownHtmlElementName(name) && !CUSTOM_ELEMENT_NAME_RE.test(name)) {
                return { kind: 'block', bodyStart: lineStart };
            }
        }
    }
    if (trimmed.includes('|') && nextLineStart < text.length) {
        const nextBounds = lineBoundsAt(text, nextLineStart);
        const nextTrimmed = text.slice(nextLineStart, nextBounds.end).trim();
        if (isGfmTableStart(trimmed, nextTrimmed))
            return { kind: 'block', bodyStart: lineStart };
    }
    return null;
}
/**
 * 扫描 `<summary>` 内容：
 * - 正常闭合 `<summary>…</summary>` 放行闭合注释、自动链接、行内代码与安全泛型；
 * - 未闭合 `<summary>`（#31）在首个空行、独立/行尾 `<br>` 或无歧义正文块起点切分摘要与正文，
 *   并跳过正文代码跨度/围栏内的 `</summary>` 与 `<!--`，全程 O(n) 扫描。
 */
export function scanPlainSummary(text, summaryStart) {
    const re = new RegExp(SUMMARY_SCAN_RE.source, SUMMARY_SCAN_RE.flags);
    re.lastIndex = summaryStart;
    const chunks = [];
    let chunkStart = summaryStart;
    let fallbackSplit = null;
    let leadingEmptySplit = null;
    let sawCodeSummaryCloseAfterFallback = false;
    const failedBefore = new Map();
    const failedAfter = new Map();
    const buildResult = (rawSummary, bodyStart) => {
        const consumed = text.slice(summaryStart, bodyStart);
        return {
            summary: decodeSummaryEntities(rawSummary).trim(),
            bodyStart,
            hasCodeSyntax: rawSummary.includes('`') || rawSummary.includes('~~~') || consumed.includes('`') || consumed.includes('~~~'),
        };
    };
    const findBalancedInlineCodeBeforeSplit = (afterOpen, width) => {
        const cachedStop = failedBefore.get(width);
        if (cachedStop !== undefined && afterOpen < cachedStop)
            return null;
        let pos = afterOpen;
        while (pos < text.length) {
            const ch = text[pos];
            if (ch === '\r' || ch === '\n') {
                const nlEnd = ch === '\r' && text[pos + 1] === '\n' ? pos + 2 : pos + 1;
                const nextBounds = lineBoundsAt(text, nlEnd);
                if (classifyBodyStartLine(text, nlEnd, nextBounds.end, nextBounds.next) !== null) {
                    failedBefore.set(width, pos);
                    return null;
                }
                pos = nlEnd;
                continue;
            }
            if (ch === '<') {
                const probe = text.slice(pos, Math.min(text.length, pos + 16));
                if (/^<\/(?:summary|details)\s*>/i.test(probe)) {
                    failedBefore.set(width, pos);
                    return null;
                }
            }
            if (ch === '`') {
                let runEnd = pos + 1;
                while (runEnd < text.length && text[runEnd] === '`')
                    runEnd++;
                if (runEnd - pos === width)
                    return runEnd;
                pos = runEnd;
                continue;
            }
            pos++;
        }
        failedBefore.set(width, text.length);
        return null;
    };
    const findBalancedInlineCodeAfterSplit = (afterOpen, width) => {
        const cachedStop = failedAfter.get(width);
        if (cachedStop !== undefined && afterOpen < cachedStop)
            return null;
        let pos = afterOpen;
        let sawSummaryClose = false;
        while (pos < text.length) {
            const ch = text[pos];
            if (ch === '\r' || ch === '\n') {
                const nlEnd = ch === '\r' && text[pos + 1] === '\n' ? pos + 2 : pos + 1;
                let ws = nlEnd;
                while (ws < text.length && (text[ws] === ' ' || text[ws] === '\t'))
                    ws++;
                if (ws >= text.length || text[ws] === '\r' || text[ws] === '\n') {
                    failedAfter.set(width, pos);
                    return null;
                }
                pos = nlEnd;
                continue;
            }
            if (ch === '<') {
                const probe = text.slice(pos, Math.min(text.length, pos + 16));
                if (/^<\/details\s*>/i.test(probe)) {
                    failedAfter.set(width, pos);
                    return null;
                }
                if (/^<\/summary\s*>/i.test(probe))
                    sawSummaryClose = true;
            }
            if (ch === '`') {
                let runEnd = pos + 1;
                while (runEnd < text.length && text[runEnd] === '`')
                    runEnd++;
                if (runEnd - pos === width)
                    return { end: runEnd, sawSummaryClose };
                pos = runEnd;
                continue;
            }
            pos++;
        }
        failedAfter.set(width, text.length);
        return null;
    };
    for (let match = re.exec(text); match; match = re.exec(text)) {
        const raw = match[0];
        const at = match.index;
        if (raw[0] === '\r' || raw[0] === '\n') {
            const lineStart = re.lastIndex;
            const bounds = lineBoundsAt(text, lineStart);
            const classified = classifyBodyStartLine(text, lineStart, bounds.end, bounds.next);
            if (!classified)
                continue;
            if (fallbackSplit) {
                // 已切入候选正文且遇到围栏代码块：立即按未闭合摘要返回，交给正文阶段以完整代码扫描器校验。
                if (classified.kind === 'fence')
                    return buildResult(fallbackSplit.rawSummary, fallbackSplit.bodyStart);
                continue;
            }
            const rawBefore = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at);
            const hasSummaryText = rawBefore.trim().length > 0;
            if (classified.kind === 'blank' || classified.kind === 'br-line') {
                if (hasSummaryText) {
                    fallbackSplit = { rawSummary: rawBefore, bodyStart: classified.bodyStart };
                }
                else if (!leadingEmptySplit) {
                    leadingEmptySplit = { rawSummary: '', bodyStart: classified.bodyStart };
                }
                continue;
            }
            if (classified.kind === 'fence') {
                return buildResult(hasSummaryText ? rawBefore : '', classified.bodyStart);
            }
            // classified.kind === 'block'
            if (hasSummaryText) {
                fallbackSplit = { rawSummary: rawBefore, bodyStart: classified.bodyStart };
            }
            else if (leadingEmptySplit) {
                fallbackSplit = { rawSummary: '', bodyStart: classified.bodyStart };
            }
            continue;
        }
        if (raw[0] === '`') {
            let slashes = 0;
            for (let i = at - 1; i >= summaryStart && text[i] === '\\'; i--)
                slashes++;
            const width = raw.length - (slashes % 2);
            if (width > 0) {
                if (!fallbackSplit) {
                    const codeEnd = findBalancedInlineCodeBeforeSplit(re.lastIndex, width);
                    if (codeEnd !== null)
                        re.lastIndex = codeEnd;
                }
                else {
                    const codeSpan = findBalancedInlineCodeAfterSplit(re.lastIndex, width);
                    if (codeSpan !== null) {
                        re.lastIndex = codeSpan.end;
                        if (codeSpan.sawSummaryClose)
                            sawCodeSummaryCloseAfterFallback = true;
                    }
                }
            }
            continue;
        }
        // raw === '<'
        SUMMARY_CLOSE_RE.lastIndex = at;
        if (SUMMARY_CLOSE_RE.exec(text)) {
            // 候选正文行内代码里已出现过 `</summary>`：浏览器实际会提前闭合，不再跨过它认领后续 `</summary>`。
            if (sawCodeSummaryCloseAfterFallback && fallbackSplit) {
                return buildResult(fallbackSplit.rawSummary, fallbackSplit.bodyStart);
            }
            const rawSummary = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at);
            return buildResult(rawSummary, SUMMARY_CLOSE_RE.lastIndex);
        }
        if (text.startsWith('<!--', at)) {
            const close = text.indexOf('-->', at + 4);
            if (close < 0)
                return null;
            if (at > chunkStart)
                chunks.push(text.slice(chunkStart, at));
            chunkStart = close + 3;
            re.lastIndex = close + 3;
            continue;
        }
        AUTOLINK_CANDIDATE_RE.lastIndex = at;
        const autolink = AUTOLINK_CANDIDATE_RE.exec(text);
        if (autolink && isAutolinkToken(autolink[0])) {
            re.lastIndex = AUTOLINK_CANDIDATE_RE.lastIndex;
            continue;
        }
        // 未闭合摘要行尾直接跟无属性 `<br>`/`<br/>` 后换行时，按摘要与正文的分界处理；
        // 若后文存在真正的 `</summary>`，仍会留给正文阶段拦截并回退 iframe。
        if (!fallbackSplit && BR_CANDIDATE_RE.test(text.slice(at, Math.min(text.length, at + 8)))) {
            BR_PLAIN_RE.lastIndex = at;
            const br = BR_PLAIN_RE.exec(text);
            if (br) {
                const eol = /^(?:[ \t]*<br\s*\/?>)*[ \t]*\r?\n/i.exec(text.slice(BR_PLAIN_RE.lastIndex));
                if (eol) {
                    const rawBefore = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at);
                    if (rawBefore.trim().length > 0) {
                        return buildResult(rawBefore, BR_PLAIN_RE.lastIndex + eol[0].length);
                    }
                }
            }
        }
        // 常见手误：摘要行尾把 `</summary>` 漏写斜杠写成 `<summary>`（紧跟换行，无属性）；
        // 若后文仍有真实 `</summary>` 或重复 `<summary>`，仍由正文阶段拦截回退 iframe。
        if (!fallbackSplit && SUMMARY_CANDIDATE_RE.test(text.slice(at, Math.min(text.length, at + 16)))) {
            SUMMARY_OPEN_RE.lastIndex = at;
            const typoClose = SUMMARY_OPEN_RE.exec(text);
            if (typoClose) {
                const eol = /^[ \t]*\r?\n/.exec(text.slice(SUMMARY_OPEN_RE.lastIndex));
                if (eol) {
                    const rawBefore = (chunks.length > 0 ? chunks.join('') : '') + text.slice(chunkStart, at);
                    if (rawBefore.trim().length > 0) {
                        return buildResult(rawBefore, SUMMARY_OPEN_RE.lastIndex + eol[0].length);
                    }
                }
            }
        }
        const nextChar = text[at + 1];
        if (!nextChar || !/[!?/A-Za-z]/.test(nextChar))
            continue;
        // 与正文一致：放行紧跟标识符的纯泛型记号（如 `Array<string>`），严禁标准 HTML/机读/自定义/属性/闭合标签。
        if (!fallbackSplit && at > summaryStart && /[A-Za-z0-9_$\])]/.test(text[at - 1])) {
            RESIDUAL_TAG_RE.lastIndex = at;
            const tag = RESIDUAL_TAG_RE.exec(text);
            if (tag) {
                const closing = tag[1] === '/';
                const name = tag[2];
                const attrs = tag[3] ?? '';
                if (!closing && !isKnownHtmlElementName(name) && !isDisplayMetaTagName(name)
                    && !CUSTOM_ELEMENT_NAME_RE.test(name) && attrs.trim().length === 0) {
                    re.lastIndex = RESIDUAL_TAG_RE.lastIndex;
                    continue;
                }
            }
        }
        // 命中非允许标签边界：若之前已遇到空行或正文块起点则退化为 #31 未闭合摘要，后续正文仍接受完整安全校验。
        const chosen = fallbackSplit ?? leadingEmptySplit;
        if (chosen)
            return buildResult(chosen.rawSummary, chosen.bodyStart);
        return null;
    }
    return null;
}
/**
 * 剥离包裹整块 `<details>` 的外层引用块前缀（如 `> <details>\n> <summary>...</summary>\n> 正文\n> </details>`）。
 * 只有当 `</details>` 所在行自身带有引用前缀、且内部每个非空行都共享至少同层前缀时才剥离，
 * 绝不误伤正文内部的引用行（如 `#28` 的 `<details>...>契约者: 希尔薇\n</details>`）。
 */
export function unwrapBlockquotedDetails(html) {
    if (!html.includes('>'))
        return html;
    const lines = [];
    const re = /\r?\n/g;
    let start = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
        lines.push({ text: html.slice(start, m.index), breakText: m[0] });
        start = re.lastIndex;
    }
    lines.push({ text: html.slice(start), breakText: '' });
    if (lines.length < 2)
        return html;
    let lastNonEmpty = lines.length - 1;
    while (lastNonEmpty >= 0 && !lines[lastNonEmpty].text.trim())
        lastNonEmpty--;
    if (lastNonEmpty < 1)
        return html;
    const countQuoteDepth = (line) => {
        const m = /^((?: {0,3}>[ \t]?)+)/.exec(line);
        return m ? (m[1].match(/>/g)?.length ?? 0) : 0;
    };
    const stripQuoteDepth = (line, depth) => {
        let rest = line;
        for (let d = 0; d < depth; d++) {
            const m = /^ {0,3}>[ \t]?/.exec(rest);
            if (!m)
                break;
            rest = rest.slice(m[0].length);
        }
        return rest;
    };
    const lastLine = lines[lastNonEmpty].text;
    const depth = countQuoteDepth(lastLine);
    if (depth === 0)
        return html;
    if (!DETAILS_CLOSE_RE.test(stripQuoteDepth(lastLine, depth).trim()))
        return html;
    for (let i = 1; i <= lastNonEmpty; i++) {
        const text = lines[i].text;
        if (!text.trim())
            continue;
        if (countQuoteDepth(text) < depth)
            return html;
    }
    const firstDepth = countQuoteDepth(lines[0].text);
    if (firstDepth > 0 && firstDepth < depth)
        return html;
    return lines.map((line, index) => {
        if (index === 0) {
            return (firstDepth >= depth ? stripQuoteDepth(line.text, depth) : line.text) + line.breakText;
        }
        return (line.text.trim() ? stripQuoteDepth(line.text, depth) : '') + line.breakText;
    }).join('');
}
/**
 * 代码区间仅在不跨越未配对 `<details>`/`</details>` HTML 边界且围栏已闭合时才允许跳过，
 * 防止反引号或未闭合围栏跨过 `</details>` 将相邻 `<script>` 或第二个折叠块吞入同一代码块。
 */
export function detailsSafeCodeEnd(text, at, code) {
    const fence = code.fence(at);
    let end;
    if (fence) {
        if (!fence.closed)
            return null;
        end = fence.end;
    }
    else {
        const inlineEnd = code.inlineEnd(at);
        if (inlineEnd === null)
            return null;
        end = inlineEnd;
    }
    const slice = text.slice(at, end);
    if (!slice.includes('<'))
        return end;
    const boundary = new RegExp(DETAILS_BOUNDARY_RE.source, DETAILS_BOUNDARY_RE.flags);
    let localDepth = 0;
    for (let match = boundary.exec(slice); match; match = boundary.exec(slice)) {
        const raw = match[0];
        if (raw.startsWith('<!--')) {
            if (!raw.endsWith('-->'))
                return null;
            continue;
        }
        if (raw.startsWith('</')) {
            if (!DETAILS_CLOSE_RE.test(raw))
                return null;
            if (--localDepth < 0)
                return null;
            continue;
        }
        if (raw.endsWith('/>'))
            return null;
        localDepth++;
    }
    return localDepth === 0 ? end : null;
}
export function findMatchingDetailsClose(text, start, code) {
    const tokens = new RegExp(DETAILS_TOKEN_RE.source, DETAILS_TOKEN_RE.flags);
    tokens.lastIndex = start;
    let depth = 1;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0];
        const at = token.index;
        if (raw.startsWith('<!--')) {
            if (!raw.endsWith('-->'))
                return null;
            continue;
        }
        if (raw[0] === '`' || raw[0] === '~') {
            const end = detailsSafeCodeEnd(text, at, code);
            if (end !== null)
                tokens.lastIndex = end;
            continue;
        }
        if (raw.startsWith('</')) {
            if (!DETAILS_CLOSE_RE.test(raw))
                return null;
            if (--depth === 0)
                return { closeStart: at, closeEnd: tokens.lastIndex };
            continue;
        }
        if (raw.endsWith('/>'))
            return null;
        depth++;
    }
    return null;
}
const CUSTOM_TAG_HEAD_RE = /^<(\/?)([A-Za-z][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?=[ \t/>])/;
const PROTOCOL_TAG_RE = /<\/?([A-Za-z][\w]*_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/g;
/** 在单行内扫描自定义伪标签的结束 `>`，跳过 `="..."`/`='...'` 属性引号内的 `>` 与 `<`。 */
export function scanCustomTagTokenEnd(line, start) {
    if (line[start] !== '<')
        return -1;
    let quote = null;
    for (let j = start + 1; j < line.length; j++) {
        const ch = line[j];
        if (quote !== null) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let back = j - 1;
            while (back > start && (line[back] === ' ' || line[back] === '\t'))
                back--;
            if (back > start && line[back] === '=')
                quote = ch;
            continue;
        }
        if (ch === '<')
            return -1;
        if (ch === '>')
            return j;
    }
    return -1;
}
/** 按 CommonMark 四列制表位剥离多层引用块前缀并判定剩余缩进是否达到 4 列缩进代码。 */
export function scanBlockquoteAndIndent(line) {
    let index = 0;
    let col = 0;
    let quotePrefixEnd = 0;
    while (index < line.length) {
        let probe = index;
        let probeCol = col;
        let spaces = 0;
        while (probe < line.length && spaces < 4) {
            const ch = line[probe];
            if (ch === ' ') {
                spaces++;
                probeCol++;
                probe++;
            }
            else if (ch === '\t') {
                const width = 4 - (probeCol % 4);
                if (spaces + width >= 4)
                    break;
                spaces += width;
                probeCol += width;
                probe++;
            }
            else {
                break;
            }
        }
        if (line[probe] !== '>')
            break;
        probe++;
        probeCol++;
        if (probe < line.length) {
            if (line[probe] === ' ') {
                probe++;
                probeCol++;
            }
            else if (line[probe] === '\t') {
                const width = 4 - (probeCol % 4);
                probe++;
                index = probe;
                quotePrefixEnd = probe;
                let indentCols = width - 1;
                col = probeCol + width;
                if (indentCols >= 4)
                    return { quotePrefixEnd, contentStart: index, indentedCode: true };
                while (index < line.length) {
                    const ch = line[index];
                    if (ch === ' ') {
                        indentCols++;
                        col++;
                        index++;
                    }
                    else if (ch === '\t') {
                        const tabWidth = 4 - (col % 4);
                        indentCols += tabWidth;
                        col += tabWidth;
                        index++;
                    }
                    else {
                        break;
                    }
                    if (indentCols >= 4)
                        return { quotePrefixEnd, contentStart: index, indentedCode: true };
                }
                continue;
            }
        }
        index = probe;
        col = probeCol;
        quotePrefixEnd = probe;
    }
    let indentCols = 0;
    while (index < line.length) {
        const ch = line[index];
        if (ch === ' ') {
            indentCols++;
            col++;
            index++;
        }
        else if (ch === '\t') {
            const width = 4 - (col % 4);
            indentCols += width;
            col += width;
            index++;
        }
        else {
            break;
        }
        if (indentCols >= 4)
            return { quotePrefixEnd, contentStart: index, indentedCode: true };
    }
    return { quotePrefixEnd, contentStart: index, indentedCode: false };
}
/** 判定单个尖括号记号是否为非标准 HTML、非自动链接的自定义伪标签，返回小写标签名。 */
export function customTagName(token) {
    if (!token.startsWith('<') || !token.endsWith('>') || token.includes('\n') || token.includes('\r'))
        return null;
    if (token.startsWith('<!--') || token.startsWith('<!') || token.startsWith('<?'))
        return null;
    if (isAutolinkToken(token))
        return null;
    const match = CUSTOM_TAG_HEAD_RE.exec(token);
    if (!match)
        return null;
    if (scanCustomTagTokenEnd(token, 0) !== token.length - 1)
        return null;
    const name = match[2];
    return isKnownHtmlElementName(name) ? null : name.toLowerCase();
}
function stripCustomTagTokensInLine(line, strippedNames) {
    if (!line.includes('<'))
        return line;
    if (scanBlockquoteAndIndent(line).indentedCode)
        return line;
    const out = [];
    let cursor = 0;
    let i = 0;
    while (i < line.length) {
        if (line[i] !== '<') {
            i++;
            continue;
        }
        const end = scanCustomTagTokenEnd(line, i);
        if (end > i) {
            const name = customTagName(line.slice(i, end + 1));
            if (name !== null && strippedNames.has(name)) {
                if (i > cursor)
                    out.push(line.slice(cursor, i));
                cursor = end + 1;
            }
            i = end + 1;
            continue;
        }
        i++;
    }
    if (cursor === 0)
        return line;
    if (cursor < line.length)
        out.push(line.slice(cursor));
    return out.join('');
}
/** 扫描单行是否仅由行首自定义伪标签组成，返回提取出的标签名列表；不匹配返回 `null`。 */
export function extractStandaloneCustomTagLine(line) {
    if (!line.includes('<'))
        return null;
    const layout = scanBlockquoteAndIndent(line);
    if (layout.indentedCode)
        return null;
    const trimmed = line.slice(layout.contentStart).replace(/[ \t]+$/, '');
    if (!trimmed.startsWith('<'))
        return null;
    const names = [];
    let pos = 0;
    while (pos < trimmed.length) {
        if (trimmed[pos] !== '<')
            return null;
        const end = scanCustomTagTokenEnd(trimmed, pos);
        if (end <= pos)
            return null;
        const name = customTagName(trimmed.slice(pos, end + 1));
        if (name === null)
            return null;
        names.push(name);
        pos = end + 1;
        while (pos < trimmed.length && (trimmed[pos] === ' ' || trimmed[pos] === '\t'))
            pos++;
    }
    return names.length > 0 ? { quotePrefixEnd: layout.quotePrefixEnd, names } : null;
}
/**
 * 清理会触发 CommonMark Type 7 HTML 块并吞掉后续围栏的行首自定义伪标签，
 * 以及与这些已确认伪标签同行混写的配对残余；跳过缩进代码、自动链接与标准 HTML 元素。
 */
export function stripCustomTags(text, extraNames) {
    if (!text.includes('<'))
        return text;
    const strippedNames = new Set(extraNames);
    const firstPass = [];
    const lineBreak = /\r?\n/g;
    let lineStart = 0;
    let changed = false;
    const processLine = (line, breakText) => {
        const standalone = extractStandaloneCustomTagLine(line);
        if (standalone) {
            for (const name of standalone.names)
                strippedNames.add(name);
            firstPass.push(line.slice(0, standalone.quotePrefixEnd).replace(/[ \t]+$/, ''), breakText);
            changed = true;
            return;
        }
        firstPass.push(line, breakText);
    };
    for (let match = lineBreak.exec(text); match; match = lineBreak.exec(text)) {
        processLine(text.slice(lineStart, match.index), match[0]);
        lineStart = lineBreak.lastIndex;
    }
    processLine(text.slice(lineStart), '');
    if (!changed && strippedNames.size === 0)
        return text;
    const pass1 = changed ? firstPass.join('') : text;
    if (strippedNames.size === 0 || !pass1.includes('<'))
        return pass1;
    const secondPass = [];
    let sStart = 0;
    let sChanged = false;
    lineBreak.lastIndex = 0;
    for (let match = lineBreak.exec(pass1); match; match = lineBreak.exec(pass1)) {
        const line = pass1.slice(sStart, match.index);
        const next = stripCustomTagTokensInLine(line, strippedNames);
        if (next !== line)
            sChanged = true;
        secondPass.push(next, match[0]);
        sStart = lineBreak.lastIndex;
    }
    const tail = pass1.slice(sStart);
    const nextTail = stripCustomTagTokensInLine(tail, strippedNames);
    if (nextTail !== tail)
        sChanged = true;
    secondPass.push(nextTail);
    return sChanged ? secondPass.join('') : pass1;
}
/** 收起未转换成 HTML 的协议开闭标签，留下内部正文；跳过标准 HTML 与大写 URI/邮箱自动链接。 */
export function stripProtocolTags(text) {
    return text.replace(PROTOCOL_TAG_RE, (match, name) => {
        if (isKnownHtmlElementName(name))
            return match;
        if (isAutolinkToken(match))
            return match;
        return '';
    });
}
/** 检测净化后的纯折叠块 Markdown 片段中是否仍残留未允许标签。 */
export function hasResidualTag(text) {
    if (!text.includes('<'))
        return false;
    const code = markdownCodeScanner(text);
    const tokens = /<|`+|~{3,}/g;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const at = token.index;
        if (token[0] !== '<') {
            const end = code.fence(at)?.end ?? code.inlineEnd(at);
            if (end !== null)
                tokens.lastIndex = end;
            continue;
        }
        RESIDUAL_TAG_RE.lastIndex = at;
        const tag = RESIDUAL_TAG_RE.exec(text);
        if (!tag || isAutolinkToken(tag[0]))
            continue;
        const closing = tag[1] === '/';
        const name = tag[2];
        const attrs = tag[3] ?? '';
        // 放行行内泛型/占位记号（如 `Array<string>`），仍严格拦截标准 HTML/SVG/MathML、
        // 机读标签、自定义元素（含连字符）、带属性/空白标签与闭合标签。
        if (closing || isKnownHtmlElementName(name) || isDisplayMetaTagName(name)
            || CUSTOM_ELEMENT_NAME_RE.test(name) || attrs.trim().length > 0) {
            return true;
        }
    }
    return false;
}
/** 按 HTML5 属性状态判定单标签是否自闭合，避免未引号属性值末尾的 `/` 被误判。 */
function isPlainSelfClosingTag(raw) {
    if (!raw.endsWith('/>') || raw.startsWith('</'))
        return false;
    const slash = raw.length - 2;
    let i = 1;
    const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
    while (i < slash && !isSpace(raw[i]) && raw[i] !== '/')
        i++;
    let state = 'before-name';
    let quote = null;
    for (; i < slash; i++) {
        const ch = raw[i];
        if (state === 'quoted') {
            if (ch === quote) {
                quote = null;
                state = 'after-value';
            }
            continue;
        }
        if (state === 'before-name') {
            if (isSpace(ch) || ch === '/')
                continue;
            state = 'name';
        }
        else if (state === 'name') {
            if (isSpace(ch))
                state = 'after-name';
            else if (ch === '=')
                state = 'before-value';
            else if (ch === '/')
                state = 'before-name';
        }
        else if (state === 'after-name') {
            if (isSpace(ch))
                continue;
            if (ch === '=')
                state = 'before-value';
            else if (ch === '/')
                state = 'before-name';
            else
                state = 'name';
        }
        else if (state === 'before-value') {
            if (isSpace(ch))
                continue;
            if (ch === '"' || ch === "'") {
                quote = ch;
                state = 'quoted';
            }
            else
                state = 'unquoted';
        }
        else if (state === 'unquoted') {
            if (isSpace(ch))
                state = 'before-name';
        }
        else if (state === 'after-value') {
            if (isSpace(ch) || ch === '/')
                state = 'before-name';
            else
                state = 'name';
        }
    }
    return state === 'before-name' || state === 'name' || state === 'after-name' || state === 'after-value';
}
/** 仅按机读标签边界清理纯折叠块 Markdown 分片中的机读块（供无环依赖校验与 `stripDisplayMeta` 对齐）。 */
function stripPlainChunkMeta(text) {
    if (!text.includes('<'))
        return text;
    const stack = [];
    const ranges = [];
    const tagRe = /<(\/?)([A-Za-z][\w:-]*)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
    let cursor = 0;
    while (cursor < text.length) {
        const open = text.indexOf('<', cursor);
        if (open < 0)
            break;
        tagRe.lastIndex = open;
        const m = tagRe.exec(text);
        if (!m || m.index !== open) {
            const head = /^<([A-Za-z][\w:-]*)(?=[\t\n\f\r />]|$)/.exec(text.slice(open, Math.min(text.length, open + 32)));
            if (head && isDisplayMetaTagName(head[1])) {
                ranges.push({ start: open, end: text.length });
                break;
            }
            cursor = open + 1;
            continue;
        }
        const closing = m[1] === '/';
        const name = m[2].toLowerCase();
        const end = tagRe.lastIndex;
        if (!DISPLAY_META_NAMES.has(name)) {
            cursor = end;
            continue;
        }
        const slash = !closing && isPlainSelfClosingTag(m[0]);
        if (!closing) {
            stack.push({ name, start: open, tokenEnd: end, slash });
        }
        else {
            let matchIdx = stack.length - 1;
            while (matchIdx >= 0 && stack[matchIdx].name !== name && stack[matchIdx].slash)
                matchIdx--;
            if (matchIdx >= 0 && stack[matchIdx].name === name) {
                ranges.push({ start: stack[matchIdx].start, end });
                stack.length = matchIdx;
            }
            else {
                ranges.push({ start: open, end });
            }
        }
        cursor = end;
    }
    for (const opened of stack) {
        ranges.push({ start: opened.start, end: opened.slash ? opened.tokenEnd : text.length });
    }
    if (ranges.length === 0)
        return text;
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    let pos = 0;
    for (const range of ranges) {
        if (range.start > pos)
            out.push(text.slice(pos, range.start));
        pos = Math.max(pos, range.end);
    }
    if (pos < text.length)
        out.push(text.slice(pos));
    return out.join('');
}
/** 在纯折叠块分片内按与 `stripDisplayMeta` 同口径保护代码、清理机读/自定义/协议标签并检查残留标签。 */
function validatePlainDetailsChunk(raw) {
    if (!raw.includes('<'))
        return true;
    const code = markdownCodeScanner(raw);
    const ranges = [];
    const metaOpen = new Map();
    let outerCursor = 0;
    const advanceMeta = (target) => {
        const tagRe = /<(\/?)([A-Za-z][\w:-]*)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        while (outerCursor < target) {
            const open = raw.indexOf('<', outerCursor);
            if (open < 0 || open >= target) {
                outerCursor = target;
                break;
            }
            tagRe.lastIndex = open;
            const m = tagRe.exec(raw);
            if (m && m.index === open) {
                const name = m[2].toLowerCase();
                if (DISPLAY_META_NAMES.has(name)) {
                    const closing = m[1] === '/';
                    const slash = !closing && isPlainSelfClosingTag(m[0]);
                    if (!closing && !slash)
                        metaOpen.set(name, (metaOpen.get(name) ?? 0) + 1);
                    else if (closing) {
                        const cur = metaOpen.get(name) ?? 0;
                        if (cur <= 1)
                            metaOpen.delete(name);
                        else
                            metaOpen.set(name, cur - 1);
                    }
                }
                outerCursor = tagRe.lastIndex;
                continue;
            }
            const head = /^<([A-Za-z][\w:-]*)(?=[\t\n\f\r />]|$)/.exec(raw.slice(open, Math.min(raw.length, open + 32)));
            if (head && isDisplayMetaTagName(head[1])) {
                const name = head[1].toLowerCase();
                metaOpen.set(name, (metaOpen.get(name) ?? 0) + 1);
                outerCursor = open + head[0].length;
                continue;
            }
            outerCursor = open + 1;
        }
    };
    const closesMeta = (start, end) => {
        if (metaOpen.size === 0)
            return false;
        const slice = raw.slice(start, end);
        if (!slice.includes('</'))
            return false;
        const innerOpen = new Map();
        const tagRe = /<(\/?)([A-Za-z][\w:-]*)(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        for (let m = tagRe.exec(slice); m; m = tagRe.exec(slice)) {
            const name = m[2].toLowerCase();
            if (!metaOpen.has(name))
                continue;
            const closing = m[1] === '/';
            if (!closing && isPlainSelfClosingTag(m[0]))
                continue;
            if (!closing) {
                innerOpen.set(name, (innerOpen.get(name) ?? 0) + 1);
            }
            else {
                const local = innerOpen.get(name) ?? 0;
                if (local > 0)
                    innerOpen.set(name, local - 1);
                else
                    return true;
            }
        }
        return false;
    };
    if (raw.includes('`') || raw.includes('~~~')) {
        const tokens = /`+|~{3,}/g;
        for (let token = tokens.exec(raw); token; token = tokens.exec(raw)) {
            const at = token.index;
            const fence = code.fence(at);
            if (fence) {
                let end = fence.end;
                while (end > at && (raw[end - 1] === '\n' || raw[end - 1] === '\r'))
                    end--;
                advanceMeta(at);
                if (!closesMeta(at, end)) {
                    ranges.push({ start: at, end });
                    outerCursor = Math.max(outerCursor, fence.end);
                    tokens.lastIndex = Math.max(fence.end, at + 1);
                }
                continue;
            }
            const end = code.inlineEnd(at);
            if (end !== null) {
                advanceMeta(at);
                if (!closesMeta(at, end)) {
                    ranges.push({ start: at, end });
                    outerCursor = Math.max(outerCursor, end);
                    tokens.lastIndex = end;
                }
            }
        }
    }
    let masked = raw;
    let prefix = '';
    const saved = [];
    if (ranges.length > 0) {
        prefix = '\uE000tavernPd';
        while (raw.includes(prefix))
            prefix += 'X';
        let buf = '';
        let c = 0;
        for (const [idx, range] of ranges.entries()) {
            buf += raw.slice(c, range.start) + `${prefix}${idx}\uE001`;
            saved.push(raw.slice(range.start, range.end));
            c = range.end;
        }
        buf += raw.slice(c);
        masked = buf;
    }
    const strippedMeta = stripPlainChunkMeta(masked);
    const stripped = (strippedMeta.includes('{{') ? strippedMeta.replace(ST_COMMENT_MACRO_RE, '') : strippedMeta);
    const cleaned = stripProtocolTags(stripCustomTags(stripped));
    const restored = prefix
        ? cleaned.replace(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\uE001`, 'g'), (_m, idx) => saved[Number(idx)] ?? '')
        : cleaned;
    return !hasResidualTag(restored);
}
/**
 * 共享纯 `<details>` 正文扫描器：`plainDetails` 解析与 `isPlainDetailsStructure` 校验复用同一套
 * 注释剥离、`<br>`/`<hr>` 归一化、嵌套折叠与标签边界检查，杜绝两端口径漂移。
 */
export function scanPlainDetailsBody(body, onMarkdown, onNestedDetails) {
    const chunks = [];
    let chunkStart = 0;
    const flushMarkdown = (endPos) => {
        if (endPos > chunkStart)
            chunks.push(body.slice(chunkStart, endPos));
        chunkStart = endPos;
        if (chunks.length === 0)
            return true;
        const raw = chunks.join('');
        chunks.length = 0;
        return onMarkdown(raw);
    };
    const code = markdownCodeScanner(body);
    const tableLines = findGfmTableLines(body, code);
    const lineStarts = [];
    if (tableLines.size > 0) {
        lineStarts.push(0);
        for (let idx = body.indexOf('\n'); idx >= 0; idx = body.indexOf('\n', idx + 1)) {
            lineStarts.push(idx + 1);
        }
    }
    let lineCursor = 0;
    const isInTableLine = (pos) => {
        if (tableLines.size === 0)
            return false;
        while (lineCursor + 1 < lineStarts.length && lineStarts[lineCursor + 1] <= pos)
            lineCursor++;
        return tableLines.has(lineCursor);
    };
    const tokens = /<|`+|~{3,}/g;
    for (let token = tokens.exec(body); token; token = tokens.exec(body)) {
        const at = token.index;
        if (token[0] !== '<') {
            const end = detailsSafeCodeEnd(body, at, code);
            if (end !== null)
                tokens.lastIndex = end;
            continue;
        }
        if (body.startsWith('<!--', at)) {
            const close = body.indexOf('-->', at + 4);
            if (close < 0)
                return false;
            if (at > chunkStart)
                chunks.push(body.slice(chunkStart, at));
            chunkStart = close + 3;
            tokens.lastIndex = close + 3;
            continue;
        }
        if (body.startsWith('<!', at) || body.startsWith('<?', at))
            return false;
        if (/^<details(?=[\t\n\f\r />])/i.test(body.slice(at, Math.min(body.length, at + 16)))) {
            if (!flushMarkdown(at))
                return false;
            const nestedNext = onNestedDetails(at, code);
            if (nestedNext === null)
                return false;
            chunkStart = nestedNext;
            tokens.lastIndex = nestedNext;
            continue;
        }
        if (BR_CANDIDATE_RE.test(body.slice(at, Math.min(body.length, at + 8)))) {
            BR_PLAIN_RE.lastIndex = at;
            const br = BR_PLAIN_RE.exec(body);
            if (!br)
                return false;
            if (at > chunkStart)
                chunks.push(body.slice(chunkStart, at));
            let endPos = BR_PLAIN_RE.lastIndex;
            let brCount = 1;
            while (endPos < body.length) {
                let ws = endPos;
                while (ws < body.length && (body[ws] === ' ' || body[ws] === '\t'))
                    ws++;
                if (!BR_CANDIDATE_RE.test(body.slice(ws, Math.min(body.length, ws + 8))))
                    break;
                BR_PLAIN_RE.lastIndex = ws;
                const nextBr = BR_PLAIN_RE.exec(body);
                if (!nextBr)
                    break;
                endPos = BR_PLAIN_RE.lastIndex;
                brCount++;
            }
            const trailingBreak = /^[ \t]*(\r?\n)/.exec(body.slice(endPos));
            if (isInTableLine(at)) {
                chunks.push(' ');
            }
            else if (brCount >= 2) {
                const lineStart = body.lastIndexOf('\n', at - 1) + 1;
                const quotePrefix = /^((?: {0,3}>[ \t]?)+)/.exec(body.slice(lineStart, at))?.[1] ?? '';
                if (trailingBreak) {
                    endPos += trailingBreak[0].length;
                    const nextStartsQuote = Boolean(quotePrefix) && body.slice(endPos).startsWith(quotePrefix.trimEnd());
                    chunks.push(quotePrefix ? `\n${quotePrefix.trimEnd()}\n${nextStartsQuote ? '' : quotePrefix}` : '\n\n');
                }
                else {
                    chunks.push(quotePrefix ? `\n${quotePrefix.trimEnd()}\n${quotePrefix}` : '\n\n');
                }
            }
            else if (trailingBreak) {
                // 紧跟原始换行时复用已有换行符，避免 `<br/>\n` 与 `> A<br/>\n> B` 叠成双换行拆断段落或引用块。
                endPos += trailingBreak[0].length - trailingBreak[1].length;
            }
            else {
                chunks.push('\n');
            }
            chunkStart = endPos;
            tokens.lastIndex = endPos;
            continue;
        }
        if (HR_CANDIDATE_RE.test(body.slice(at, Math.min(body.length, at + 8)))) {
            HR_PLAIN_RE.lastIndex = at;
            const hr = HR_PLAIN_RE.exec(body);
            if (!hr)
                return false;
            if (at > chunkStart)
                chunks.push(body.slice(chunkStart, at));
            chunks.push('\n\n---\n\n');
            chunkStart = HR_PLAIN_RE.lastIndex;
            tokens.lastIndex = HR_PLAIN_RE.lastIndex;
            continue;
        }
        AUTOLINK_CANDIDATE_RE.lastIndex = at;
        const autolink = AUTOLINK_CANDIDATE_RE.exec(body);
        if (autolink && isAutolinkToken(autolink[0])) {
            tokens.lastIndex = AUTOLINK_CANDIDATE_RE.lastIndex;
            continue;
        }
        BODY_TAG_RE.lastIndex = at;
        const tag = BODY_TAG_RE.exec(body);
        if (tag) {
            const closing = tag[1] === '/';
            const name = tag[2];
            if (isKnownHtmlElementName(name))
                return false;
            if (!isDisplayMetaTagName(name)) {
                if (CUSTOM_ELEMENT_NAME_RE.test(name))
                    return false;
                const attrs = tag[0].slice(1 + tag[1].length + name.length, tag[0].length - 1);
                if (!closing && attrs.includes('='))
                    return false;
            }
        }
    }
    return flushMarkdown(body.length);
}
/** 定位从 `start` 开始的单个纯 `<details>` 候选块的匹配 `</details>` 结束下标（支持摘要与正文代码安全跳过）。 */
export function findPlainDetailsCloseEnd(text, start, code) {
    DETAILS_OPEN_RE.lastIndex = start;
    if (!DETAILS_OPEN_RE.exec(text))
        return null;
    let bodyStart = skipIgnorableHtml(text, DETAILS_OPEN_RE.lastIndex);
    if (bodyStart === null)
        return null;
    let summaryHasCodeSyntax = false;
    if (SUMMARY_CANDIDATE_RE.test(text.slice(bodyStart, Math.min(text.length, bodyStart + 16)))) {
        SUMMARY_OPEN_RE.lastIndex = bodyStart;
        if (!SUMMARY_OPEN_RE.exec(text))
            return null;
        const parsedSummary = scanPlainSummary(text, SUMMARY_OPEN_RE.lastIndex);
        if (!parsedSummary)
            return null;
        bodyStart = parsedSummary.bodyStart;
        summaryHasCodeSyntax = parsedSummary.hasCodeSyntax;
    }
    let matched;
    if (summaryHasCodeSyntax) {
        const rest = text.slice(bodyStart);
        const restMatched = findMatchingDetailsClose(rest, 0, markdownCodeScanner(rest));
        matched = restMatched
            ? { closeStart: bodyStart + restMatched.closeStart, closeEnd: bodyStart + restMatched.closeEnd }
            : null;
    }
    else {
        matched = findMatchingDetailsClose(text, bodyStart, code);
    }
    return matched ? matched.closeEnd : null;
}
function validatePlainDetailsBody(body, state, depth) {
    return scanPlainDetailsBody(body, validatePlainDetailsChunk, (nestedStart, code) => validatePlainDetailsBlock(body, nestedStart, code, state, depth + 1));
}
function validatePlainDetailsBlock(text, start, code, state, depth) {
    if (depth > MAX_PLAIN_DETAILS_DEPTH)
        return null;
    if (++state.count > MAX_PLAIN_DETAILS_BLOCKS)
        return null;
    DETAILS_OPEN_RE.lastIndex = start;
    if (!DETAILS_OPEN_RE.exec(text))
        return null;
    const openEnd = DETAILS_OPEN_RE.lastIndex;
    let bodyStart = skipIgnorableHtml(text, openEnd);
    if (bodyStart === null)
        return null;
    let summaryHasCodeSyntax = false;
    if (SUMMARY_CANDIDATE_RE.test(text.slice(bodyStart, Math.min(text.length, bodyStart + 16)))) {
        SUMMARY_OPEN_RE.lastIndex = bodyStart;
        if (!SUMMARY_OPEN_RE.exec(text))
            return null;
        const parsedSummary = scanPlainSummary(text, SUMMARY_OPEN_RE.lastIndex);
        if (!parsedSummary)
            return null;
        bodyStart = parsedSummary.bodyStart;
        summaryHasCodeSyntax = parsedSummary.hasCodeSyntax;
    }
    let matched;
    if (summaryHasCodeSyntax) {
        const rest = text.slice(bodyStart);
        const restMatched = findMatchingDetailsClose(rest, 0, markdownCodeScanner(rest));
        matched = restMatched
            ? { closeStart: bodyStart + restMatched.closeStart, closeEnd: bodyStart + restMatched.closeEnd }
            : null;
    }
    else {
        matched = findMatchingDetailsClose(text, bodyStart, code);
    }
    if (!matched)
        return null;
    const body = dedentCommonIndent(text.slice(bodyStart, matched.closeStart));
    return validatePlainDetailsBody(body, state, depth) ? matched.closeEnd : null;
}
/**
 * 供 `htmlFragment` 拆分阶段复用：与 `parsePlainDetailsBlocks` 同口径判定单段 `<details>`
 * 是否可走原生折叠，避免无空行未闭合 `<summary>`、自定义元素或非常见 HTML 标签的邻块
 * 被错误并入纯折叠段而拖进 iframe。
 */
export function isPlainDetailsStructure(html) {
    if (!html || html.length > MAX_PLAIN_DETAILS_CHARS || !html.includes('<'))
        return false;
    const source = unwrapBlockquotedDetails(html);
    const code = markdownCodeScanner(source);
    const state = { count: 0 };
    let cursor = skipIgnorableHtml(source, 0);
    if (cursor === null)
        return false;
    let count = 0;
    while (cursor < source.length) {
        const nextEnd = validatePlainDetailsBlock(source, cursor, code, state, 1);
        if (nextEnd === null)
            return false;
        count++;
        const next = skipIgnorableHtml(source, nextEnd);
        if (next === null)
            return false;
        cursor = next;
    }
    return count > 0;
}
