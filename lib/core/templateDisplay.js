/** 有序展示片段契约：HTML 永远交给隔离卡面，Markdown 与 HTML 的前后位置、折叠标题独立保存。 */
import { locateRenderedHtml } from './regex.js';
import { htmlSourceFallback, stripDisplayMeta, stripOpaqueDisplayMeta, stripOpaqueDisplayMetaParts, } from './displaySanitize.js';
export const TEMPLATE_DISPLAY_PARTS_VERSION = 1;
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
    if (text.length > MAX_TEXT)
        throw new Error('模板展示片段超过 1 MiB 上限');
    const parts = [];
    const visit = (source, depth = 0) => {
        if (!source.trim())
            return;
        if (depth > 64 || parts.length >= MAX_PARTS)
            throw new Error('模板展示片段过多');
        const split = locateRenderedHtml(source);
        if (!split) {
            const value = preserveMeta ? source : stripDisplayMeta(source);
            if (value)
                parts.push({ kind: 'markdown', text: value });
            return;
        }
        const before = source.slice(0, split.fence?.start ?? split.start);
        const after = source.slice(split.fence?.end ?? split.start + split.html.length);
        visit(before, depth + 1);
        parts.push({ kind: 'html', text: split.html });
        visit(after, depth + 1);
    };
    // 机读块必须在首次 HTML 定位前按完整字符串收起，不能让拆分切断其开闭标签。
    visit(stripOpaqueDisplayMeta(text));
    return preserveMeta ? parseTemplateDisplayParts(parts) : sanitizeTemplateDisplayParts(parts);
}
/**
 * 对有序展示片段做一次跨片段机读清理；HTML 类型与折叠标题保持不变。
 * 模板首次生成和展示正则之后都调用，避免标签跨 markdown/html 边界时丢失状态。
 */
export function sanitizeTemplateDisplayParts(parts) {
    const visible = stripOpaqueDisplayMetaParts(parseTemplateDisplayParts(parts));
    const output = [];
    for (const part of visible) {
        if (part.kind === 'html') {
            if (part.text)
                output.push(part);
            continue;
        }
        const text = stripDisplayMeta(part.text);
        if (text)
            output.push({ kind: 'markdown', text });
    }
    return parseTemplateDisplayParts(output);
}
/** 会话/全局关闭交互卡时跨片段清理，再逐 HTML 段安全降级并保持顺序。 */
export function disableInteractiveParts(parts) {
    const visible = stripOpaqueDisplayMetaParts(parseTemplateDisplayParts(parts), true);
    const output = [];
    for (const part of visible) {
        if (part.kind === 'html') {
            if (part.text)
                output.push({ kind: 'markdown', text: htmlSourceFallback(part.text) });
            continue;
        }
        const text = stripDisplayMeta(part.text);
        if (text)
            output.push({ kind: 'markdown', text });
    }
    return output;
}
