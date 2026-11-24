/**
 * 将送入宿主 `MarkdownText` 的普通 Markdown 文本做只读展示归一化，
 * 避免酒馆角色卡内常见安全 HTML 标签原样裸露或触发 CommonMark HTML 块吞掉代码围栏。
 */
export declare function normalizeHostMarkdown(text: string): string;
