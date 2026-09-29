export function installCardMvuRunner(initialize, json) {
    const root = window;
    const runtimeId = root.__dshTavernEventRuntimeId;
    if (typeof runtimeId !== 'string' || !runtimeId || runtimeId.length > 96)
        throw new Error('MVU 执行器缺少有效事件运行时');
    let active = true, busy = false;
    const receive = (event) => {
        const input = event.data;
        if (!active || event.source !== parent || input?.source !== 'dsh-tavern-card' || input.action !== 'helperMvuRun' || input.runtimeId !== runtimeId || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 128)
            return;
        const reply = (value) => { if (active)
            parent.postMessage({ source: 'dsh-tavern-card', action: 'helperMvuResult', runtimeId, requestId: input.requestId, ...value }, '*'); };
        if (busy) {
            reply({ ok: false, error: 'MVU 任务正在执行' });
            return;
        }
        busy = true;
        void (async () => {
            const work = json(input.work, 8 * 1024 * 1024);
            if (!work.enabled || work.status !== 'pending' || !work.job || !work.snapshot || !work.base || work.storyId !== work.snapshot.storyId || !['initialize', 'update'].includes(work.job.kind)
                || typeof work.job.text !== 'string' || !Number.isSafeInteger(work.job.turn) || work.job.turn < 0)
                throw new Error('MVU 任务缺少有效快照或数据');
            const target = work.snapshot.messages?.[work.snapshot.currentMessageId];
            if (!target || target.role !== 'assistant' || target.message !== work.job.text)
                throw new Error('MVU 任务正文与消息快照不一致');
            // 前文由宿主以同一冻结快照下标授权；只合并原文，不制造消息、重跑已提交回复或插入换行。
            const ids = work.continuationMessageIds ?? [], parts = [];
            if (!Array.isArray(ids) || ids.length > 64)
                throw new Error('MVU 续写来源无效');
            let previous = -1, bytes = new TextEncoder().encode(work.job.text).length;
            for (const id of ids) {
                if (!Number.isSafeInteger(id) || id <= previous || id >= work.snapshot.currentMessageId)
                    throw new Error('MVU 续写来源顺序无效');
                const message = work.snapshot.messages[id];
                if (!message || message.message_id !== id || message.role !== 'assistant' || typeof message.message !== 'string')
                    throw new Error('MVU 续写来源与消息快照不一致');
                bytes += new TextEncoder().encode(message.message).length;
                if (bytes > 256 * 1024)
                    throw new Error('MVU 续写合并正文超过 256 KiB');
                parts.push(message.message);
                previous = id;
            }
            if (bytes > 256 * 1024)
                throw new Error('MVU 回复正文超过 256 KiB');
            parts.push(work.job.text);
            const refreshed = await root.refreshHelperSnapshot();
            if (JSON.stringify(json(refreshed, 4 * 1024 * 1024)) !== JSON.stringify(json(work.snapshot, 4 * 1024 * 1024)))
                throw new Error('MVU 任务快照与刷新回执不一致');
            if (!active)
                throw new Error('MVU 执行器已关闭');
            let data = work.base;
            if (work.job.kind === 'initialize') {
                const yaml = root.YAML;
                const existing = work.applyText === false && data.stat_data && typeof data.stat_data === 'object' && !Array.isArray(data.stat_data) ? data.stat_data : undefined;
                data = initialize(work.initialSources ?? [], work.greeting ?? '', data, text => yaml.parse(text), json);
                if (existing)
                    data.stat_data = { ...data.stat_data, ...existing };
                data = await root.__dshTavernMvuInitialize(data, work.swipeId ?? 0);
            }
            if (work.job.kind === 'update' || (work.applyText ?? work.job.turn > 0)) {
                const mvu = root.Mvu;
                data = await mvu.parseMessage(parts.join(''), data);
            }
            reply({ ok: true, data: json(data) });
        })().catch(error => reply({ ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 2000) })).finally(() => { busy = false; });
    };
    window.addEventListener('message', receive);
    parent.postMessage({ source: 'dsh-tavern-card', action: 'helperMvuReady', runtimeId }, '*');
    return () => { active = false; window.removeEventListener('message', receive); };
}
