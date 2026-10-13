/** 消息变量快照契约：稳定消息身份与文本索引分离，只把当前剧情可见的快照送入隔离器。 */
import { validateTemplateJson } from './template.js';
import { measureTemplateJson, TEMPLATE_REPLAY_MAX_CHARS } from './templateBudget.js';
export const emptyTemplateMessageVariables = () => ({ version: 1, snapshots: {} });
/** 单条可写变量仍有独立预算；历史集合只受完整模板文档的资源容量约束。 */
export const TEMPLATE_MESSAGE_VARIABLES_LIMIT = 1024 * 1024;
export const TEMPLATE_MESSAGE_VARIABLES_TOTAL_LIMIT = TEMPLATE_REPLAY_MAX_CHARS;
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
    && !['__proto__', 'constructor', 'prototype'].includes(value) && !/[\u0000-\u001f]/.test(value);
export function parseTemplateMessageVariables(value, _scope = 'visible') {
    measureTemplateJson(value, TEMPLATE_MESSAGE_VARIABLES_TOTAL_LIMIT);
    validateTemplateJson(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
        || Object.keys(value).some(key => !['version', 'snapshots'].includes(key)) || !value.snapshots
        || typeof value.snapshots !== 'object' || Array.isArray(value.snapshots))
        throw new Error('消息变量快照版本或结构无效');
    const entries = Object.entries(value.snapshots);
    for (const [id, frame] of entries) {
        if (!validId(id) || !frame || typeof frame !== 'object' || Array.isArray(frame)
            || Object.keys(frame).some(key => !['values', 'initialized'].includes(key)) || typeof frame.initialized !== 'boolean'
            || !frame.values || typeof frame.values !== 'object' || Array.isArray(frame.values))
            throw new Error('消息变量快照损坏');
        try {
            measureTemplateJson(frame, TEMPLATE_MESSAGE_VARIABLES_LIMIT);
        }
        catch (error) {
            throw new Error('单条消息变量快照超过 1 MiB 上限或结构无效', { cause: error });
        }
    }
    return { version: 1, snapshots: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}
export function parseTemplateMessageIdentities(value, length) {
    measureTemplateJson(value, TEMPLATE_MESSAGE_VARIABLES_TOTAL_LIMIT);
    validateTemplateJson(value);
    if (!Array.isArray(value) || value.length !== length)
        throw new Error('模板消息身份与文本历史不一致');
    const ids = new Set();
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.messageId) || ids.has(item.messageId)
            || item.swipeId !== 0 || Object.keys(item).some(key => !['messageId', 'hostMessageId', 'swipeId'].includes(key))
            || item.hostMessageId !== undefined && (typeof item.hostMessageId !== 'number' || !Number.isSafeInteger(item.hostMessageId) || item.hostMessageId < 0))
            throw new Error('模板消息身份无效或重复');
        ids.add(item.messageId);
    }
    return value;
}
export function visibleTemplateMessageVariables(value, identities) {
    const source = value ?? emptyTemplateMessageVariables();
    return { version: 1, snapshots: Object.fromEntries(identities.filter(item => Object.hasOwn(source.snapshots, item.messageId))
            .map(item => [item.messageId, source.snapshots[item.messageId]])) };
}
export function mergeTemplateMessageVariables(previous, next, identities) {
    parseTemplateMessageVariables(next);
    const allowed = new Set(identities.map(item => item.messageId));
    if (Object.keys(next.snapshots).some(id => !allowed.has(id)))
        throw new Error('模板返回不可见消息的变量快照');
    return parseTemplateMessageVariables({ version: 1, snapshots: { ...previous?.snapshots, ...next.snapshots } }, 'stored');
}
