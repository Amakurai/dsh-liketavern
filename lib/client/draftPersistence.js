import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 编辑器自动草稿：内容只经 remote 存在宿主数据目录；浏览器只保留本标签页的随机标识。 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from './i18n.js';
import { Btn, Err, Skeleton } from './util.js';
const PersistenceContext = createContext(null);
const queues = new Map();
let fallbackOwner;
function ownerId() {
    try {
        const key = 'dsh-tavern-editor-owner';
        const existing = window.sessionStorage.getItem(key);
        if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing))
            return existing;
        const owner = crypto.randomUUID();
        window.sessionStorage.setItem(key, owner);
        return owner;
    }
    catch {
        // 禁用浏览器存储时仍可在当前页面暂存；不会把用户内容放进本地存储。
        return fallbackOwner ??= crypto.randomUUID();
    }
}
/** 同一页面在关闭后立即重开，先完成上一实例的写入，再读取草稿。 */
function enqueue(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(operation);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next)
        queues.delete(key); }).catch(() => { });
    return next;
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
    // 未安装 remote 的隔离渲染环境仍保留普通编辑能力。
    if (parent || !props.remote?.getEditorDraft)
        return _jsx(_Fragment, { children: props.children });
    return _jsx(DraftLoader, { remote: props.remote, scope: props.scope, children: props.children }, props.scope);
}
function DraftLoader(props) {
    const t = useT();
    const [owner] = useState(ownerId);
    const [attempt, retry] = useState(0);
    const [loaded, setLoaded] = useState(null);
    const [error, setError] = useState(null);
    const queueKey = `${owner}:${props.scope}`;
    useEffect(() => {
        let cancelled = false;
        setError(null);
        void enqueue(queueKey, () => props.remote.getEditorDraft({ owner, key: props.scope })).then((result) => {
            if (cancelled)
                return;
            if (!result.ok)
                throw new Error(result.error.message);
            setLoaded({ snapshot: result.value.draft ? readSnapshot(result.value.draft.value) : null });
        }).catch((cause) => { if (!cancelled)
            setError(cause instanceof Error ? cause.message : String(cause)); });
        return () => { cancelled = true; };
    }, [props.remote, props.scope, queueKey, owner, attempt]);
    if (error)
        return _jsxs("div", { className: "dsh-tavern-ui", children: [_jsx(Err, { message: `${t('draft.loadFailed')} ${error}` }), _jsx(Btn, { onClick: () => retry((n) => n + 1), children: t('action.retry') })] });
    if (!loaded)
        return _jsx(Skeleton, {});
    return _jsx(DraftSession, { remote: props.remote, scope: props.scope, owner: owner, snapshot: loaded.snapshot, children: props.children });
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
        let pendingWrites = 0;
        const queueKey = `${props.owner}:${props.scope}`;
        const capture = () => {
            const dirty = [...statuses.values()].some((s) => s.dirty);
            const busy = [...statuses.values()].some((s) => s.busy);
            if (dirty) {
                seenDirty = true;
                // JSON 归一化去掉可选 undefined；后端再次做大小、结构和污染键校验。
                last = JSON.parse(JSON.stringify({ version: 1, fields: Object.fromEntries([...fields].map(([key, f]) => [key, f.value])) }));
            }
            else if (seenDirty && !busy)
                last = null;
        };
        const flush = () => {
            if (timer)
                clearTimeout(timer);
            timer = undefined;
            if (last === undefined)
                return;
            const serialized = JSON.stringify(last);
            if (serialized === persisted && pendingWrites === 0)
                return;
            const snapshot = last;
            const current = ++revision;
            pendingWrites++;
            if (mounted) {
                setWriteState('saving');
                setError(null);
            }
            void enqueue(queueKey, async () => {
                const result = snapshot
                    ? await props.remote.saveEditorDraft({ owner: props.owner, key: props.scope, value: snapshot })
                    : await props.remote.deleteEditorDraft({ owner: props.owner, key: props.scope });
                if (!result.ok)
                    throw new Error(result.error.message);
                persisted = serialized;
                if (mounted && current === revision)
                    setWriteState(snapshot ? 'saved' : 'idle');
            }).catch((cause) => {
                if (mounted && current === revision) {
                    setWriteState('error');
                    setError(cause instanceof Error ? cause.message : String(cause));
                }
            }).finally(() => { pendingWrites--; });
        };
        const schedule = () => {
            if (!mounted)
                return;
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(() => { capture(); flush(); }, 500);
        };
        const registry = {
            restored,
            field(key, token, value) {
                fields.set(key, { token, value });
                delete restored[key];
                capture();
                schedule();
            },
            remove(key, token) { if (fields.get(key)?.token === token)
                fields.delete(key); schedule(); },
            report(id, status) {
                if (status) {
                    statuses.set(id, status);
                    capture();
                }
                else
                    statuses.delete(id);
                schedule();
            },
            discard() {
                for (const key of Object.keys(restored))
                    delete restored[key];
                last = null;
                seenDirty = false;
                flush();
            },
        };
        return { registry, flush, start() { mounted = true; }, stop() { mounted = false; flush(); } };
    });
    useEffect(() => {
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
    return registry?.discard;
}
