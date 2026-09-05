/** 有序展示片段契约：HTML 永远交给隔离卡面，Markdown 与 HTML 的前后位置、折叠标题独立保存。 */
import { splitRenderedHtml } from './regex.js';
import { stripDisplayMeta } from './displaySanitize.js';
const MAX_PARTS = 128;
const MAX_TEXT = 1024 * 1024;
export function parseTemplateDisplayParts(value) {
    if (!Array.isArray(value) || value.length > MAX_PARTS)
        throw new Error('模板展示片段必须是最多 128 项的数组');
    let size = 0;
    return value.map((part) => {
        if (!part || typeof part !== 'object' || !('kind' in part) || !('text' in part) || typeof part.text !== 'string'
            || !['markdown', 'html'].includes(String(part.kind)) || Object.keys(part).some(key => !['kind', 'text', 'title'].includes(key)))
            throw new Error('模板展示片段损坏');
        size += part.text.length;
        if (size > MAX_TEXT)
            throw new Error('模板展示片段超过 1 MiB 上限');
        if ('title' in part && (part.kind !== 'html' || typeof part.title !== 'string' || part.title.length > 4096))
            throw new Error('模板展示标题无效');
        return part.kind === 'html' ? { kind: 'html', text: part.text, ...('title' in part ? { title: part.title } : {}) } : { kind: 'markdown', text: part.text };
    });
}
/** 利用已有 HTML 识别规则定位原始子串，再分别拆分两侧，避免聚合 htmls 时将尾部卡面移到前面。 */
export function splitTemplateDisplay(text, preserveMeta = false) {
    const parts = [];
    const visit = (source, depth = 0) => {
        if (!source.trim())
            return;
        if (depth > 64 || parts.length >= MAX_PARTS)
            throw new Error('模板展示片段过多');
        const split = splitRenderedHtml(source);
        if (!split.html) {
            const value = preserveMeta ? source : stripDisplayMeta(source);
            if (value)
                parts.push({ kind: 'markdown', text: value });
            return;
        }
        const start = source.indexOf(split.html);
        if (start < 0)
            throw new Error('模板 HTML 片段定位失败');
        let before = source.slice(0, start), after = source.slice(start + split.html.length);
        const fence = /```(?:text|html|xml)?[ \t]*\r?\n[ \t\r\n]*$/i.exec(before);
        const close = /^[ \t\r\n]*```/.exec(after);
        if (fence && close) {
            before = before.slice(0, fence.index);
            after = after.slice(close[0].length);
        }
        visit(before, depth + 1);
        parts.push({ kind: 'html', text: split.html });
        visit(after, depth + 1);
    };
    visit(text);
    return parseTemplateDisplayParts(parts);
}
