/** 续写的 Markdown 代码语境：只补展示分隔符，代码里的 HTML 不能升级为卡面，不重复旧台词或改动存储。 */
import { markdownCodeScanner } from './markdownCode.js';
import { locateRenderedHtml } from './regex.js';
import { findIncompleteHtmlStart } from './displaySanitize.js';
/** 只处理真实边界跨过的代码段；真正 HTML 卡面内部的 JavaScript 反引号不是 Markdown。 */
export function continuedMarkdown(previous, current) {
    if (!previous || !current)
        return undefined;
    const joined = previous + current, boundary = previous.length, code = markdownCodeScanner(joined);
    const htmls = [];
    let offset = 0;
    for (let count = 0; count < 128; count++) {
        const html = locateRenderedHtml(joined.slice(offset));
        if (!html)
            break;
        const start = offset + (html.fence?.start ?? html.start), end = offset + (html.fence?.end ?? html.start + html.html.length);
        htmls.push({ start, end });
        offset = end;
        if (end >= boundary)
            break;
    }
    const pendingHtml = findIncompleteHtmlStart(joined);
    const tokens = /`+|~{3,}/g;
    for (let token = tokens.exec(joined); token && token.index < boundary; token = tokens.exec(joined)) {
        const start = token.index;
        const html = htmls.find(range => range.start <= start && range.end > start);
        if (html) {
            tokens.lastIndex = html.end;
            continue;
        }
        if (pendingHtml !== null && start >= pendingHtml)
            break;
        const fence = code.fence(start);
        if (fence) {
            tokens.lastIndex = fence.end;
            if (fence.end <= boundary)
                continue;
            // 有明确 HTML 语言但还没有闭围栏时也属于卡面；其余普通代码使用安全语言名，
            // 避免将原本在引用/列表中的 HTML 示例改造成顶层可执行 HTML 围栏。
            const info = fence.info.trim().split(/\s+/)[0].toLowerCase();
            if (fence.standalone && ['html', 'xml'].includes(info))
                continue;
            const content = joined.slice(Math.max(boundary, fence.contentStart), Math.max(boundary, fence.contentEnd));
            const rest = joined.slice(Math.max(boundary, fence.end));
            if (!content)
                return { start, text: rest };
            const marker = codeMarker(content, 3);
            const language = /^[a-z0-9_#+-]+$/i.test(info) && !['html', 'xml', 'text'].includes(info) ? info : 'plaintext';
            return { start, text: marker + language + '\n' + content + (content.endsWith('\n') ? '' : '\n') + marker + '\n' + rest };
        }
        const end = code.inlineEnd(start);
        if (end === null)
            continue;
        tokens.lastIndex = end;
        if (end <= boundary)
            continue;
        const content = joined.slice(Math.max(boundary, start + token[0].length), Math.max(boundary, end - token[0].length));
        if (!content)
            return { start, text: joined.slice(end) };
        const marker = codeMarker(content, 1);
        return { start, text: marker + ' ' + content + ' ' + marker + joined.slice(end) };
    }
    return undefined;
}
/** 包装标记必须长于内容里所有反引号，不能让示例文本提前逃出代码语境。 */
function codeMarker(text, minimum) {
    let count = minimum;
    for (const match of text.matchAll(/`+/g))
        count = Math.max(count, match[0].length + 1);
    return '`'.repeat(count);
}
