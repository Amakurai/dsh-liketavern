/**
 * 纯文本/Markdown `<details>` 折叠块识别与解析：
 * 无脚本、无样式、无内嵌 HTML 元素（仅允许嵌套纯 `<details>` 与 `<br>`）的折叠块
 * 由客户端原生 `<details>` + `MarkdownText` 渲染，避免拆进白色/突兀的沙箱 `<iframe>`。
 * 只要结构或标签存在任何越界或疑似 HTML/脚本片段，立即返回 `null` 回退原有 `<iframe>` 隔离沙箱。
 */
import { isDisplayMetaTagName, isKnownHtmlElementName, stripDisplayMeta } from './displaySanitize.js';
import { markdownCodeScanner } from './markdownCode.js';
const MAX_PLAIN_DETAILS_CHARS = 256 * 1024;
const MAX_PLAIN_DETAILS_DEPTH = 8;
const MAX_PLAIN_DETAILS_BLOCKS = 64;
const DETAILS_OPEN_RE = /<details(?:\s+(open(?:\s*=\s*(?:""|''|"open"|'open'|open))?))?\s*>/iy;
const DETAILS_CLOSE_RE = /^<\/details\s*>/i;
const DETAILS_TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
const SUMMARY_CANDIDATE_RE = /^<summary(?=[\t\n\f\r />])/i;
const SUMMARY_OPEN_RE = /<summary\s*>/iy;
const SUMMARY_CLOSE_RE = /<\/summary\s*>/i;
const SUMMARY_HTML_TAG_RE = /<[!?/A-Za-z]/;
const BR_CANDIDATE_RE = /^<br(?=[\t\n\f\r />])/i;
const BR_PLAIN_RE = /<br\s*\/?>/iy;
const AUTOLINK_CANDIDATE_RE = /<[^\s<>]+>/y;
const BODY_TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)(?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/y;
const CUSTOM_ELEMENT_NAME_RE = /^[a-z][\w.]*-[\w.-]*$/;
const RESIDUAL_TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*)?>/y;
const DETAILS_BOUNDARY_RE = /<!--[\s\S]*?(?:-->|$)|<\/?details(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
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
};
function decodeSummaryEntities(text) {
    if (!text.includes('&'))
        return text;
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (raw, dec, hex, named) => {
        if (named !== undefined) {
            return SUMMARY_NAMED_ENTITIES[named.toLowerCase()] ?? raw;
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
function skipIgnorableHtml(text, start) {
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
function dedentCommonIndent(text) {
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
function isAutolinkToken(token) {
    if (EMAIL_AUTOLINK_RE.test(token))
        return true;
    if (!/\s/.test(token)) {
        const uri = URI_AUTOLINK_RE.exec(token);
        if (uri && (token.includes('://') || AUTOLINK_SCHEMES.has(uri[1].toLowerCase())))
            return true;
    }
    return false;
}
function hasResidualTag(text) {
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
        if (tag && !isAutolinkToken(tag[0]))
            return true;
    }
    return false;
}
/**
 * 代码区间仅在不跨越未配对 `<details>`/`</details>` HTML 边界且围栏已闭合时才允许跳过，
 * 防止反引号或未闭合围栏跨过 `</details>` 将相邻 `<script>` 或第二个折叠块吞入同一代码块。
 */
function detailsSafeCodeEnd(text, at, code) {
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
function findMatchingDetailsClose(text, start, code) {
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
function parseDetailsBody(body, state, depth) {
    const children = [];
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
        const cleaned = stripDisplayMeta(raw);
        if (!cleaned)
            return true;
        if (hasResidualTag(cleaned))
            return false;
        children.push({ kind: 'markdown', text: cleaned });
        return true;
    };
    const code = markdownCodeScanner(body);
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
                return null;
            if (at > chunkStart)
                chunks.push(body.slice(chunkStart, at));
            chunkStart = close + 3;
            tokens.lastIndex = close + 3;
            continue;
        }
        if (body.startsWith('<!', at) || body.startsWith('<?', at))
            return null;
        if (/^<details(?=[\t\n\f\r />])/i.test(body.slice(at, Math.min(body.length, at + 16)))) {
            if (!flushMarkdown(at))
                return null;
            const nested = parseDetailsBlock(body, at, code, state, depth + 1);
            if (!nested)
                return null;
            children.push({ kind: 'details', block: nested.block });
            chunkStart = nested.nextIndex;
            tokens.lastIndex = nested.nextIndex;
            continue;
        }
        if (BR_CANDIDATE_RE.test(body.slice(at, Math.min(body.length, at + 8)))) {
            BR_PLAIN_RE.lastIndex = at;
            const br = BR_PLAIN_RE.exec(body);
            if (!br)
                return null;
            if (at > chunkStart)
                chunks.push(body.slice(chunkStart, at));
            chunks.push('\n');
            chunkStart = BR_PLAIN_RE.lastIndex;
            tokens.lastIndex = BR_PLAIN_RE.lastIndex;
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
                return null;
            if (!isDisplayMetaTagName(name)) {
                if (CUSTOM_ELEMENT_NAME_RE.test(name))
                    return null;
                const attrs = tag[0].slice(1 + tag[1].length + name.length, tag[0].length - 1);
                if (!closing && attrs.includes('='))
                    return null;
            }
        }
    }
    if (!flushMarkdown(body.length))
        return null;
    return children;
}
function parseDetailsBlock(text, start, code, state, depth) {
    if (depth > MAX_PLAIN_DETAILS_DEPTH)
        return null;
    if (++state.count > MAX_PLAIN_DETAILS_BLOCKS)
        return null;
    DETAILS_OPEN_RE.lastIndex = start;
    const openMatch = DETAILS_OPEN_RE.exec(text);
    if (!openMatch)
        return null;
    const open = Boolean(openMatch[1]);
    const openEnd = DETAILS_OPEN_RE.lastIndex;
    let bodyStart = skipIgnorableHtml(text, openEnd);
    if (bodyStart === null)
        return null;
    let summary = null;
    let summaryHasCodeSyntax = false;
    if (SUMMARY_CANDIDATE_RE.test(text.slice(bodyStart, Math.min(text.length, bodyStart + 16)))) {
        SUMMARY_OPEN_RE.lastIndex = bodyStart;
        const summaryOpen = SUMMARY_OPEN_RE.exec(text);
        if (!summaryOpen)
            return null;
        const summaryStart = SUMMARY_OPEN_RE.lastIndex;
        const closeRe = new RegExp(SUMMARY_CLOSE_RE.source, 'gi');
        closeRe.lastIndex = summaryStart;
        const closeMatch = closeRe.exec(text);
        if (!closeMatch)
            return null;
        const rawSummary = text.slice(summaryStart, closeMatch.index);
        if (SUMMARY_HTML_TAG_RE.test(rawSummary))
            return null;
        summary = decodeSummaryEntities(rawSummary).trim();
        summaryHasCodeSyntax = rawSummary.includes('`') || rawSummary.includes('~~~');
        bodyStart = closeRe.lastIndex;
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
    const children = parseDetailsBody(body, state, depth);
    if (!children)
        return null;
    return {
        block: { open, summary, children },
        nextIndex: matched.closeEnd,
    };
}
/**
 * 解析由一个或多个纯文本/Markdown `<details>` 组成的 HTML 片段。
 * 只要出现任意属性（除 `open`）、样式、脚本或非允许的 HTML 元素即返回 `null`。
 */
export function parsePlainDetailsBlocks(html) {
    if (!html || html.length > MAX_PLAIN_DETAILS_CHARS || !html.includes('<'))
        return null;
    const code = markdownCodeScanner(html);
    const state = { count: 0 };
    const blocks = [];
    let cursor = skipIgnorableHtml(html, 0);
    if (cursor === null)
        return null;
    while (cursor < html.length) {
        const parsed = parseDetailsBlock(html, cursor, code, state, 1);
        if (!parsed)
            return null;
        blocks.push(parsed.block);
        const next = skipIgnorableHtml(html, parsed.nextIndex);
        if (next === null)
            return null;
        cursor = next;
    }
    return blocks.length > 0 ? blocks : null;
}
/** 快速判定 HTML 片段是否可完全交由原生折叠组件安全渲染。 */
export function isPlainDetailsHtml(html) {
    return parsePlainDetailsBlocks(html) !== null;
}
/** 将已解析的纯折叠块展开为可读纯文本，供只含折叠块的气泡复制正文。 */
export function formatPlainDetailsText(blocks) {
    const parts = [];
    for (const block of blocks) {
        const lines = [];
        const summary = block.summary?.trim();
        if (summary)
            lines.push(summary);
        for (const child of block.children) {
            const piece = child.kind === 'markdown' ? child.text.trim() : formatPlainDetailsText([child.block]);
            if (piece)
                lines.push(piece);
        }
        if (lines.length > 0)
            parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
}
