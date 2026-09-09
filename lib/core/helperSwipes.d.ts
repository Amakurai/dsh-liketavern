/** 剧情消息的完整页集合：有界普通 JSON 校验，并将当前正文和变量投影到选中页。 */
import { helperJson, type HelperTable } from './helperRuntime.js';
export interface HelperSwipePage {
    message: string;
    data: HelperTable;
    extra: HelperTable;
}
export interface HelperSwipeSet {
    active: number;
    pages: HelperSwipePage[];
}
export declare function parseHelperSwipes(input: unknown, json?: typeof helperJson): HelperSwipeSet;
export declare function effectiveHelperSwipes(page: HelperSwipePage, stored?: HelperSwipeSet): HelperSwipeSet;
