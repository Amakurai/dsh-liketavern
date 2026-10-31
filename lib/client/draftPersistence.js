import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 编辑器自动草稿：内容只经 remote 存在宿主数据目录；浏览器只保留本标签页的随机标识。 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from './i18n.js';
import { Btn, Err, Skeleton, useLoader } from './util.js';
import { randomUuid } from '../core/secureRandom.js';
import { remoteIdentity } from './remoteIdentity.js';
const PersistenceContext = createContext(null);
const remotes = new WeakMap();
let fallbackOwner;
/** remote 决定宿主身份；相同浏览器标识与面板名不能让不同宿主共享快照或飞行请求。 */
function draftRemote(remote) {
    let value = remotes.get(remote);
    if (!value) {
        value = { id: remoteIdentity(remote), queues: new Map() };
        remotes.set(remote, value);
    }
    return value;
}
function ownerId() {
    try {
        const key = 'dsh-tavern-editor-owner';
        const existing = window.sessionStorage.getItem(key);
        if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing))
            return existing;
        const owner = randomUuid();
        window.sessionStorage.setItem(key, owner);
        return owner;
    }
    catch {
        // 禁用浏览器存储时仍可在当前页面暂存；不会把用户内容放进本地存储。
        return fallbackOwner ??= randomUuid();
    }
}
/** 写入与删除跨编辑器实例串行，保留关闭后立即重开的最终写入顺序。 */
function enqueue(remote, key, operation) {
    const queues = draftRemote(remote).queues;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(operation);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next)
        queues.delete(key); }).catch(() => { });
    return next;
}
/** 读取等待此前的写入，但不占写队列；已挂起的只读请求不能挡住超时后的重试。 */
function readAfterWrites(remote, key, operation) {
    return (draftRemote(remote).queues.get(key) ?? Promise.resolve()).catch(() => { }).then(operation);
}
function readSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid editor draft');
    const draft = value;
    if (draft.version !== 1 || !draft.fields || typeof draft.fields !== 'object' || Array.isArray(draft.fields))
        throw new Error('Unsupported editor draft');
    return { version: 1, fields: draft.fields };
}
/** 分区独立入口可复用；设置面板内的分区共用父级快照，保留页签与所选角色/剧情。 */
export function PersistentEditor(props) {
    const parent = useContext(PersistenceContext);
    if (parent && (!props.remote || parent.remote === props.remote))
        return _jsx(_Fragment, { children: props.children });
    // 未安装 remote 的隔离渲染环境仍保留普通编辑能力。
    if (!props.remote?.getEditorDraft)
        return _jsx(PersistenceContext.Provider, { value: null, children: props.children });
    return _jsx(DraftLoader, { remote: props.remote, scope: props.scope, children: props.children }, JSON.stringify([draftRemote(props.remote).id, props.scope]));
}
function DraftLoader(props) {
    const t = useT();
    const [owner] = useState(ownerId);
    const queueKey = `${owner}:${props.scope}`;
    const loaded = useLoader(async () => {
        const result = await readAfterWrites(props.remote, queueKey, () => props.remote.getEditorDraft({ owner, key: props.scope }));
        if (!result.ok)
            return result;
        return { ok: true, value: { snapshot: result.value.draft ? readSnapshot(result.value.draft.value) : null } };
    }, [props.remote, props.scope, owner]);
    if (loaded.state.status === 'error')
        return _jsxs("div", { className: "dsh-tavern-ui", children: [_jsx(Err, { message: `${t('draft.loadFailed')} ${loaded.state.message}` }), _jsx(Btn, { onClick: loaded.reload, children: t('action.retry') })] });
    if (loaded.state.status !== 'ready')
        return _jsx(Skeleton, {});
    return _jsx(DraftSession, { remote: props.remote, scope: props.scope, owner: owner, snapshot: loaded.state.value.snapshot, children: props.children });
}
function DraftSession(props) {
    const t = useT();
    const [writeState, setWriteState] = useState(props.snapshot ? 'restored' : 'idle');
    const [error, setError] = useState(null);
    const [session] = useState(() => {
        const fields = new Map();
        const statuses = new Map();
        const restored = { ...props.snapshot?.fields };
        let timer;
        let mounted = true;
        let seenDirty = false;
        let last = props.snapshot ?? undefined;
        let revision = 0;
        let persisted = JSON.stringify(last);
        let activeWrite;
        let queuedWrite;
        const queueKey = `${props.owner}:${props.scope}`;
        const capture = () => {
            const dirty = [...statuses.values()].some((s) => s.dirty);
            const busy = [...statuses.values()].some((s) => s.busy);
            // 异步子编辑器尚未挂载时，不能丢掉未消费的恢复字段，也不能据父表单已保存而清空整份快照。
            if (dirty || (seenDirty && Object.keys(restored).length > 0)) {
                seenDirty = true;
                // JSON 归一化去掉可选 undefined；后端再次做大小、结构和污染键校验。
                last = JSON.parse(JSON.stringify({ version: 1, fields: { ...restored, ...Object.fromEntries([...fields].map(([key, f]) => [key, f.value])) } }));
            }
            else if (seenDirty && !busy)
                last = null;
        };
        const flush = () => {
            if (timer)
                clearTimeout(timer);
            timer = undefined;
            // 字段注册只更新引用；完整 JSON 快照在防抖、重试、pagehide 或卸载时才编码，避免每次输入复制整份大草稿。
            capture();
            if (last === undefined)
                return;
            const serialized = JSON.stringify(last);
            if (queuedWrite?.serialized === serialized || (!queuedWrite && activeWrite?.serialized === serialized))
                return;
            if (!queuedWrite && !activeWrite && serialized === persisted)
                return;
            const latest = { snapshot: last, serialized, revision: ++revision };
            if (mounted) {
                setWriteState('saving');
                setError(null);
            }
            // 等待中的任务始终占住原队列位置，关闭重开会在它之后读；慢请求期间只替换其快照，不积压每次编辑。
            if (queuedWrite) {
                Object.assign(queuedWrite, latest);
                return;
            }
            const write = queuedWrite = latest;
            void enqueue(props.remote, queueKey, async () => {
                queuedWrite = undefined;
                activeWrite = write;
                const { snapshot, serialized, revision: current } = write;
                try {
                    const result = snapshot
                        ? await props.remote.saveEditorDraft({ owner: props.owner, key: props.scope, value: snapshot })
                        : await props.remote.deleteEditorDraft({ owner: props.owner, key: props.scope });
                    if (!result.ok)
                        throw new Error(result.error.message);
                    persisted = serialized;
                    if (mounted && current === revision)
                        setWriteState(snapshot ? 'saved' : 'idle');
                }
                finally {
                    if (activeWrite === write)
                        activeWrite = undefined;
                }
            }).catch((cause) => {
                if (mounted && write.revision === revision) {
                    setWriteState('error');
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            });
        };
        const schedule = () => {
            if (!mounted)
                return;
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(flush, 500);
        };
        const registry = {
            remote: props.remote,
            restored,
            field(key, token, value) {
                fields.set(key, { token, value });
                delete restored[key];
                schedule();
            },
            remove(key, token) {
                if (fields.get(key)?.token === token) {
                    fields.delete(key);
                }
                schedule();
            },
            report(id, status) {
                if (status) {
                    statuses.set(id, status);
                    seenDirty ||= status.dirty;
                }
                else
                    statuses.delete(id);
                schedule();
            },
            discard(id) {
                if (id !== undefined) {
                    const current = statuses.get(id);
                    if (current)
                        statuses.set(id, { ...current, dirty: false });
                }
                else {
                    for (const [key, current] of statuses)
                        if (current.dirty)
                            statuses.set(key, { ...current, dirty: false });
                }
                if ([...statuses.values()].some((s) => s.dirty)) {
                    schedule();
                    return;
                }
                for (const key of Object.keys(restored))
                    delete restored[key];
                last = null;
                seenDirty = false;
                flush();
            },
        };
        return { registry, flush, start() { mounted = true; }, stop() { mounted = false; flush(); } };
    });
    useLayoutEffect(() => {
        session.start();
        const flush = () => session.flush();
        if (typeof window !== 'undefined')
            window.addEventListener('pagehide', flush);
        return () => { if (typeof window !== 'undefined')
            window.removeEventListener('pagehide', flush); session.stop(); };
    }, [session]);
    return _jsxs(PersistenceContext.Provider, { value: session.registry, children: [writeState !== 'idle' && _jsxs("div", { className: "dsh-tavern-ui dsh-tavern-draftStatus", role: "status", children: [_jsx("span", { children: t(writeState === 'restored' ? 'draft.restored' : writeState === 'saving' ? 'draft.autosaving' : writeState === 'error' ? 'draft.autosaveFailed' : 'draft.autosaved') }), error && _jsxs(_Fragment, { children: [_jsx(Err, { message: error }), _jsx(Btn, { onClick: session.flush, children: t('action.retry') })] })] }), props.children] });
}
/** 可动态切换字段键；切换角色/剧情时不会带入上一对象的 React state。 */
export function useDraftState(key, initial) {
    const registry = useContext(PersistenceContext);
    const initialRef = useRef(initial);
    initialRef.current = initial;
    const resolve = () => Object.hasOwn(registry?.restored ?? {}, key)
        ? registry.restored[key]
        : typeof initialRef.current === 'function' ? initialRef.current() : initialRef.current;
    const [state, setState] = useState(() => ({ key, value: resolve() }));
    let value = state.value;
    if (state.key !== key) {
        value = resolve();
        setState({ key, value });
    }
    const token = useRef({});
    useLayoutEffect(() => {
        registry?.field(key, token.current, value);
        return () => registry?.remove(key, token.current);
    }, [registry, key, value]);
    const setValue = useCallback((next) => {
        setState((current) => ({ key, value: typeof next === 'function' ? next(current.value) : next }));
    }, [key]);
    return [value, setValue];
}
/** 恢复标志固定在当前实例；异步资产加载只在第一次跳过草稿，保存后的刷新正常回填。 */
export function useDraftRestored(key) {
    const registry = useContext(PersistenceContext);
    const [restored] = useState(() => Object.hasOwn(registry?.restored ?? {}, key));
    return restored;
}
export function usePersistentDraftStatus(id, dirty, busy) {
    const registry = useContext(PersistenceContext);
    useEffect(() => {
        registry?.report(id, { dirty, busy });
        return () => registry?.report(id, null);
    }, [registry, id, dirty, busy]);
    const discard = useCallback(() => registry?.discard(id), [registry, id]);
    return registry ? discard : undefined;
}
