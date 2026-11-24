export type PlainDetailsChild = {
    kind: 'markdown';
    text: string;
} | {
    kind: 'details';
    block: PlainDetailsBlock;
};
export interface PlainDetailsBlock {
    open: boolean;
    summary: string | null;
    children: PlainDetailsChild[];
}
/**
 * 解析由一个或多个纯文本/Markdown `<details>` 组成的 HTML 片段。
 * 只要出现任意属性（除 `open`）、样式、脚本或非允许的 HTML 元素即返回 `null`。
 */
export declare function parsePlainDetailsBlocks(html: string): PlainDetailsBlock[] | null;
/** 快速判定 HTML 片段是否可完全交由原生折叠组件安全渲染。 */
export declare function isPlainDetailsHtml(html: string): boolean;
/** 将已解析的纯折叠块展开为可读纯文本，供只含折叠块的气泡复制正文。 */
export declare function formatPlainDetailsText(blocks: readonly PlainDetailsBlock[]): string;
