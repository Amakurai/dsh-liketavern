/** 原生 MVU 的状态栏展示补位：只补已启用角色正则明确声明的占位符，不改原文、提示词或剧情变量。 */
import type { RegexRule } from './types.js';
export declare const MVU_STATUS_PLACEHOLDER = "<StatusPlaceHolderImpl/>";
export declare function needsMvuStatusPlaceholder(text: string, rules: RegexRule[]): boolean;
