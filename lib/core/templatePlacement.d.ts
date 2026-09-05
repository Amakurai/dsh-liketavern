/** 提示词定位语法解析；仅解析字符串参数，正则匹配和模板求值留在可终止 worker 内。 */
import type { ChatRole } from './types.js';
export type TemplatePlacement = {
    kind: 'insert';
    role: ChatRole;
    order?: number;
    mode: 'pos';
    pos: number;
} | {
    kind: 'insert';
    role: ChatRole;
    order?: number;
    mode: 'target';
    target: ChatRole;
    index: number;
    at: 'before' | 'after';
} | {
    kind: 'insert';
    role: ChatRole;
    order?: number;
    mode: 'regex';
    regex: string;
    at: 'before' | 'after';
} | {
    kind: 'content';
    mode: 'index';
    index: number;
    at: 'before' | 'after';
} | {
    kind: 'content';
    mode: 'regex';
    regex: string;
    at: 'before' | 'after';
} | {
    kind: 'content';
    mode: 'global';
    at: 'before' | 'after';
};
export declare function parseTemplatePlacement(label: string): TemplatePlacement | null;
