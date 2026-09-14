/** 完整文档也按标签扫描；注释、代码示例与 script/style 字符串不参与文档边界判断。 */
export declare function findHtmlDocument(text: string): {
    start: number;
    end: number;
} | null;
export declare function findHtmlFragment(text: string): {
    start: number;
    end: number;
} | null;
