export function installCardPersistence(snapshot, source, _labels) {
    const root = window;
    const retained = root.__dshTavernSnapshot;
    if (retained?.storyId === snapshot.storyId)
        snapshot = retained;
    root.__dshTavernSnapshot = snapshot;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const equal = (a, b) => {
        const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
        return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
    };
    let state = root.__dshTavernPersistent;
    if (!state || state.storyId !== snapshot.storyId || state.historyRevision !== snapshot.historyRevision) {
        state = { storyId: snapshot.storyId, historyRevision: snapshot.historyRevision, confirmed: clone(snapshot.scopes) };
        root.__dshTavernPersistent = state;
    }
    const holder = (root.__dshTavernVariables ??= { scopes: clone(snapshot.scopes) });
    const persistent = state;
    const epoch = crypto.randomUUID();
    let active = true, serial = 0, failure = null, running = null;
    let refreshing = null;
    let editing = null;
    let invalidated = false;
    let pending = null;
    let status = 'saved';
    // 保存状态留在运行时 API；管理入口在设置面板，不向第三方 body 插入布局节点。
    function setStatus(value) { status = value; }
    function report(error) {
        const callback = root.__dshTavernReportError;
        if (typeof callback === 'function')
            callback(error);
    }
    function differences() {
        return [...new Set([...Object.keys(persistent.confirmed), ...Object.keys(holder.scopes)])]
            .filter(key => !equal(persistent.confirmed[key] ?? {}, holder.scopes[key] ?? {}))
            .map(key => ({ key, before: clone(persistent.confirmed[key] ?? {}), value: clone(holder.scopes[key] ?? {}) }));
    }
    const receive = (event) => {
        if (event.source !== parent)
            return;
        const value = event.data;
        if (value?.source === source && value.action === 'helperSnapshotInvalidated' && value.storyId === persistent.storyId) {
            invalidated = true;
            refreshIfClean();
            return;
        }
        if (!pending)
            return;
        if (!value || value.source !== source || value.action !== pending.action || value.requestId !== pending.id)
            return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (value.ok === true)
            request.resolve(value);
        else
            request.reject(new Error(typeof value.error === 'string' ? value.error : '酒馆助手变量保存失败'));
    };
    function refreshIfClean() {
        if (!active || root.__dshTavernDisplayLocked || !invalidated || running || refreshing || editing || differences().length || failure)
            return;
        invalidated = false;
        queueMicrotask(() => { if (active)
            void refreshHelperSnapshot().catch(report); });
    }
    function request(action, resultAction, payload) {
        if (!active)
            return Promise.reject(new Error('卡面已关闭'));
        if (pending)
            return Promise.reject(new Error('卡面已有请求正在处理'));
        const id = `${epoch}:${++serial}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending = null; reject(new Error('酒馆助手通信超时；请保留备份后刷新检查')); }, 15000);
            pending = { id, action: resultAction, resolve, reject, timer };
            parent.postMessage({ source, action, requestId: id, ...payload }, '*');
        });
    }
    function refreshHelperSnapshot(option = {}, provided) {
        if (root.__dshTavernDisplayLocked)
            return Promise.reject(new Error('卡面正在重绘，请等待完成'));
        if (editing)
            return Promise.reject(new Error('请等待消息数据编辑结束后刷新'));
        if (refreshing)
            return refreshing;
        if (running)
            return Promise.reject(new Error('请等待当前变量保存结束后刷新'));
        if (differences().length && option.discardUnsaved !== true)
            return Promise.reject(new Error('卡面有未保存变量，请先保存或复制备份。重新打开卡面可读取已保存的数据。'));
        const before = clone(holder.scopes);
        refreshing = (async () => {
            const response = provided ? { snapshot: provided } : await request('helperSnapshotGet', 'helperSnapshotResult', { storyId: persistent.storyId });
            if (!active)
                throw new Error('卡面已关闭，刷新结果已丢弃');
            const next = response.snapshot;
            if (!next || next.storyId !== persistent.storyId || !Array.isArray(next.messages) || !next.scopes)
                throw new Error('剧情快照回执无效');
            if (!equal(holder.scopes, before))
                throw new Error('刷新期间变量已改变，保留本地数据');
            const changed = !equal(snapshot, next);
            holder.scopes = clone(next.scopes);
            persistent.confirmed = clone(next.scopes);
            persistent.historyRevision = next.historyRevision;
            Object.assign(snapshot, clone(next));
            root.__dshTavernSnapshotGeneration = Number(root.__dshTavernSnapshotGeneration ?? 0) + 1;
            failure = null;
            setStatus('saved');
            const emit = root.__dshTavernEmitLocal;
            // 相同快照不再次通知，避免监听器调用 refreshHelperSnapshot 后无限自触发。
            if (changed && typeof emit === 'function')
                void Promise.resolve(emit('dsh_helper_snapshot_refreshed')).catch(report);
            return clone(snapshot);
        })().finally(() => { refreshing = null; refreshIfClean(); });
        return refreshing;
    }
    async function drain() {
        try {
            for (let changes = differences(); changes.length; changes = differences()) {
                if (!active)
                    throw new Error('卡面已关闭，变量提交已停止');
                if (!snapshot.writable)
                    throw new Error('当前卡面快照不可写，请在生成结束后刷新');
                const batch = changes.slice(0, 64);
                setStatus('pending');
                const response = await request('helperVariablesCommit', 'helperVariablesResult', { storyId: persistent.storyId, historyRevision: persistent.historyRevision, changes: batch });
                if (!active)
                    throw new Error('卡面已关闭，保存结果需重新读取');
                const scopes = response.scopes;
                if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes))
                    throw new Error('变量保存回执无效');
                // 回执带上其它卡面已保存的表；只刷新本地未继续修改的表。
                const sent = new Map(batch.map(change => [change.key, change.value]));
                for (const key of new Set([...Object.keys(scopes), ...Object.keys(persistent.confirmed)])) {
                    const baseline = sent.get(key) ?? persistent.confirmed[key] ?? {};
                    if (equal(holder.scopes[key] ?? {}, baseline))
                        holder.scopes[key] = clone(scopes[key] ?? {});
                }
                persistent.confirmed = clone(scopes);
            }
            setStatus('saved');
        }
        catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            if (active) {
                setStatus('error');
                report(failure);
            }
            ;
            throw failure;
        }
    }
    function flushHelperVariables() {
        if (!active)
            return Promise.reject(new Error('卡面已关闭'));
        if (editing)
            return editing.then(() => flushHelperVariables());
        if (refreshing)
            return refreshing.then(() => flushHelperVariables());
        if (failure)
            return Promise.reject(failure);
        if (!running)
            running = drain().finally(() => { running = null; refreshIfClean(); });
        return running;
    }
    function changed() {
        if (!active)
            throw new Error('卡面已关闭');
        if (failure) {
            setStatus('error');
            return;
        }
        setStatus('pending');
        queueMicrotask(() => { if (active)
            void flushHelperVariables().catch(() => { }); });
    }
    // 消息数据事务复用变量保存队列；等待期间的本地新修改保留，随后以新确认值提交。
    async function messageTransaction(action) {
        await flushHelperVariables();
        if (refreshing)
            await refreshing;
        if (!active)
            throw new Error('卡面已关闭');
        if (editing)
            throw new Error('消息数据编辑仍在进行');
        let release;
        editing = new Promise(resolve => { release = resolve; });
        const baseline = clone(holder.scopes);
        try {
            const result = await action({ ...clone(snapshot), scopes: clone(persistent.confirmed) });
            if (!active)
                throw new Error('卡面已关闭，保存结果需重新读取');
            if (result.snapshot) {
                const next = result.snapshot;
                if (next.storyId !== snapshot.storyId || next.historyRevision !== snapshot.historyRevision || !next.scopes || !Array.isArray(next.messages))
                    throw new Error('消息数据回执无效');
                for (const key of new Set([...Object.keys(next.scopes), ...Object.keys(persistent.confirmed)])) {
                    if (equal(holder.scopes[key] ?? {}, baseline[key] ?? {}))
                        holder.scopes[key] = clone(next.scopes[key] ?? {});
                }
                persistent.confirmed = clone(next.scopes);
                Object.assign(snapshot, clone(next));
                root.__dshTavernSnapshotGeneration = Number(root.__dshTavernSnapshotGeneration ?? 0) + 1;
            }
            return result;
        }
        finally {
            editing = null;
            release();
            if (active) {
                if (differences().length)
                    changed();
                else
                    refreshIfClean();
            }
        }
    }
    root.__dshTavernPrepareMvuEvent = async (next) => {
        if (editing)
            await editing;
        if (running)
            await running;
        if (refreshing)
            await refreshing;
        if (failure || differences().length)
            throw failure ?? new Error('卡面有未保存变量，MVU 监听未执行');
        await refreshHelperSnapshot({}, next);
    };
    root.__dshTavernPrepareHostEvent = async () => {
        // 先等待本地事务收口，再刷新实际剧情；冲突草稿不得被生命周期通知冲掉。
        if (editing)
            await editing;
        if (running)
            await running;
        if (refreshing)
            await refreshing;
        if (!active)
            throw new Error('卡面已关闭');
        if (failure || differences().length)
            throw failure ?? new Error('卡面有未保存变量，宿主事件未执行；请保留草稿后刷新');
        await refreshHelperSnapshot();
    };
    root.__dshTavernMessageTransaction = messageTransaction;
    root.__dshTavernVariableChanged = changed;
    root.flushHelperVariables = flushHelperVariables;
    root.refreshHelperSnapshot = refreshHelperSnapshot;
    root.getHelperPersistenceStatus = () => status;
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, { flushHelperVariables, refreshHelperSnapshot, getHelperPersistenceStatus: root.getHelperPersistenceStatus });
    window.addEventListener('message', receive);
    if (differences().length)
        changed();
    return () => {
        active = false;
        window.removeEventListener('message', receive);
        if (root.__dshTavernVariableChanged === changed)
            delete root.__dshTavernVariableChanged;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('卡面重写或关闭，保存结果需重新读取'));
            pending = null;
        }
    };
}
