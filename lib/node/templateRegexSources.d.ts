/** 全消息正则的来源区间映射；所有匹配、捕获替换与回调均在 QuickJS 内执行，来源身份跨主动激活重组保持稳定。 */
export interface TemplateRegexSource {
    key: string;
    text: string;
    start: number;
}
export declare const TEMPLATE_REGEX_SOURCES: string;
