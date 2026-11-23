/** 识别没有文档外壳的卡面片段：闭合容器与相邻样式/脚本共用沙箱，保留原字节并跳过代码示例。 */
import { markdownCodeScanner } from './markdownCode.js';
import { isPlainDetailsStructure } from './plainDetailsSyntax.js';
export const HTML_CARD_CONTAINERS = new Set([
    'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav',
    'figure', 'table', 'ul', 'ol', 'form', 'fieldset', 'details',
    'audio', 'video', 'svg', 'canvas', 'dialog',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'pre', 'code']);
const INERT_CONTENT = new Set(['noscript']);
/**
 * code/pre 只是代码示例的启发式边界，浏览器里仍是普通元素：正文提到未闭合的 `<code>`
 * 时只忽略这个开标签，不能让后续真实卡面全部失去识别。
 */
export const LENIENT_OPAQUE = new Set(['code', 'pre']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HEAD_PRELUDE_ELEMENTS = new Set(['link', 'meta']);
const PLAIN_DETAILS_OPEN_RE = /^<details(?:\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?\s*>$/i;
const STYLED_HTML_TAG_NAMES = new Set([
    ...HTML_CARD_CONTAINERS,
    'style', 'script', 'template', 'noscript', 'iframe', 'object', 'embed',
    'p', 'span', 'a', 'img', 'button', 'input', 'select', 'textarea', 'label',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'font', 'center',
    'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'mark', 'small', 'sub', 'sup',
    'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'li', 'dl', 'dt', 'dd', 'source', 'track',
]);
const HTML_TAGS = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const HTML_DOCUMENT_CANDIDATE = /<(?:!doctype\s+html|html|body)(?=[\s/>]|$)/i;
const CLOSE_TAG_CACHE = new Map();
const isHtmlSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
/** 按 HTML5 属性状态判定标签是否真正自闭合，防止 `data-url=https://a.test/>` 被误判。 */
function isTagSelfClosing(raw) {
    if (!raw.endsWith('/>'))
        return false;
    const slash = raw.length - 2;
    let i = 1;
    if (raw[i] === '/')
        return false;
    while (i < slash && !isHtmlSpace(raw[i]) && raw[i] !== '/')
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
            if (isHtmlSpace(ch) || ch === '/')
                continue;
            state = 'name';
        }
        else if (state === 'name') {
            if (isHtmlSpace(ch))
                state = 'after-name';
            else if (ch === '=')
                state = 'before-value';
            else if (ch === '/')
                state = 'before-name';
        }
        else if (state === 'after-name') {
            if (isHtmlSpace(ch))
                continue;
            if (ch === '=')
                state = 'before-value';
            else if (ch === '/')
                state = 'before-name';
            else
                state = 'name';
        }
        else if (state === 'before-value') {
            if (isHtmlSpace(ch))
                continue;
            if (ch === '"' || ch === "'") {
                quote = ch;
                state = 'quoted';
            }
            else
                state = 'unquoted';
        }
        else if (state === 'unquoted') {
            if (isHtmlSpace(ch))
                state = 'before-name';
        }
        else if (state === 'after-value') {
            if (isHtmlSpace(ch) || ch === '/')
                state = 'before-name';
            else
                state = 'name';
        }
    }
    return state === 'before-name' || state === 'name' || state === 'after-name' || state === 'after-value';
}
/**
 * 判定 `<center>` 是否包裹 HTML 卡面：
 * 带属性的 `<center style=...>` 或内含 HTML 容器/样式元素时交给沙箱 iframe；
 * 无属性且仅包纯 Markdown（如 `<center>### 标题</center>`）则留给宿主 Markdown 归一化。
 */
function isHtmlCardCenter(text, openEnd, rawOpen) {
    const selfClosing = isTagSelfClosing(rawOpen);
    if (selfClosing)
        return false;
    const innerAttrs = rawOpen.slice('<center'.length, rawOpen.length - 1).trim();
    const tokens = new RegExp(HTML_TAGS.source, HTML_TAGS.flags);
    tokens.lastIndex = openEnd;
    let depth = 1;
    let hasHtmlCardContent = innerAttrs.length > 0;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0];
        if (raw.startsWith('<!--'))
            continue;
        const nested = token[1]?.toLowerCase();
        const closing = raw.startsWith('</');
        if (!nested)
            continue;
        if (!closing && (RAW_TEXT.has(nested) || INERT_CONTENT.has(nested) || nested === 'template')) {
            if (nested === 'style' || nested === 'script')
                hasHtmlCardContent = true;
            const end = findHtmlOpaqueEnd(text, tokens.lastIndex, nested);
            if (end === null) {
                if (LENIENT_OPAQUE.has(nested))
                    continue;
                return false;
            }
            tokens.lastIndex = end;
            continue;
        }
        if (nested === 'center') {
            if (closing) {
                if (--depth === 0)
                    return hasHtmlCardContent;
            }
            else if (!isTagSelfClosing(raw)) {
                if (raw.slice('<center'.length, raw.length - 1).trim().length > 0)
                    hasHtmlCardContent = true;
                depth++;
            }
            continue;
        }
        if (!closing && !hasHtmlCardContent) {
            if (HTML_CARD_CONTAINERS.has(nested) || nested === 'iframe' || nested === 'object' || nested === 'embed') {
                hasHtmlCardContent = true;
            }
            else if (STYLED_HTML_TAG_NAMES.has(nested)) {
                const attrSlice = raw.slice(1 + nested.length, raw.length - (isTagSelfClosing(raw) ? 2 : 1)).trim();
                // 带布局/样式属性的子元素（如 `<img width="200">`/`<h2 style=...>`）保留给 iframe 还原排版。
                if (nested === 'img') {
                    if (/\b(?:width|height|style|class|align|border|hspace|vspace)\s*=/i.test(attrSlice))
                        hasHtmlCardContent = true;
                }
                else if (attrSlice.length > 0) {
                    hasHtmlCardContent = true;
                }
            }
        }
    }
    return false;
}
/** 前瞻单块 `<details>` 边界，并与 `plainDetails` 同口径校验是否可安全走原生折叠。 */
function isPlainDetailsCandidate(text, openStart, openEnd, rawOpen) {
    if (!PLAIN_DETAILS_OPEN_RE.test(rawOpen))
        return false;
    const tokens = new RegExp(HTML_TAGS.source, HTML_TAGS.flags);
    tokens.lastIndex = openEnd;
    let depth = 1;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0];
        if (raw.startsWith('<!--')) {
            if (!raw.endsWith('-->'))
                return false;
            continue;
        }
        const nested = token[1]?.toLowerCase();
        const closing = raw.startsWith('</');
        if (!nested)
            continue;
        if (!closing && (RAW_TEXT.has(nested) || INERT_CONTENT.has(nested) || nested === 'template')) {
            const opaqueEnd = findHtmlOpaqueEnd(text, tokens.lastIndex, nested);
            if (opaqueEnd === null) {
                if (LENIENT_OPAQUE.has(nested))
                    continue;
                return false;
            }
            tokens.lastIndex = opaqueEnd;
            continue;
        }
        if (nested === 'details') {
            if (closing) {
                if (--depth === 0) {
                    const closeEnd = tokens.lastIndex;
                    // 若紧跟（可跨 HTML 注释）<style>/<script>，仍留在同一 HTML 片段里共享样式与脚本。
                    const tail = text.slice(closeEnd).replace(/^(?:\s|<!--[\s\S]*?-->)*/, '');
                    if (/^<(?:style|script)(?=[\s/>])/i.test(tail))
                        return false;
                    return isPlainDetailsStructure(text.slice(openStart, closeEnd));
                }
            }
            else if (!isTagSelfClosing(raw)) {
                depth++;
            }
        }
    }
    return false;
}
function closeTagPattern(normalized) {
    let cached = CLOSE_TAG_CACHE.get(normalized);
    if (!cached) {
        cached = new RegExp('</' + normalized + '\\s*>', 'gi');
        if (CLOSE_TAG_CACHE.size < 64)
            CLOSE_TAG_CACHE.set(normalized, cached);
    }
    return cached;
}
function hasCodeIndent(line) {
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
/**
 * 跳过不会在当前脚本环境中成为活动 DOM 的内容区。template 允许合理嵌套；其中的
 * script/style/noscript 字节也不能伪造 template 闭标签。其它既有 RAW_TEXT 仍沿用
 * 浏览器遇到首个同名闭标签即结束的边界。
 */
export function findHtmlOpaqueEnd(text, contentStart, tag) {
    const normalized = tag.toLowerCase();
    if (normalized !== 'template') {
        const close = closeTagPattern(normalized);
        close.lastIndex = contentStart;
        const found = close.exec(text);
        return found ? close.lastIndex : null;
    }
    const tokens = new RegExp(HTML_TAGS.source, HTML_TAGS.flags);
    tokens.lastIndex = contentStart;
    let depth = 1;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0];
        if (raw.startsWith('<!--'))
            continue;
        const nested = token[1]?.toLowerCase(), closing = raw.startsWith('</');
        if (!nested)
            continue;
        if (!closing && (RAW_TEXT.has(nested) || INERT_CONTENT.has(nested))) {
            const end = findHtmlOpaqueEnd(text, tokens.lastIndex, nested);
            if (end === null) {
                if (LENIENT_OPAQUE.has(nested))
                    continue;
                return null;
            }
            tokens.lastIndex = end;
            continue;
        }
        if (nested !== 'template')
            continue;
        if (closing) {
            if (--depth === 0)
                return tokens.lastIndex;
        }
        else
            depth++;
    }
    return null;
}
/** 完整文档也按标签扫描；注释、代码示例与 script/style 字符串不参与文档边界判断。 */
export function findHtmlDocument(text, code, maxStart = Number.POSITIVE_INFINITY) {
    if (maxStart < 0 || !text.includes('<') || !HTML_DOCUMENT_CANDIDATE.test(text))
        return null;
    const scanner = code ?? markdownCodeScanner(text);
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
    let start = -1, root = '', sawHtml = false;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0], at = token.index;
        if (start < 0 && at > maxStart)
            return null;
        if (raw.startsWith('<!--'))
            continue;
        if (raw.startsWith('`') || raw.startsWith('~')) {
            if (start < 0) {
                const end = scanner.fence(at)?.end ?? scanner.inlineEnd(at);
                if (end !== null)
                    tokens.lastIndex = end;
            }
            continue;
        }
        const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
        if (start < 0 && hasCodeIndent(line))
            continue;
        const tag = token[1]?.toLowerCase(), closing = raw.startsWith('</');
        if (start < 0 && (/^<!doctype/i.test(raw) || !closing && (tag === 'html' || tag === 'body'))) {
            start = at;
            root = tag === 'body' ? 'body' : 'html';
            if (tag === 'html')
                sawHtml = true;
        }
        else if (start >= 0 && !closing && tag === 'html') {
            sawHtml = true;
        }
        if (tag && !closing && (RAW_TEXT.has(tag) || INERT_CONTENT.has(tag) || tag === 'template')) {
            const end = findHtmlOpaqueEnd(text, tokens.lastIndex, tag);
            if (end === null) {
                if (LENIENT_OPAQUE.has(tag))
                    continue;
                break;
            }
            tokens.lastIndex = end;
        }
        else if (start >= 0 && closing && tag === root) {
            // 旧卡偶尔只写 body 起点却仍以 html 收尾；把紧跟的外壳闭标签一并保留。
            const tail = root === 'body' ? /^\s*<\/html\s*>/i.exec(text.slice(tokens.lastIndex)) : null;
            return { start, end: tokens.lastIndex + (tail?.[0].length ?? 0) };
        }
        else if (start >= 0 && root === 'html' && closing && tag === 'body') {
            if (!sawHtml) {
                // <!DOCTYPE html> 后直接写 <head>/<body> 而省略 <html> 时，</body> 即构成完整文档边界。
                const tail = /^\s*<\/html\s*>/i.exec(text.slice(tokens.lastIndex));
                return { start, end: tokens.lastIndex + (tail?.[0].length ?? 0) };
            }
            if (/^\s*$/.test(text.slice(tokens.lastIndex))) {
                // HTML 的 </html> 可合法省略；只在 </body> 已完整闭合且后面全为空白时接受，
                // 仍拒绝双闭标签都缺失的流式半卡，也不吞掉文档后的普通台词。
                return { start, end: tokens.lastIndex };
            }
        }
    }
    return null;
}
/** 是否包含真实完整文档边界；扫描会跳过注释、Markdown 代码及 script/style 字符串。 */
export function isFullHtmlDocument(text) {
    return findHtmlDocument(text) !== null;
}
export function findHtmlFragment(text, code, maxStart = Number.POSITIVE_INFINITY) {
    if (maxStart < 0 || !text.includes('<'))
        return null;
    const scanner = code ?? markdownCodeScanner(text);
    // 属性引号内的 > 或 </div> 不参与闭合计数；各分支首字符互斥，避免嵌套回溯。
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
    let root = '', depth = 0, start = -1, end = -1, inertStart = -1, inertEnd = -1;
    let hasPrelude = false, onlyPlainDetails = false;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0], at = token.index;
        if (!depth && end >= 0 && text.slice(end, at).trim())
            break;
        if (!depth && end < 0 && inertEnd >= 0 && text.slice(inertEnd, at).trim()) {
            inertStart = -1;
            inertEnd = -1;
        }
        if (!depth && start < 0 && inertStart < 0 && at > maxStart)
            return null;
        if (raw.startsWith('`') || raw.startsWith('~')) {
            if (!depth) {
                const codeEnd = scanner.fence(at)?.end ?? scanner.inlineEnd(at);
                if (codeEnd !== null)
                    tokens.lastIndex = codeEnd;
            }
            continue;
        }
        if (raw.startsWith('<!--')) {
            if (!depth && end >= 0)
                end = tokens.lastIndex;
            else if (!depth && inertEnd >= 0)
                inertEnd = tokens.lastIndex;
            continue;
        }
        if (/^<!doctype/i.test(raw)) {
            if (depth || end >= 0)
                break;
            const doctypeLine = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
            if (hasCodeIndent(doctypeLine))
                continue;
            // 紧跟 html/body/head 属于完整文档外壳，留给 findHtmlDocument 处理；
            // 仅写 <!DOCTYPE html> 后直接跟 <style>/<div> 的片段卡则作为前导并入当前卡面。
            const afterDoctype = text.slice(tokens.lastIndex).replace(/^(?:\s|<!--[\s\S]*?-->)*/, '');
            if (/^<(?:html|body|head)(?=[\s/>])/i.test(afterDoctype))
                break;
            if (inertStart < 0)
                inertStart = at;
            inertEnd = tokens.lastIndex;
            continue;
        }
        const tag = token[1].toLowerCase(), closing = raw.startsWith('</');
        const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
        const indented = hasCodeIndent(line);
        if (!depth && !closing && (tag === 'html' || tag === 'body')) {
            if (indented)
                continue;
            break;
        }
        if (!closing && (RAW_TEXT.has(tag) || INERT_CONTENT.has(tag) || tag === 'template')) {
            const opaqueEnd = findHtmlOpaqueEnd(text, tokens.lastIndex, tag);
            if (opaqueEnd === null) {
                if (LENIENT_OPAQUE.has(tag))
                    continue;
                break;
            }
            tokens.lastIndex = opaqueEnd;
            if (!depth) {
                if (tag === 'template' || INERT_CONTENT.has(tag)) {
                    if (inertStart < 0)
                        inertStart = at;
                    inertEnd = tokens.lastIndex;
                    continue;
                }
                if ((tag !== 'style' && tag !== 'script') || indented) {
                    if (end >= 0)
                        break;
                }
                else {
                    if (start < 0)
                        start = inertStart >= 0 ? inertStart : at;
                    end = tokens.lastIndex;
                    hasPrelude = true;
                    onlyPlainDetails = false;
                    inertStart = inertEnd = -1;
                }
            }
            continue;
        }
        if (!depth) {
            // 紧邻卡面的前导 <link>/<meta>（如 Google Fonts 样式表）纳入该卡面沙箱；
            // 独立出现在纯文本中且无后续卡面时会自动丢弃。
            if (!closing && !indented && HEAD_PRELUDE_ELEMENTS.has(tag)) {
                if (end >= 0 && onlyPlainDetails)
                    break;
                if (start < 0 && end < 0) {
                    if (inertStart < 0)
                        inertStart = at;
                    inertEnd = tokens.lastIndex;
                    continue;
                }
            }
            // style/script 已明确开启一个卡面时，把紧邻的普通 HTML 根也留在同一沙箱；否则
            // `<style>p{...}</style><p>...</p>` 会把样式和目标拆到两个渲染器。没有前导卡面时
            // 仍只接受保守容器集合，普通回复里的单个 p/span 不会被自动提升为可执行卡片。
            const followsPrelude = start >= 0 && end >= 0 || inertStart >= 0;
            const adjacentVoid = followsPrelude && VOID_ELEMENTS.has(tag);
            const selfClosing = isTagSelfClosing(raw);
            const isCardContainer = HTML_CARD_CONTAINERS.has(tag)
                || (tag === 'center' && !closing && !indented && isHtmlCardCenter(text, tokens.lastIndex, raw));
            if (closing || (!isCardContainer && !followsPrelude) || selfClosing && !adjacentVoid) {
                if (end >= 0)
                    break;
                continue;
            }
            if (adjacentVoid) {
                if (end >= 0 && onlyPlainDetails)
                    break;
                if (start < 0) {
                    start = inertStart >= 0 ? inertStart : at;
                    if (inertStart >= 0)
                        hasPrelude = true;
                }
                end = tokens.lastIndex;
                inertStart = inertEnd = -1;
                continue;
            }
            // 四空格/制表符缩进的顶层标签属于 Markdown 代码；容器内部缩进不受影响。
            if (indented) {
                if (end >= 0)
                    break;
                continue;
            }
            // 独立的纯文本/Markdown <details> 与相邻非 <details> 卡片拆分，避免把原生折叠块拽进 iframe。
            if (end >= 0) {
                if (onlyPlainDetails) {
                    if (tag !== 'details' || !isPlainDetailsCandidate(text, at, tokens.lastIndex, raw))
                        break;
                }
                else if (!hasPrelude && tag === 'details' && isPlainDetailsCandidate(text, at, tokens.lastIndex, raw)) {
                    break;
                }
            }
            else {
                onlyPlainDetails = inertStart < 0 && !hasPrelude && tag === 'details'
                    && isPlainDetailsCandidate(text, at, tokens.lastIndex, raw);
            }
            root = tag;
            depth = 1;
            if (start < 0) {
                if (inertStart >= 0) {
                    start = inertStart;
                    hasPrelude = true;
                }
                else
                    start = at;
            }
            inertStart = inertEnd = -1;
        }
        else if (tag === root) {
            if (closing) {
                if (--depth === 0)
                    end = tokens.lastIndex;
            }
            else if (!isTagSelfClosing(raw))
                depth++;
        }
    }
    return end < 0 ? null : { start, end };
}
