/** 同页面消息显示重建：先准备各气泡并锁定卡面草稿，收到发起沙箱确认后才发布；失败保留原显示。 */
import { emitHelperHostEvent, reportHelperHostEventError } from './helperEventRouter.js';
export class HelperDisplayError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export function waitHelperDisplay(pending, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new HelperDisplayError('timeout'));
        if (signal.aborted) {
            void pending.catch(() => { });
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}
const drivers = new Map(), busy = new Set();
export function registerHelperDisplay(sessionId, driver) {
    let group = drivers.get(sessionId);
    if (!group) {
        group = new Set();
        drivers.set(sessionId, group);
    }
    group.add(driver);
    return () => { group.delete(driver); if (!group.size)
        drivers.delete(sessionId); };
}
export async function prepareHelperDisplay(sessionId, request) {
    if (busy.has(sessionId))
        throw new HelperDisplayError('busy');
    busy.add(sessionId);
    const leases = [], controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
        // 等待所有准备任务结束后再释放，不能让迟到的成功结果留下锁。
        const results = await Promise.allSettled([...drivers.get(sessionId) ?? []].map(driver => driver(request, controller.signal)));
        for (const result of results)
            if (result.status === 'fulfilled' && result.value)
                leases.push(result.value);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        let active = true;
        const check = () => { if (!active)
            throw new HelperDisplayError('stale'); for (const lease of leases)
            lease.check(); };
        const cancel = () => { if (!active)
            return; active = false; for (const lease of leases)
            lease.cancel(); busy.delete(sessionId); };
        return { check, cancel, commit: () => {
                try {
                    check();
                    for (const lease of leases)
                        lease.commit();
                    if (request.ids === null)
                        void Promise.all(leases.map(lease => lease.after?.())).then(() => emitHelperHostEvent(sessionId, request.storyId, 'chat_id_changed', [request.storyId], () => leases.every(lease => lease.current?.() !== false))).catch(error => reportHelperHostEventError(sessionId, request.storyId, error));
                }
                catch (error) {
                    cancel();
                    throw error;
                }
                finally {
                    active = false;
                    busy.delete(sessionId);
                }
            } };
    }
    catch (error) {
        for (const lease of leases)
            lease.cancel();
        busy.delete(sessionId);
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
