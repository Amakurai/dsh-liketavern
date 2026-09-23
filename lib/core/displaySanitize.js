/**
 * 展示层收起模型输出的机读标签与未闭合的 HTML 小部件。不改会话存储，不进入 prompt。
 *
 * 社区预设常让模型在正文末尾写 UpdateVariable，或贴一段日志小部件 HTML。
 * 预设若没带展示正则，Markdown 会把这些当正文渲染。封面整页 HTML 原样留给 iframe；
 * 小部件 HTML 后面若还有正文，拆开后只对正文做收起。
 */
import { collectRenderedHtml, locateRenderedHtml } from './regex.js';
export const DISPLAY_META_TAGS = [
    'UpdateVariable',
    'JSONPatch',
    'Analysis',
    'think',
    'thinking',
    'StatusPlaceHolderImpl',
];
const DISPLAY_META_NAMES = new Set(DISPLAY_META_TAGS.map(tag => tag.toLowerCase()));
/** 真正 raw-text 的脚本可含标签字面量；style 能通过 CSS content 直接展示属性或字符串，不能豁免。 */
const OPAQUE_HTML_TAGS = new Set(['script']);
/** 这些容器把内层标签当可见文本；其中的 script/style 不能反过来开启不可见 raw-text 状态。 */
const VISIBLE_TEXT_TAGS = new Set(['textarea', 'title', 'xmp', 'plaintext', 'style', 'select', 'option', 'math', 'svg']);
const TAG_HEAD_RE = /<(\/?)([A-Za-z][\w:-]*)/y;
const isHtmlSpace = (char) => char === '\t' || char === '\n' || char === '\f' || char === '\r' || char === ' ';
function tagHead(text, start, limit = text.length) {
    TAG_HEAD_RE.lastIndex = start;
    const parsed = TAG_HEAD_RE.exec(text);
    const end = TAG_HEAD_RE.lastIndex;
    if (!parsed?.[2] || end > limit || end < limit && !/[\t\n\f\r />]/.test(text[end]))
        return null;
    return { closing: parsed[1] === '/', name: parsed[2].toLowerCase(), end };
}
/** 畸形且未闭合的普通标签后仍可能出现机读块；只扫描一次并按隐私优先隐藏至文末。 */
function firstDisplayMetaOpen(text, start, limit = text.length) {
    let cursor = start;
    while (cursor < limit) {
        const open = text.indexOf('<', cursor);
        if (open < 0 || open >= limit)
            return -1;
        const head = tagHead(text, open, limit);
        if (head && !head.closing && DISPLAY_META_NAMES.has(head.name))
            return open;
        cursor = open + 1;
    }
    return -1;
}
/** 找到 HTML 标签的 `>`；属性引号里的大于号不结束标签。 */
function htmlTagEnd(text, start, limit = text.length) {
    const head = tagHead(text, start, limit);
    if (!head)
        return -2;
    let state = 'before-name';
    let quote = null;
    for (let i = head.end; i < limit; i++) {
        const char = text[i];
        if (state === 'quoted') {
            if (char === quote) {
                quote = null;
                state = 'after-value';
            }
            continue;
        }
        if (char === '>')
            return i + 1;
        if (state === 'before-name') {
            if (isHtmlSpace(char) || char === '/')
                continue;
            state = 'name';
            continue;
        }
        if (state === 'name') {
            if (isHtmlSpace(char))
                state = 'after-name';
            else if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
            continue;
        }
        if (state === 'after-name') {
            if (isHtmlSpace(char))
                continue;
            if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
            else
                state = 'name';
            continue;
        }
        if (state === 'before-value') {
            if (isHtmlSpace(char))
                continue;
            if (char === '"' || char === "'") {
                quote = char;
                state = 'quoted';
            }
            else
                state = 'unquoted';
            continue;
        }
        if (state === 'unquoted') {
            if (isHtmlSpace(char))
                state = 'before-name';
            continue;
        }
        if (state === 'after-value') {
            if (isHtmlSpace(char) || char === '/')
                state = 'before-name';
            else
                state = 'name';
        }
    }
    return -1;
}
/** `/` 只有在属性名边界或引号值之后紧邻 `>` 时才设置 HTML self-closing flag。 */
function isHtmlSelfClosingTag(text, headEnd, tokenEnd) {
    const slash = tokenEnd - 2;
    if (slash < headEnd || text[slash] !== '/')
        return false;
    let state = 'before-name';
    let quote = null;
    for (let i = headEnd; i < slash; i++) {
        const char = text[i];
        if (state === 'quoted') {
            if (char === quote) {
                quote = null;
                state = 'after-value';
            }
            continue;
        }
        if (state === 'before-name') {
            if (isHtmlSpace(char) || char === '/')
                continue;
            state = 'name';
        }
        else if (state === 'name') {
            if (isHtmlSpace(char))
                state = 'after-name';
            else if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
        }
        else if (state === 'after-name') {
            if (isHtmlSpace(char))
                continue;
            if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
            else
                state = 'name';
        }
        else if (state === 'before-value') {
            if (isHtmlSpace(char))
                continue;
            if (char === '"' || char === "'") {
                quote = char;
                state = 'quoted';
            }
            else
                state = 'unquoted';
        }
        else if (state === 'unquoted') {
            if (isHtmlSpace(char))
                state = 'before-name';
        }
        else if (state === 'after-value') {
            if (isHtmlSpace(char) || char === '/')
                state = 'before-name';
            else
                state = 'name';
        }
    }
    return state === 'before-name' || state === 'name' || state === 'after-name' || state === 'after-value';
}
/** 在当前片段内找 raw/代码元素自身闭标签；不会跨进下一个独立 iframe/Markdown part。 */
function opaqueCloseToken(text, name, start, limit) {
    let cursor = start;
    while (cursor < limit) {
        const open = text.indexOf('<', cursor);
        if (open < 0 || open >= limit)
            return null;
        const head = tagHead(text, open, limit);
        if (head?.closing && head.name === name) {
            const end = htmlTagEnd(text, open, limit);
            if (end > 0)
                return { start: open, end };
            if (end < 0)
                return null;
        }
        cursor = open + 1;
    }
    return null;
}
/** select/option/MathML 使用普通标签 tokenizer；属性引号里的伪 closing token 不能提前结束容器。 */
function structuredCloseToken(text, name, start, limit, nested = false) {
    let cursor = start;
    let depth = 1;
    while (cursor < limit) {
        const open = text.indexOf('<', cursor);
        if (open < 0 || open >= limit)
            return null;
        if ((name === 'math' || name === 'svg') && text.startsWith('<![CDATA[', open)) {
            const close = text.indexOf(']]>', open + '<![CDATA['.length);
            if (close < 0 || close >= limit)
                return null;
            cursor = close + 3;
            continue;
        }
        if (text.startsWith('<!--', open)) {
            const end = htmlCommentEnd(text, open, limit);
            if (end < 0)
                return null;
            cursor = end;
            continue;
        }
        const head = tagHead(text, open, limit);
        if (!head) {
            if (text.startsWith('<?', open) || text.startsWith('<!', open) || text.startsWith('</', open)) {
                const close = text.indexOf('>', open + 2);
                if (close < 0 || close >= limit)
                    return null;
                cursor = close + 1;
            }
            else
                cursor = open + 1;
            continue;
        }
        const end = htmlTagEnd(text, open, limit);
        if (end < 0)
            return null;
        if (head.name === name) {
            if (head.closing) {
                depth--;
                if (depth === 0)
                    return { start: open, end };
            }
            else if (nested && !isHtmlSelfClosingTag(text, head.end, end))
                depth++;
        }
        if (name !== 'math' && name !== 'svg' && !head.closing && head.name === 'script') {
            const scriptClose = opaqueCloseToken(text, 'script', end, limit);
            if (!scriptClose)
                return null;
            cursor = scriptClose.end;
            continue;
        }
        cursor = end;
    }
    return null;
}
/** DOCTYPE 的 PUBLIC/SYSTEM 标识允许引号内出现 `>`。 */
function doctypeEnd(text, start, limit) {
    let quote = null;
    for (let index = start; index < limit; index++) {
        const char = text[index];
        if (quote) {
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'")
            quote = char;
        else if (char === '>')
            return index + 1;
    }
    return -1;
}
/** HTML 注释的正常闭合；若浏览器会更早 abrupt-close，则返回 -1 让调用方保守隐藏本段余下内容。 */
function htmlCommentEnd(text, open, limit) {
    const content = open + 4;
    if (content < limit && (text[content] === '>' || text.startsWith('->', content)))
        return -1;
    for (let i = content; i < limit; i++) {
        if (text[i] !== '-' || text[i + 1] !== '-')
            continue;
        if (text[i + 2] === '>')
            return i + 3 <= limit ? i + 3 : -1;
        if (text[i + 2] === '!' && text[i + 3] === '>')
            return -1;
    }
    return -1;
}
/** 按 HTML tokenizer 的属性状态收集值区间；引号只有在等号后的 value 状态才有语义。 */
function attributeValueRanges(text, start, limit) {
    const ranges = [];
    let state = 'before-name';
    let quote = null;
    let valueStart = -1;
    let valueQuoted = false;
    const finish = (end) => {
        if (valueStart >= 0)
            ranges.push({ start: valueStart, end, quoted: valueQuoted });
        valueStart = -1;
        valueQuoted = false;
    };
    for (let i = start; i < limit; i++) {
        const char = text[i];
        if (state === 'quoted') {
            if (char === quote) {
                finish(i);
                quote = null;
                state = 'after-value';
            }
            continue;
        }
        if (state === 'before-name') {
            if (isHtmlSpace(char) || char === '/')
                continue;
            state = 'name';
            continue;
        }
        if (state === 'name') {
            if (isHtmlSpace(char))
                state = 'after-name';
            else if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
            continue;
        }
        if (state === 'after-name') {
            if (isHtmlSpace(char))
                continue;
            if (char === '=')
                state = 'before-value';
            else if (char === '/')
                state = 'before-name';
            else
                state = 'name';
            continue;
        }
        if (state === 'before-value') {
            if (isHtmlSpace(char))
                continue;
            if (char === '"' || char === "'") {
                quote = char;
                valueStart = i + 1;
                valueQuoted = true;
                state = 'quoted';
            }
            else {
                valueStart = i;
                valueQuoted = false;
                state = 'unquoted';
            }
            continue;
        }
        if (state === 'unquoted') {
            if (isHtmlSpace(char)) {
                finish(i);
                state = 'before-name';
            }
            continue;
        }
        if (state === 'after-value') {
            if (isHtmlSpace(char) || char === '/')
                state = 'before-name';
            else
                state = 'name';
        }
    }
    if (state === 'quoted' || state === 'unquoted')
        finish(limit);
    return ranges;
}
const META_REFERENCE_CANDIDATE_RE = /&(?:amp;|lt;?|#0*(?:38|60);?|#x0*(?:26|3c);?|num;|semi;|tab;|newline;|sol;)/i;
function needsReferenceDecode(value) {
    return value.includes('&') && (value.includes('<') || META_REFERENCE_CANDIDATE_RE.test(value));
}
function numericReferenceAt(value, start) {
    if (value[start] !== '#')
        return null;
    let digit = start + 1;
    const hex = value[digit]?.toLowerCase() === 'x';
    if (hex)
        digit++;
    const begin = digit;
    const valid = hex ? /[0-9a-f]/i : /[0-9]/;
    while (digit < value.length && valid.test(value[digit]))
        digit++;
    if (digit === begin)
        return null;
    const codePoint = Number.parseInt(value.slice(begin, digit), hex ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
        return null;
    return { codePoint, end: value[digit] === ';' ? digit + 1 : digit };
}
/** 解析单个受支持字符引用；映射与轻量预判共用同一语义，避免两条解码路径漂移。 */
function decodedReferenceAt(value, index) {
    let cursor = index + 1;
    let ampLayers = 0;
    while (true) {
        if (value.slice(cursor, cursor + 4).toLowerCase() === 'amp;') {
            cursor += 4;
            ampLayers++;
            continue;
        }
        const numericAmp = numericReferenceAt(value, cursor);
        if (numericAmp?.codePoint === 38) {
            cursor = numericAmp.end;
            ampLayers++;
            continue;
        }
        break;
    }
    const tail = value.slice(cursor, cursor + 8).toLowerCase();
    let decoded = null;
    let end = cursor;
    if (tail.startsWith('lt;')) {
        decoded = '<';
        end += 3;
    }
    else if (tail.startsWith('gt;')) {
        decoded = '>';
        end += 3;
    }
    else if (tail.startsWith('tab;')) {
        decoded = '\t';
        end += 4;
    }
    else if (tail.startsWith('newline;')) {
        decoded = '\n';
        end += 8;
    }
    else if (tail.startsWith('sol;')) {
        decoded = '/';
        end += 4;
    }
    else if (tail.startsWith('num;')) {
        decoded = '#';
        end += 4;
    }
    else if (tail.startsWith('semi;')) {
        decoded = ';';
        end += 5;
    }
    else if (tail.startsWith('lt')) {
        decoded = '<';
        end += 2;
    }
    else if (tail.startsWith('gt')) {
        decoded = '>';
        end += 2;
    }
    else {
        const numeric = numericReferenceAt(value, cursor);
        if (numeric) {
            decoded = String.fromCodePoint(numeric.codePoint);
            end = numeric.end;
        }
    }
    if (decoded !== null)
        return { decoded, end };
    if (ampLayers > 0)
        return { decoded: '&', end: cursor };
    return { decoded: '&', end: index + 1 };
}
/** 不建立逐字符源码 span，按 `&` 分块完成与正式映射相同的一轮解码。 */
function decodeReferenceTextPass(value) {
    const out = [];
    let copied = 0;
    let cursor = 0;
    while (cursor < value.length) {
        const amp = value.indexOf('&', cursor);
        if (amp < 0)
            break;
        const token = decodedReferenceAt(value, amp);
        if (token.end === amp + 1) {
            cursor = token.end;
            continue;
        }
        out.push(value.slice(copied, amp), token.decoded);
        copied = token.end;
        cursor = token.end;
    }
    if (out.length === 0)
        return value;
    out.push(value.slice(copied));
    return out.join('');
}
/** 有界固定点轻量解码仅用于判断是否可能生成标签语法，不承担源码区间映射。 */
function decodeReferenceText(value) {
    let current = value;
    for (let pass = 0; pass < 4; pass++) {
        const next = decodeReferenceTextPass(current);
        if (next === current)
            return next;
        current = next;
    }
    return current;
}
/** 单轮字符引用解码；输入 span 已指向原源码，因此多轮后仍能精确删除原始字节区间。 */
function decodeReferencePass(value, inputSpans) {
    const out = [];
    const spans = [];
    const append = (decoded, start, end) => {
        out.push(decoded);
        const mapped = {
            start: inputSpans[start]?.start ?? inputSpans.at(-1)?.end ?? 0,
            end: inputSpans[end - 1]?.end ?? inputSpans[start]?.end ?? inputSpans.at(-1)?.end ?? 0,
        };
        for (let i = 0; i < decoded.length; i++)
            spans.push(mapped);
    };
    for (let index = 0; index < value.length;) {
        if (value[index] !== '&') {
            append(value[index], index, index + 1);
            index++;
            continue;
        }
        const token = decodedReferenceAt(value, index);
        append(token.decoded, index, token.end);
        index = token.end;
    }
    return { text: out.join(''), spans };
}
/** 有界固定点解码覆盖属性解析 + srcdoc/data/RCDATA 二次解析，同时保持 O(n)。 */
function decodeReferences(value, offset = 0) {
    let current = {
        text: value,
        spans: Array.from({ length: value.length }, (_item, index) => ({ start: offset + index, end: offset + index + 1 })),
    };
    for (let pass = 0; pass < 4; pass++) {
        const next = decodeReferencePass(current.text, current.spans);
        if (next.text === current.text)
            return next;
        current = next;
    }
    return current;
}
/** 属性内部独立配对，供整值清理判断；属性中的孤立 closer 不关闭外层边界。 */
function attributeMetaState(value) {
    if (!value.includes('<') && !META_REFERENCE_CANDIDATE_RE.test(value))
        return { sawOpen: false, pending: [] };
    const decoded = needsReferenceDecode(value) ? decodeReferenceText(value) : value;
    const pending = [];
    let sawOpen = false;
    let cursor = 0;
    while (cursor < decoded.length) {
        const open = decoded.indexOf('<', cursor);
        if (open < 0)
            break;
        const head = tagHead(decoded, open);
        if (!head || !DISPLAY_META_NAMES.has(head.name)) {
            cursor = open + 1;
            continue;
        }
        const end = htmlTagEnd(decoded, open);
        const slash = end > 0 && isHtmlSelfClosingTag(decoded, head.end, end);
        if (!head.closing) {
            sawOpen = true;
            pending.push({ name: head.name, slash });
        }
        else if (pending.at(-1)?.name === head.name)
            pending.pop();
        if (end < 0)
            break;
        cursor = end;
    }
    return { sawOpen, pending };
}
/** 属性值可被 srcdoc、CSS attr() 或脚本再次展示；命中时清空，仅畸形未引号源码 opener 延续。 */
function analyzeAttributeValues(text, start, limit) {
    const values = attributeValueRanges(text, start, limit);
    const dangerous = [];
    const pending = [];
    for (const value of values) {
        const state = attributeMetaState(text.slice(value.start, value.end));
        if (state.sawOpen)
            dangerous.push(value);
        if (value.quoted)
            continue;
        const rawState = literalMetaState(text.slice(value.start, value.end));
        for (const opened of rawState.pending) {
            pending.push({ name: opened.name, start: value.start, tokenEnd: value.end, slash: opened.slash });
        }
    }
    return { values, dangerous, pending };
}
/** 畸形属性名里的 `<think>` 会借自己的 `>` 结束外层标签；把它当隐私 opener 延续到后文。 */
function embeddedAttributeNameOpeners(text, start, limit, values) {
    const pending = [];
    let cursor = start;
    let rangeIndex = 0;
    while (cursor < limit) {
        const open = text.indexOf('<', cursor);
        if (open < 0 || open >= limit)
            break;
        while (rangeIndex < values.length && values[rangeIndex].end <= open)
            rangeIndex++;
        const value = values[rangeIndex];
        const insideValue = Boolean(value && open >= value.start && open < value.end);
        const head = tagHead(text, open, limit);
        if (head && !head.closing && DISPLAY_META_NAMES.has(head.name) && !insideValue) {
            pending.push({
                name: head.name,
                start: open,
                tokenEnd: text[limit] === '>' ? limit + 1 : limit,
                // 这里的 opener 已被外层畸形属性名吞入，不能再逐个向后重扫或信任 XML 式自闭合。
                slash: false,
            });
        }
        cursor = open + 1;
    }
    return pending;
}
function collectTagInteriorMeta(text, start, limit, stack, ranges) {
    const attributes = analyzeAttributeValues(text, start, limit);
    ranges.push(...attributes.dangerous);
    const resume = text[limit] === '>' ? limit + 1 : limit;
    stack.push(...[...attributes.pending, ...embeddedAttributeNameOpeners(text, start, limit, attributes.values)]
        .sort((a, b) => a.start - b.start)
        .map(opened => ({ ...opened, start: resume, tokenEnd: resume })));
}
/** 可见 raw/RCDATA 正文中的机读标签独立配对；孤立 closer 不得关闭外层边界。 */
function literalMetaState(value) {
    const ranges = [];
    const pending = [];
    let cursor = 0;
    while (cursor < value.length) {
        const open = value.indexOf('<', cursor);
        if (open < 0)
            break;
        const head = tagHead(value, open);
        if (!head || !DISPLAY_META_NAMES.has(head.name)) {
            cursor = open + 1;
            continue;
        }
        const end = htmlTagEnd(value, open);
        const tokenEnd = end > 0 ? end : value.length;
        const slash = end > 0 && isHtmlSelfClosingTag(value, head.end, end);
        if (!head.closing)
            pending.push({ name: head.name, start: open, tokenEnd, slash });
        else {
            const opened = pending.at(-1);
            if (!opened || opened.name !== head.name)
                ranges.push({ start: open, end: tokenEnd });
            else {
                ranges.push({ start: opened.start, end: tokenEnd });
                pending.pop();
            }
        }
        if (end < 0)
            break;
        cursor = end;
    }
    return { ranges, pending };
}
function mappedDecodedRange(range, spans, fallback) {
    const first = spans[range.start];
    const last = spans[range.end - 1];
    return { start: first?.start ?? fallback, end: last?.end ?? first?.end ?? fallback };
}
function collectLiteralMeta(text, start, end, decodeEntities, stack, ranges) {
    const source = text.slice(start, end);
    const lightweight = decodeEntities && needsReferenceDecode(source) ? decodeReferenceText(source) : source;
    const decode = lightweight !== source && lightweight.includes('<');
    if (!source.includes('<') && !decode)
        return;
    const decoded = decode ? decodeReferences(source, start) : null;
    const visible = decoded?.text ?? source;
    const map = (range) => decoded
        ? mappedDecodedRange(range, decoded.spans, end)
        : { start: start + range.start, end: start + range.end };
    let cursor = 0;
    while (cursor < visible.length) {
        const open = visible.indexOf('<', cursor);
        if (open < 0)
            break;
        const head = tagHead(visible, open);
        if (!head || !DISPLAY_META_NAMES.has(head.name)) {
            cursor = open + 1;
            continue;
        }
        const tokenEnd = htmlTagEnd(visible, open);
        const localEnd = tokenEnd > 0 ? tokenEnd : visible.length;
        const mapped = map({ start: open, end: localEnd });
        const slash = tokenEnd > 0 && isHtmlSelfClosingTag(visible, head.end, tokenEnd);
        if (!head.closing)
            stack.push({ name: head.name, start: mapped.start, tokenEnd: mapped.end, slash });
        else {
            const opened = stack.at(-1);
            if (!opened || opened.name !== head.name)
                ranges.push(mapped);
            else {
                ranges.push({ start: opened.start, end: mapped.end });
                stack.pop();
            }
        }
        if (tokenEnd < 0)
            break;
        cursor = tokenEnd;
    }
}
/** 注释/DOCTYPE 等不可见声明只在自身内部清理，内部 closer 不能关闭外层正文边界。 */
function collectIsolatedLiteralMeta(text, start, end, decodeEntities, ranges) {
    const source = text.slice(start, end);
    const lightweight = decodeEntities && needsReferenceDecode(source) ? decodeReferenceText(source) : source;
    const decode = lightweight !== source && lightweight.includes('<');
    if (!source.includes('<') && !decode)
        return;
    const decoded = decode ? decodeReferences(source, start) : null;
    const visible = decoded?.text ?? source;
    const map = (range) => decoded
        ? mappedDecodedRange(range, decoded.spans, end)
        : { start: start + range.start, end: start + range.end };
    const local = literalMetaState(visible);
    ranges.push(...local.ranges.map(map));
    for (const opened of local.pending) {
        ranges.push(map({ start: opened.start, end: opened.slash ? opened.tokenEnd : visible.length }));
    }
}
/** 外来/选择控件内容按普通标签边界扫描；属性内 closer 不得关闭正文中的机读边界。 */
function collectStructuredVisibleMeta(text, start, end, removeComments, scriptOpaque, stack, ranges) {
    let index = start;
    while (index < end) {
        const open = text.indexOf('<', index);
        if (open < 0 || open >= end) {
            collectLiteralMeta(text, index, end, true, stack, ranges);
            break;
        }
        if (open > index)
            collectLiteralMeta(text, index, open, true, stack, ranges);
        if (text.startsWith('<!--', open)) {
            const closed = htmlCommentEnd(text, open, end);
            const rangeEnd = closed < 0 ? end : closed;
            if (removeComments || closed < 0)
                ranges.push({ start: open, end: rangeEnd });
            index = rangeEnd;
            continue;
        }
        if (text.startsWith('<![CDATA[', open)) {
            const contentStart = open + '<![CDATA['.length;
            const close = text.indexOf(']]>', contentStart);
            const contentEnd = close < 0 || close >= end ? end : close;
            collectLiteralMeta(text, contentStart, contentEnd, false, stack, ranges);
            index = close < 0 || close >= end ? end : close + 3;
            continue;
        }
        const parsed = tagHead(text, open, end);
        const invalidEndTag = text.startsWith('</', open) && !parsed;
        if (text.startsWith('<?', open) || text.startsWith('<!', open) || invalidEndTag) {
            const doctype = /^<!doctype(?=[\t\n\f\r >])/i.test(text.slice(open, Math.min(open + 16, end)));
            const found = doctype ? doctypeEnd(text, open + 2, end) : (() => {
                const close = text.indexOf('>', open + 2);
                return close < 0 || close >= end ? -1 : close + 1;
            })();
            const rangeEnd = found < 0 ? end : found;
            if (doctype && removeComments)
                collectIsolatedLiteralMeta(text, open, rangeEnd, true, ranges);
            else if (removeComments)
                ranges.push({ start: open, end: rangeEnd });
            index = rangeEnd;
            continue;
        }
        if (!parsed) {
            index = open + 1;
            continue;
        }
        const tokenEnd = htmlTagEnd(text, open, end);
        if (tokenEnd < 0) {
            if (DISPLAY_META_NAMES.has(parsed.name))
                collectLiteralMeta(text, open, end, false, stack, ranges);
            else
                collectTagInteriorMeta(text, parsed.end, end, stack, ranges);
            break;
        }
        if (DISPLAY_META_NAMES.has(parsed.name))
            collectLiteralMeta(text, open, tokenEnd, false, stack, ranges);
        else {
            collectTagInteriorMeta(text, parsed.end, tokenEnd - 1, stack, ranges);
            if (scriptOpaque && !parsed.closing && parsed.name === 'script') {
                const closed = opaqueCloseToken(text, 'script', tokenEnd, end);
                if (!closed)
                    break;
                const closeHead = tagHead(text, closed.start, closed.end);
                if (closeHead)
                    collectTagInteriorMeta(text, closeHead.end, closed.end - 1, stack, ranges);
                index = closed.end;
                continue;
            }
        }
        index = tokenEnd;
    }
}
function mergeRanges(input) {
    const sorted = input.filter(range => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of sorted) {
        const previous = merged.at(-1);
        if (!previous || range.start > previous.end)
            merged.push({ ...range });
        else
            previous.end = Math.max(previous.end, range.end);
    }
    return merged;
}
/**
 * 机读块是内容不透明边界：整块隐藏，未闭合时隐私优先隐藏到文末。
 * 扫描器只处理 DISPLAY_META_TAGS；details/style/widget 等卡面内容留给后续 HTML 拆分。
 */
function opaqueDisplayMetaRanges(text, removeComments, segments = [{ start: 0, end: text.length }]) {
    const ranges = [];
    const stack = [];
    const streamEnd = segments.at(-1)?.end ?? text.length;
    for (const segment of segments) {
        let opaque = null;
        let index = segment.start;
        while (index < segment.end) {
            const open = text.indexOf('<', index);
            // 每个展示 part 都在独立 Markdown/iframe 语境；opaque 只延续到本段自身闭标签，不能毒化后续 part。
            if (opaque) {
                const closed = opaqueCloseToken(text, opaque, index, segment.end);
                if (closed) {
                    const head = tagHead(text, closed.start, closed.end);
                    if (head)
                        collectTagInteriorMeta(text, head.end, closed.end - 1, stack, ranges);
                    opaque = null;
                    index = closed.end;
                    continue;
                }
                // 畸形未闭合 opaque 内仍按隐私优先寻找机读 opener；正常闭合元素继续保留标签字面量。
                const hidden = firstDisplayMetaOpen(text, index, segment.end);
                if (hidden >= 0) {
                    opaque = null;
                    index = hidden;
                    continue;
                }
                break;
            }
            if (open < 0 || open >= segment.end) {
                collectLiteralMeta(text, index, segment.end, true, stack, ranges);
                break;
            }
            if (open > index)
                collectLiteralMeta(text, index, open, true, stack, ranges);
            if (text.startsWith('<!--', open)) {
                const closed = htmlCommentEnd(text, open, segment.end);
                const unclosed = closed < 0;
                const end = unclosed ? segment.end : closed;
                // 畸形注释在浏览器里可能 abrupt-close 后继续渲染；找不到精确闭合时整段隐藏才不会泄漏。
                if (removeComments || unclosed)
                    ranges.push({ start: open, end });
                index = end;
                continue;
            }
            const parsed = tagHead(text, open, segment.end);
            const invalidEndTag = text.startsWith('</', open) && !parsed;
            if (text.startsWith('<?', open) || text.startsWith('<!', open) || invalidEndTag) {
                const doctype = /^<!doctype(?=[\t\n\f\r >])/i.test(text.slice(open, Math.min(open + 16, segment.end)));
                const found = doctype
                    ? doctypeEnd(text, open + 2, segment.end)
                    : (() => {
                        const close = text.indexOf('>', open + 2);
                        return close < 0 || close >= segment.end ? -1 : close + 1;
                    })();
                const end = found < 0 ? segment.end : found;
                if (doctype && removeComments)
                    collectIsolatedLiteralMeta(text, open, end, true, ranges);
                if (removeComments && !doctype)
                    ranges.push({ start: open, end });
                index = end;
                continue;
            }
            if (!parsed) {
                index = open + 1;
                continue;
            }
            const end = htmlTagEnd(text, open, segment.end);
            if (end < 0) {
                if (DISPLAY_META_NAMES.has(parsed.name)) {
                    ranges.push({ start: open, end: streamEnd });
                }
                else
                    collectTagInteriorMeta(text, parsed.end, segment.end, stack, ranges);
                break;
            }
            const { closing, name } = parsed;
            const selfClosing = isHtmlSelfClosingTag(text, parsed.end, end);
            if (DISPLAY_META_NAMES.has(name)) {
                if (!closing)
                    stack.push({ name, start: open, tokenEnd: end, slash: selfClosing });
                else {
                    const opened = stack.at(-1);
                    if (!opened || opened.name !== name)
                        ranges.push({ start: open, end });
                    else {
                        ranges.push({ start: opened.start, end });
                        stack.pop();
                    }
                }
                index = end;
                continue;
            }
            collectTagInteriorMeta(text, parsed.end, end - 1, stack, ranges);
            if (!closing && VISIBLE_TEXT_TAGS.has(name)) {
                const structured = name === 'select' || name === 'option' || name === 'math' || name === 'svg';
                const closed = name === 'plaintext'
                    ? null
                    : structured
                        ? structuredCloseToken(text, name, end, segment.end, name === 'math' || name === 'svg')
                        : opaqueCloseToken(text, name, end, segment.end);
                const contentEnd = closed?.start ?? segment.end;
                if (structured)
                    collectStructuredVisibleMeta(text, end, contentEnd, removeComments, name === 'select' || name === 'option', stack, ranges);
                else
                    collectLiteralMeta(text, end, contentEnd, name === 'textarea' || name === 'title', stack, ranges);
                if (closed) {
                    const closeHead = tagHead(text, closed.start, closed.end);
                    if (closeHead)
                        collectTagInteriorMeta(text, closeHead.end, closed.end - 1, stack, ranges);
                    index = closed.end;
                }
                else
                    index = segment.end;
                continue;
            }
            if (!closing && OPAQUE_HTML_TAGS.has(name)) {
                opaque = name;
                index = end;
                continue;
            }
            index = end;
        }
    }
    for (const opened of stack)
        ranges.push({ start: opened.start, end: opened.slash ? opened.tokenEnd : streamEnd });
    return mergeRanges(ranges);
}
function removeRanges(text, ranges, offset = 0) {
    const end = offset + text.length;
    let cursor = offset;
    const out = [];
    for (const range of ranges) {
        if (range.end <= offset)
            continue;
        if (range.start >= end)
            break;
        if (range.start > cursor)
            out.push(text.slice(cursor - offset, Math.min(range.start, end) - offset));
        cursor = Math.max(cursor, Math.min(range.end, end));
    }
    if (cursor < end)
        out.push(text.slice(cursor - offset));
    return out.join('');
}
/** 只删除机读块及其内容；不 trim，也不处理 details/style/widget/透明协议壳。 */
export function stripOpaqueDisplayMeta(text, removeComments = false) {
    return removeRanges(text, opaqueDisplayMetaRanges(text, removeComments));
}
/** 跨有序片段延续机读标签状态，再把保留内容映射回原 kind/title。 */
export function stripOpaqueDisplayMetaParts(parts, removeComments = false, separator = '') {
    const combined = parts.map(part => part.text).join(separator);
    let offset = 0;
    const segments = parts.map(part => {
        const segment = { start: offset, end: offset + part.text.length };
        offset = segment.end + separator.length;
        return segment;
    });
    const ranges = opaqueDisplayMetaRanges(combined, removeComments, segments);
    offset = 0;
    return parts.map(part => {
        const text = removeRanges(part.text, ranges, offset);
        offset += part.text.length + separator.length;
        return { ...part, text };
    });
}
/**
 * 社区卡常用的机读协议标签（customize_HCI / now_plot / world_status）。
 * 下划线名或 PascalCase；不碰 div/p/span 等 HTML。
 */
const PROTOCOL_TAG_RE = /<\/?([A-Za-z][\w]*_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b[^>]*\/?>/g;
// 机读协议常用全大写标签；HTML 本身不区分大小写，不能把 <DIV>/<BR> 当协议删掉。
const HTML_ELEMENT_NAMES = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas '
    + 'caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed '
    + 'fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr '
    + 'html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav nobr '
    + 'noscript object ol optgroup option output p param picture plaintext portal pre progress q rp rt ruby s samp '
    + 'script search section select slot small source span strike strong style sub summary sup svg table tbody td '
    + 'template textarea tfoot th thead time title tr track tt u ul var video wbr xmp '
    + 'circle clippath defs ellipse fegaussianblur filter foreignobject g image line lineargradient mask '
    + 'path pattern polygon polyline radialgradient rect stop symbol text textpath use view '
    + 'math mi mn mo mrow mfrac msqrt').split(' '));
function isCoverHtml(text) {
    return /<!DOCTYPE\s+html/i.test(text) || /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text);
}
function stripClosedAndEmpty(text) {
    let out = text;
    for (let pass = 0; pass < 8; pass++) {
        let next = out;
        for (const tag of DISPLAY_META_TAGS) {
            next = next.replace(new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])[^>]*/[\\t\\n\\f\\r ]*>`, 'gi'), '');
            next = next.replace(new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])[^>]*>[\\s\\S]*?</${tag}[\\t\\n\\f\\r ]*>`, 'gi'), '');
        }
        next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
        next = next.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '');
        if (next === out)
            break;
        out = next;
    }
    return out;
}
/** 未闭合的协议标签（流式输出到一半）从开标签切到文末。 */
function stripUnclosedMeta(text) {
    let cut = -1;
    for (const tag of DISPLAY_META_TAGS) {
        const re = new RegExp(`<${tag}(?=[\\t\\n\\f\\r />])`, 'gi');
        const match = re.exec(text);
        if (match && (cut < 0 || match.index < cut))
            cut = match.index;
    }
    return cut >= 0 ? text.slice(0, cut) : text;
}
/**
 * 日志/折叠小部件几乎总是接在正文之后，且经常标签没闭合。
 * 从第一个特征开标签切到文末，避免半截 HTML 露出来。
 */
function stripWidgetTail(text) {
    const markers = [
        /<div\b[^>]*\bstream-log\b/i,
        /<details\b[^>]*\b[\w-]*-box\b/i,
        /<div\b[^>]*\b[\w-]*-box\b/i,
        /<style\b/i,
    ];
    let cut = -1;
    for (const re of markers) {
        const match = re.exec(text);
        if (match && (cut < 0 || match.index < cut))
            cut = match.index;
    }
    return cut >= 0 ? text.slice(0, cut) : text;
}
function tidy(text) {
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** 收起未转换成 HTML 的协议开闭标签，留下内部正文。 */
function stripProtocolTags(text) {
    return text.replace(PROTOCOL_TAG_RE, (match, name) => HTML_ELEMENT_NAMES.has(name.toLowerCase()) ? match : '');
}
/** 独立样式片段不应占一个空 iframe；跨过普通台词，将 CSS 交给下一张真正的卡面。 */
export function mergeDetachedCardStyles(parts) {
    const styleOnly = /^\s*(?:<style\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/style\s*>\s*)+$/i;
    const prefixes = new Map();
    const moved = new Set();
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.kind !== 'html' || part.title || !styleOnly.test(part.text))
            continue;
        let target = i + 1;
        while (target < parts.length && (parts[target].kind !== 'html' || styleOnly.test(parts[target].text)))
            target++;
        if (target === parts.length)
            continue;
        const group = prefixes.get(target) ?? [];
        group.push(part.text);
        prefixes.set(target, group);
        moved.add(i);
    }
    return parts.flatMap((part, index) => moved.has(index) ? [] : [prefixes.has(index)
            ? { ...part, text: prefixes.get(index).join('\n') + '\n' + part.text }
            : part]);
}
function stripHtmlComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}
/** 去掉展示不该看见的机读块与小部件；角色正文保留。 */
export function stripDisplayMeta(text) {
    if (!text)
        return text;
    const visible = stripOpaqueDisplayMeta(text);
    if (isCoverHtml(visible))
        return visible;
    return tidy(stripProtocolTags(stripWidgetTail(stripUnclosedMeta(stripClosedAndEmpty(stripHtmlComments(visible))))));
}
/** 交互卡关闭后的源码回退：围栏长于内容中的反引号，不能逃逸成可执行 HTML。 */
export function htmlSourceFallback(html) {
    let length = 3;
    for (const match of html.matchAll(/`+/g))
        length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    return `${fence}html\n${html}\n${fence}`;
}
/** 只在卡面之外收起机读标签；不能把已识别的 details/style 小部件连同正文裁掉。 */
function disabledHtmlText(rendered) {
    const parts = [];
    // 先在完整逻辑流上收起机读块；否则 HTML 拆分会切断 think/Analysis 等边界并泄漏内容。
    let remaining = stripOpaqueDisplayMeta(rendered, true);
    for (let i = 0; i < 128; i++) {
        const located = locateRenderedHtml(remaining);
        if (!located) {
            parts.push(stripDisplayMeta(remaining));
            return parts.filter(Boolean).join('\n\n');
        }
        parts.push(stripDisplayMeta(remaining.slice(0, located.fence?.start ?? located.start)));
        parts.push(htmlSourceFallback(located.html));
        remaining = remaining.slice(located.fence?.end ?? located.start + located.html.length);
    }
    throw new Error('交互卡展示片段过多');
}
/**
 * 正则渲染后的展示拆分：交互卡 HTML 进 iframe（可能连续多段），剩余正文再收起机读标签。
 * `allowHtml` 为 false 时整段当文本（交互卡开关关闭）。
 */
export function presentRenderedOutput(rendered, allowHtml) {
    if (!allowHtml)
        return { html: null, htmls: [], text: disabledHtmlText(rendered) };
    const { htmls, rest } = collectRenderedHtml(stripOpaqueDisplayMeta(rendered));
    const grouped = mergeDetachedCardStyles(htmls.map(text => ({ kind: 'html', text }))).map(part => part.text);
    return {
        html: grouped[0] ?? null,
        htmls: grouped,
        text: stripDisplayMeta(rest),
    };
}
