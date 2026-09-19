/**
 * 消息 Markdown 的兼容格式化器，仅由构建脚本打包后在 QuickJS 内执行。
 * 通过公开 inline 规则和 token renderer 保留下划线、删除线及有界图片尺寸；HTML 产物只交给卡面沙箱。
 */
import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
/** 尺寸语法只接受有限位数字、常用长度单位和自适应星号，不允许属性或任意 CSS。 */
const DIMENSIONS = /^=(\*|\d{1,6}(?:%|px|em|rem|vw|vh|vmin|vmax)?)x(\*|\d{1,6}(?:%|px|em|rem|vw|vh|vmin|vmax)?)(?=[ \t\n)]|$)/i;
const UNDERLINE_MARKER = 0x10000;
function skipSpace(source, start, max) {
    let position = start;
    while (position < max && (source.charCodeAt(position) === 32
        || source.charCodeAt(position) === 9 || source.charCodeAt(position) === 10))
        position++;
    return position;
}
function sizedDestination(source, start, max, markdown) {
    const destination = markdown.helpers.parseLinkDestination(source, start, max);
    if (!destination.ok)
        return null;
    const href = markdown.normalizeLink(destination.str);
    if (!markdown.validateLink(href))
        return null;
    let position = skipSpace(source, destination.pos, max);
    if (position === destination.pos)
        return null;
    const dimensions = DIMENSIONS.exec(source.slice(position, Math.min(max, position + 64)));
    if (!dimensions)
        return null;
    position += dimensions[0].length;
    const titleStart = skipSpace(source, position, max);
    let title;
    if (titleStart > position) {
        const parsed = markdown.helpers.parseLinkTitle(source, titleStart, max);
        if (parsed.ok) {
            title = parsed.str;
            position = skipSpace(source, parsed.pos, max);
        }
        else
            position = titleStart;
    }
    return { href, title, end: position, width: dimensions[1] === '*' ? 'auto' : dimensions[1],
        height: dimensions[2] === '*' ? 'auto' : dimensions[2] };
}
/** 只识别带尺寸的 inline 图片；其它图片和链接继续交给 Markdown 引擎自己的规则。 */
function sizedImage(state, silent) {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 33 || state.src.charCodeAt(start + 1) !== 91)
        return false;
    const labelEnd = state.md.helpers.parseLinkLabel(state, start + 1, false);
    if (labelEnd < 0)
        return false;
    let position = skipSpace(state.src, labelEnd + 1, state.posMax);
    if (state.src.charCodeAt(position) !== 40)
        return false;
    position = skipSpace(state.src, position + 1, state.posMax);
    const destination = sizedDestination(state.src, position, state.posMax, state.md);
    if (!destination)
        return false;
    position = destination.end;
    if (position >= state.posMax || state.src.charCodeAt(position) !== 41)
        return false;
    if (!silent) {
        const content = state.src.slice(start + 2, labelEnd);
        const children = [];
        state.md.inline.parse(content, state.md, state.env, children);
        const token = state.push('image', 'img', 0);
        token.attrSet('src', destination.href);
        token.attrSet('alt', '');
        if (destination.title !== undefined)
            token.attrSet('title', destination.title);
        token.attrSet('width', destination.width);
        token.attrSet('height', destination.height);
        token.children = children;
        token.content = content;
    }
    state.pos = position + 1;
    return true;
}
/** 引用定义沿用宿主 label/href 规则；尺寸只由图片 renderer 读取，不污染共用定义的普通链接。 */
function sizedReference(state, line, endLine, silent, dimensions) {
    if (state.sCount[line] - state.blkIndent >= 4)
        return false;
    const start = state.bMarks[line] + state.tShift[line];
    const max = state.eMarks[line];
    if (state.src.charCodeAt(start) !== 91)
        return false;
    let position = start + 1;
    while (position < max && state.src.charCodeAt(position) !== 93) {
        if (state.src.charCodeAt(position) === 91)
            return false;
        if (state.src.charCodeAt(position) === 92)
            position++;
        position++;
    }
    if (position >= max || state.src.charCodeAt(position + 1) !== 58)
        return false;
    const label = state.md.utils.normalizeReference(state.src.slice(start + 1, position));
    if (!label)
        return false;
    position = skipSpace(state.src, position + 2, max);
    const destination = sizedDestination(state.src, position, max, state.md);
    if (!destination || destination.end !== max)
        return false;
    let nextLine = line + 1;
    if (destination.title === undefined && nextLine < endLine && state.sCount[nextLine] >= state.blkIndent) {
        const titleStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const titleMax = state.eMarks[nextLine];
        const title = state.md.helpers.parseLinkTitle(state.src, titleStart, titleMax);
        if (title.ok && skipSpace(state.src, title.pos, titleMax) === titleMax) {
            destination.title = title.str;
            nextLine++;
        }
    }
    if (!silent) {
        const references = state.env.references ??= Object.create(null);
        if (!Object.hasOwn(references, label)) {
            references[label] = { href: destination.href, title: destination.title ?? '' };
            let entries = dimensions.get(state.env);
            if (!entries) {
                entries = new Map();
                dimensions.set(state.env, entries);
            }
            entries.set(label, { width: destination.width, height: destination.height });
        }
        state.line = nextLine;
    }
    return true;
}
/** underline 模式不把单下划线当斜体；双/三下划线共享独立 delimiter，不触碰代码或 HTML 属性。 */
function underline(state, silent) {
    if (state.src.charCodeAt(state.pos) !== 95 || silent)
        return false;
    const scanned = state.scanDelims(state.pos, true);
    const markup = state.src.slice(state.pos, state.pos + scanned.length);
    const token = state.push('text', '', 0);
    token.content = markup;
    if (scanned.length === 2 || scanned.length === 3) {
        const previous = state.pos > 0 ? state.src[state.pos - 1] : '';
        const next = state.src[state.pos + scanned.length] ?? '';
        const insideWord = /[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next);
        state.delimiters.push({ marker: UNDERLINE_MARKER, length: 0, token: state.tokens.length - 1, end: -1,
            open: scanned.can_open && !insideWord, close: scanned.can_close && !insideWord });
    }
    state.pos += scanned.length;
    return true;
}
function finishUnderline(state) {
    const apply = (delimiters) => {
        for (const opening of delimiters) {
            if (opening.marker !== UNDERLINE_MARKER || opening.end < 0)
                continue;
            const closing = delimiters[opening.end];
            const width = Math.min(state.tokens[opening.token].content.length, state.tokens[closing.token].content.length);
            for (const [index, nesting] of [[opening.token, 1], [closing.token, -1]]) {
                const token = state.tokens[index];
                token.markup = token.content;
                token.type = nesting === 1 ? 'tavern_u_open' : 'tavern_u_close';
                token.tag = 'u';
                token.nesting = nesting;
                token.content = token.markup.slice(width);
            }
        }
    };
    apply(state.delimiters);
    for (const metadata of state.tokens_meta)
        if (metadata?.delimiters)
            apply(metadata.delimiters);
}
/** raw inline code 作为单个 HTML token 保留，避免其中的 emoji、图片和 Markdown 再解析。 */
function rawCode(state, silent, missingClosers) {
    const start = state.pos;
    if (state.src.slice(start, start + 5).toLowerCase() !== '<code'
        || !/[\s>]/.test(state.src[start + 5] ?? ''))
        return false;
    const missing = missingClosers.get(state);
    if (missing?.max === state.posMax && start >= missing.start)
        return false;
    let position = start + 5;
    let quote = '';
    for (; position < state.posMax; position++) {
        const character = state.src[position];
        if (quote) {
            if (character === quote)
                quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '<')
            return false;
        if (character === '>')
            break;
    }
    if (position >= state.posMax)
        return false;
    const closing = /<\/code[ \t\r\n]*>/gi;
    closing.lastIndex = position + 1;
    const match = closing.exec(state.src);
    if (!match || closing.lastIndex > state.posMax) {
        // 已证明该 inline 范围的后缀没有闭标签；后续相同开标签不重复扫描整段后缀。
        missingClosers.set(state, { start: position + 1, max: state.posMax });
        return false;
    }
    if (!silent)
        state.push('html_inline', '', 0).content = state.src.slice(start, closing.lastIndex);
    state.pos = closing.lastIndex;
    return true;
}
/** 不暴露 parser 或插件对象，避免模板修改其它格式化调用的引擎配置。 */
export function createMessageFormatter() {
    const markdown = new MarkdownIt({ html: true, breaks: true, xhtmlOut: true, linkify: false, typographer: false });
    markdown.use(emoji, { shortcuts: {} });
    const referenceDimensions = new WeakMap();
    const missingCodeClosers = new WeakMap();
    // 有序列表的标记比项目符号多一位；公开 block tokenizer 的递归入口允许两空格子项。
    // 仅调整当前有序项目的内容缩进，代码块与其它块仍由原始规则识别，不重写原文。
    const tokenizeBlocks = markdown.block.tokenize.bind(markdown.block);
    markdown.block.tokenize = (state, startLine, endLine) => {
        const last = state.tokens.at(-1);
        const previousIndent = state.blkIndent;
        const previousMark = state.bMarks[startLine];
        const previousShift = state.tShift[startLine];
        const previousCount = state.sCount[startLine];
        if (state.parentType === 'list' && last?.type === 'list_item_open'
            && (last.markup === '.' || last.markup === ')') && state.blkIndent > state.listIndent + 2) {
            state.blkIndent = state.listIndent + 2;
            // 标记跨多位数字时，首行的虚拟起点同步前移；否则 getLines 会把标记尾部混入正文。
            const delta = previousIndent - state.blkIndent;
            state.bMarks[startLine] = previousMark + delta;
            state.tShift[startLine] = previousShift - delta;
            state.sCount[startLine] = previousCount - delta;
        }
        try {
            tokenizeBlocks(state, startLine, endLine);
        }
        finally {
            state.blkIndent = previousIndent;
            state.bMarks[startLine] = previousMark;
            state.tShift[startLine] = previousShift;
            state.sCount[startLine] = previousCount;
        }
    };
    markdown.block.ruler.before('reference', 'tavern_image_reference_dimensions', (state, line, endLine, silent) => sizedReference(state, line, endLine, silent, referenceDimensions));
    markdown.inline.ruler.before('image', 'tavern_image_dimensions', sizedImage);
    markdown.inline.ruler.before('emphasis', 'tavern_underline', underline);
    markdown.inline.ruler2.before('emphasis', 'tavern_underline', finishUnderline);
    markdown.inline.ruler.before('html_inline', 'tavern_raw_code', (state, silent) => rawCode(state, silent, missingCodeClosers));
    const renderImage = markdown.renderer.rules.image;
    markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
        const token = tokens[index];
        const label = token.meta?.label;
        const dimensions = env && typeof label === 'string' ? referenceDimensions.get(env)?.get(label) : undefined;
        if (dimensions) {
            token.attrSet('width', dimensions.width);
            token.attrSet('height', dimensions.height);
        }
        return renderImage(tokens, index, options, env, renderer);
    };
    markdown.renderer.rules.s_open = () => '<del>';
    markdown.renderer.rules.s_close = () => '</del>';
    markdown.renderer.rules.tavern_u_open = (tokens, index) => '<u>' + tokens[index].content;
    markdown.renderer.rules.tavern_u_close = (tokens, index) => tokens[index].content + '</u>';
    return (text) => {
        const output = markdown.render(text);
        return output.endsWith('\n') ? output.slice(0, -1) : output;
    };
}
