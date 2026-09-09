/** 模板的 MVU 只读投影：只选当前剧情可见的稳定消息身份，不制造另一份可写变量存储。 */
import { type HelperScopes } from './helperRuntime.js';
import { type TemplateVariables } from './template.js';
import type { TemplateMessageIdentity } from './templateMessageVariables.js';
export interface TemplateHelperMvu {
    version: 1;
    snapshots: Record<string, TemplateVariables>;
    /** 当前剧情最近有效状态，独立于宿主给模型裁剪的历史；历史 withMsg 仍只查 snapshots。 */
    current?: TemplateVariables;
}
export declare function parseTemplateHelperMvu(value: unknown, identities: readonly TemplateMessageIdentity[]): TemplateHelperMvu;
export declare function projectTemplateHelperMvu(scopes: HelperScopes, identities: readonly TemplateMessageIdentity[], current?: TemplateVariables): TemplateHelperMvu | undefined;
export declare function latestTemplateHelperMvu(value: TemplateHelperMvu | undefined, identities: readonly TemplateMessageIdentity[]): TemplateVariables | undefined;
