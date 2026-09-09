/** 沙箱消息批量编辑契约：正文和消息数据分别验证，禁止不支持的属性被半执行。 */
import { helperJson, type HelperTable, type HelperSnapshot } from './helperRuntime.js';
import { parseHelperSwipes, type HelperSwipeSet } from './helperSwipes.js';
export interface HelperMessageTextEdit {
    message_id: number;
    message?: string;
    data?: HelperTable;
    extra?: HelperTable;
    pages?: HelperSwipeSet;
    delete?: true;
}
export interface HelperMessageEditRequest {
    storyId: string;
    historyRevision: string;
    edits: unknown;
    before?: unknown;
}
export interface HelperMessageEditResult {
    branch: {
        childSessionId: string;
        title: string;
    } | null;
    snapshot?: HelperSnapshot;
}
export declare function parseHelperMessageEdits(input: unknown, json?: typeof helperJson, swipes?: typeof parseHelperSwipes): HelperMessageTextEdit[];
