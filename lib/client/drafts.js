import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 编辑草稿保护：向所在面板汇报修改/保存状态，离开前用宿主确认框保护未保存内容。 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useT } from './i18n.js';
import { ConfirmDialog } from './util.js';
import { usePersistentDraftStatus } from './draftPersistence.js';
const DraftContext = createContext(null);
/** 每个编辑器独立注册，避免一个干净的子编辑器覆盖另一个编辑器的未保存状态。 */
export function useDraftGuard(dirty, busy = false, clearChildren) {
    const report = useContext(DraftContext);
    const id = useId();
    const discard = usePersistentDraftStatus(id, dirty, busy);
    // 确认放弃和保存后立即关闭都可同步清理；不能依赖卸载前再提交一次 dirty=false。
    const clearDraft = useCallback(() => { discard?.(); clearChildren?.(); }, [discard, clearChildren]);
    const t = useT();
    const [pending, setPending] = useState(null);
    useEffect(() => {
        report?.(id, { dirty, busy, clearDraft });
        return () => report?.(id, null);
    }, [report, id, dirty, busy, clearDraft]);
    // 浏览器刷新/关闭绕过面板导航；只在确有草稿或写入未完成时注册原生离开保护。
    useEffect(() => {
        if ((!dirty && !busy) || typeof window === 'undefined')
            return;
        const onUnload = (event) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', onUnload);
        return () => window.removeEventListener('beforeunload', onUnload);
    }, [dirty, busy]);
    const request = (action) => {
        if (busy)
            return;
        if (dirty)
            setPending(() => action);
        else
            action();
    };
    const confirmation = _jsx(ConfirmDialog, { open: pending !== null, title: t('draft.leaveTitle'), description: t('draft.leaveDesc'), confirmLabel: t('draft.discard'), danger: true, busy: busy, onCancel: () => setPending(null), onConfirm: () => {
            if (busy)
                return;
            setPending(null);
            clearDraft();
            pending?.();
        } });
    return { request, confirmation, clearDraft };
}
/** 一级导航汇总当前页全部编辑器；保存中不允许卸载，取消离开时保留原草稿。 */
export function DraftScope(props) {
    const [statuses, setStatuses] = useState({});
    const report = useCallback((id, status) => {
        setStatuses((current) => {
            const next = { ...current };
            if (status)
                next[id] = status;
            else
                delete next[id];
            return next;
        });
    }, []);
    const dirty = Object.values(statuses).some((s) => s.dirty);
    const busy = Object.values(statuses).some((s) => s.busy);
    const currentStatuses = useRef(statuses);
    currentStatuses.current = statuses;
    // 外层 Dialog 可位于持久草稿 provider 之外；通过子注册项把放弃传递到真正存储范围。
    const clearChildren = useCallback(() => {
        for (const status of Object.values(currentStatuses.current))
            if (status.dirty)
                status.clearDraft();
    }, []);
    const guard = useDraftGuard(dirty, busy, clearChildren);
    return _jsxs(DraftContext.Provider, { value: report, children: [props.children(guard.request, dirty, busy), guard.confirmation] });
}
