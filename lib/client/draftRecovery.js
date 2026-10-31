/** 本页未确认草稿：连接与分区隔离、有限槽位和 JSON 体积、同代回执确认；不把正文写入浏览器持久存储。 */
import { EDITOR_DRAFT_MAX_BYTES } from '../core/editorDraftLimits.js';
export const DRAFT_RECOVERY_SCOPE_LIMIT = 16;
export class DraftRecoveryChannel {
    holders = new Set();
    weak = new WeakRef(this);
    pending;
}
export class DraftRecoveryTooLargeError extends Error {
}
const remotes = new WeakMap();
const slots = new Set();
const encoder = new TextEncoder();
let unloadWindow;
function liveChannels() {
    const live = [];
    for (const slot of slots) {
        const channel = slot.deref();
        if (channel)
            live.push(channel);
        else
            slots.delete(slot);
    }
    return live;
}
const hasPending = () => liveChannels().some(channel => channel.pending !== undefined);
function onUnload(event) {
    if (!hasPending())
        return;
    event.preventDefault();
    event.returnValue = '';
}
function syncUnload() {
    const target = typeof window === 'undefined' ? undefined : window;
    const pending = hasPending();
    if (unloadWindow && (unloadWindow !== target || !pending)) {
        unloadWindow.removeEventListener('beforeunload', onUnload);
        unloadWindow = undefined;
    }
    if (pending && target && !unloadWindow) {
        target.addEventListener('beforeunload', onUnload);
        unloadWindow = target;
    }
}
function dropIdle(remote, key, channel) {
    if (channel.holders.size || channel.pending !== undefined)
        return;
    const channels = remotes.get(remote);
    if (channels?.get(key) === channel)
        channels.delete(key);
    slots.delete(channel.weak);
    syncUnload();
}
/** 在加载编辑器前预留槽位；已持有未确认记录的分区即使预算满了也能重开修复。 */
export function acquireDraftRecovery(remote, key, holder) {
    let channels = remotes.get(remote);
    let channel = channels?.get(key);
    if (!channel) {
        if (liveChannels().length >= DRAFT_RECOVERY_SCOPE_LIMIT)
            return null;
        channels ??= new Map();
        channel = new DraftRecoveryChannel();
        channels.set(key, channel);
        remotes.set(remote, channels);
        slots.add(channel.weak);
    }
    channel.holders.add(holder);
    return channel;
}
export function releaseDraftRecovery(remote, key, channel, holder) {
    channel.holders.delete(holder);
    // 父级先退出、子级随后 flush；等本次布局清理结束后再回收无内容的槽位。
    void Promise.resolve().then(() => dropIdle(remote, key, channel));
}
function fits(serialized) {
    return serialized.length <= EDITOR_DRAFT_MAX_BYTES && encoder.encode(serialized).byteLength <= EDITOR_DRAFT_MAX_BYTES;
}
export function stageDraftRecovery(channel, serialized) {
    if (!fits(serialized))
        throw new DraftRecoveryTooLargeError();
    const record = { serialized };
    channel.pending = record;
    syncUnload();
    return record;
}
export function failDraftRecovery(channel, record, message) {
    if (channel.pending === record)
        record.error = message.slice(0, 2000);
}
/** 超限或无法编码时只保留上一份有界快照并明确标记失败，不能将旧内容伪装为最新恢复。 */
export function unavailableDraftRecovery(channel, message, fallback) {
    const previous = channel.pending?.serialized ?? fallback;
    channel.pending = { unavailable: true, error: message.slice(0, 2000), serialized: previous !== undefined && fits(previous) ? previous : undefined };
    syncUnload();
}
export function confirmDraftRecovery(remote, key, channel, record) {
    if (channel.pending !== record)
        return;
    channel.pending = undefined;
    dropIdle(remote, key, channel);
    syncUnload();
}
/** 确认只作用于仍在显示的失败标记；别的编辑器提交了更新快照时，旧确认不能清掉它。 */
export function restorePreviousDraftRecovery(remote, key, channel, record) {
    if (channel.pending !== record)
        return;
    channel.pending = record.serialized === undefined ? undefined : { serialized: record.serialized };
    dropIdle(remote, key, channel);
    syncUnload();
}
