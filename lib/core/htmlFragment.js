/** 识别没有文档外壳的卡面片段：闭合容器与相邻样式/脚本共用沙箱，保留原字节并跳过代码示例。 */
import { markdownCodeScanner } from './markdownCode.js';
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'table', 'ul', 'ol', 'form', 'fieldset', 'details']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'pre', 'code']);
const INERT_CONTENT = new Set(['noscript']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_TAGS = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
/**
 * 跳过不会在当前脚本环境中成为活动 DOM 的内容区。template 允许合理嵌套；其中的
 * script/style/noscript 字节也不能伪造 template 闭标签。其它既有 RAW_TEXT 仍沿用
 * 浏览器遇到首个同名闭标签即结束的边界。
 */
export function findHtmlOpaqueEnd(text, contentStart, tag) {
    const normalized = tag.toLowerCase();
    if (normalized !== 'template') {
        const close = new RegExp('</' + normalized + '\\s*>', 'gi');
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
            if (end === null)
                return null;
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
export function findHtmlDocument(text) {
    const code = markdownCodeScanner(text);
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
    let start = -1, root = '';
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0], at = token.index;
        if (raw.startsWith('<!--'))
            continue;
        if (raw.startsWith('`') || raw.startsWith('~')) {
            if (start < 0) {
                const end = code.fence(at)?.end ?? code.inlineEnd(at);
                if (end !== null)
                    tokens.lastIndex = end;
            }
            continue;
        }
        const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
        if (start < 0 && /^(?: {4}|\t)/.test(line))
            continue;
        const tag = token[1]?.toLowerCase(), closing = raw.startsWith('</');
        if (start < 0 && (/^<!doctype/i.test(raw) || !closing && (tag === 'html' || tag === 'body'))) {
            start = at;
            root = tag === 'body' ? 'body' : 'html';
        }
        if (tag && !closing && (RAW_TEXT.has(tag) || INERT_CONTENT.has(tag) || tag === 'template')) {
            const end = findHtmlOpaqueEnd(text, tokens.lastIndex, tag);
            if (end === null)
                break;
            tokens.lastIndex = end;
        }
        else if (start >= 0 && closing && tag === root) {
            // 旧卡偶尔只写 body 起点却仍以 html 收尾；把紧跟的外壳闭标签一并保留。
            const tail = root === 'body' ? /^\s*<\/html\s*>/i.exec(text.slice(tokens.lastIndex)) : null;
            return { start, end: tokens.lastIndex + (tail?.[0].length ?? 0) };
        }
        else if (start >= 0 && root === 'html' && closing && tag === 'body' && /^\s*$/.test(text.slice(tokens.lastIndex))) {
            // HTML 的 </html> 可合法省略；只在 </body> 已完整闭合且后面全为空白时接受，
            // 仍拒绝双闭标签都缺失的流式半卡，也不吞掉文档后的普通台词。
            return { start, end: tokens.lastIndex };
        }
    }
    return null;
}
/** 是否包含真实完整文档边界；扫描会跳过注释、Markdown 代码及 script/style 字符串。 */
export function isFullHtmlDocument(text) {
    return findHtmlDocument(text) !== null;
}
export function findHtmlFragment(text) {
    const code = markdownCodeScanner(text);
    // 属性引号内的 > 或 </div> 不参与闭合计数；各分支首字符互斥，避免嵌套回溯。
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|`+|~{3,}/gi;
    let root = '', depth = 0, start = -1, end = -1, inertStart = -1, inertEnd = -1;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        const raw = token[0], at = token.index;
        if (!depth && end >= 0 && text.slice(end, at).trim())
            break;
        if (!depth && end < 0 && inertEnd >= 0 && text.slice(inertEnd, at).trim()) {
            inertStart = -1;
            inertEnd = -1;
        }
        if (raw.startsWith('`') || raw.startsWith('~')) {
            if (!depth) {
                const codeEnd = code.fence(at)?.end ?? code.inlineEnd(at);
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
        if (/^<!doctype/i.test(raw))
            break;
        const tag = token[1].toLowerCase(), closing = raw.startsWith('</');
        const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
        const indented = /^(?: {4}|\t)/.test(line);
        if (!depth && !closing && (tag === 'html' || tag === 'body')) {
            if (indented)
                continue;
            break;
        }
        if (!closing && (RAW_TEXT.has(tag) || INERT_CONTENT.has(tag) || tag === 'template')) {
            const opaqueEnd = findHtmlOpaqueEnd(text, tokens.lastIndex, tag);
            if (opaqueEnd === null)
                break;
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
                    inertStart = inertEnd = -1;
                }
            }
            continue;
        }
        if (!depth) {
            // style/script 已明确开启一个卡面时，把紧邻的普通 HTML 根也留在同一沙箱；否则
            // `<style>p{...}</style><p>...</p>` 会把样式和目标拆到两个渲染器。没有前导卡面时
            // 仍只接受保守容器集合，普通回复里的单个 p/span 不会被自动提升为可执行卡片。
            const followsPrelude = start >= 0 && end >= 0 || inertStart >= 0;
            const adjacentVoid = followsPrelude && VOID_ELEMENTS.has(tag);
            if (closing || (!CONTAINERS.has(tag) && !followsPrelude) || raw.endsWith('/>') && !adjacentVoid) {
                if (end >= 0)
                    break;
                continue;
            }
            if (adjacentVoid) {
                if (start < 0)
                    start = inertStart >= 0 ? inertStart : at;
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
            root = tag;
            depth = 1;
            if (start < 0)
                start = inertStart >= 0 ? inertStart : at;
            inertStart = inertEnd = -1;
        }
        else if (tag === root) {
            if (closing) {
                if (--depth === 0)
                    end = tokens.lastIndex;
            }
            else if (!raw.endsWith('/>'))
                depth++;
        }
    }
    return end < 0 ? null : { start, end };
}
