import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useState } from 'react';
import { Button, IconSearchOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, Muted, Section, Skeleton, errOf, fileToBase64, useLoader, useToast } from '../util.js';
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'">';
/** 把 CSP meta 注入交互卡 HTML 头部（无 <head> 则直接前置）。 */
function withCsp(html) {
    const head = /<head[^>]*>/i.exec(html);
    if (head) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + CSP_META + html.slice(at);
    }
    return CSP_META + html;
}
/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）。 */
function CardAvatar(props) {
    const { state } = useLoader(() => props.remote.getAvatar({ cardId: props.cardId }), [props.cardId]);
    const url = state.status === 'ready' ? state.value.dataUrl : null;
    return _jsx(Avatar, { url: url, name: props.name, size: props.size });
}
function CharacterDetailDialog(props) {
    const { remote, cardId } = props;
    const { state } = useLoader(async () => {
        const r = await remote.getCharacterDetail({ cardId });
        return r;
    }, [cardId]);
    const [cardOpen, setCardOpen] = useState(false);
    const detail = state.status === 'ready' ? state.value : null;
    const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? detail.extensions.interactiveHtml : null;
    return (_jsxs(Dialog, { open: true, width: "md", title: `角色详情：${detail?.name ?? cardId}`, onClose: props.onClose, children: [state.status === 'loading' && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 14, width: "60%" }), _jsx(Skeleton, { height: 90 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), detail && (_jsxs("div", { className: "dsh-tavern-scroll", style: { maxHeight: '60vh', overflow: 'auto', fontSize: 13 }, children: [_jsxs("div", { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }, children: [_jsx(CardAvatar, { remote: remote, cardId: cardId, name: detail.name, size: 48 }), _jsxs("div", { children: [_jsx("div", { style: { fontWeight: 600 }, children: detail.name }), _jsxs(Muted, { children: [detail.spec, " \u00B7 v", detail.characterVersion || '?', " \u00B7 ", detail.creator || '未知作者', detail.hasCharacterBook ? ` · 内嵌世界书${detail.characterBookName ? `「${detail.characterBookName}」` : ''}${typeof detail.characterBookEntryCount === 'number' ? ` ${detail.characterBookEntryCount} 条` : ''}` : ''] })] })] }), detail.tags.length > 0 && _jsx("div", { style: { marginBottom: 8 }, children: _jsxs(Muted, { children: ["\u6807\u7B7E\uFF1A", detail.tags.join('、')] }) }), [
                        ['描述', detail.description],
                        ['性格', detail.personality],
                        ['场景', detail.scenario],
                        ['开场白', detail.firstMes],
                        ...detail.alternateGreetings.map((g, i) => [`开场白变体 ${i + 1}`, g]),
                        ['对话示例', detail.mesExample],
                        ['系统提示', detail.systemPrompt],
                        ['历史后指令', detail.postHistoryInstructions],
                        ['作者备注', detail.creatorNotes],
                    ]
                        .filter(([, v]) => v)
                        .map(([k, v]) => (_jsxs("div", { style: { marginBottom: 8 }, children: [_jsx("div", { style: { fontWeight: 600, fontSize: 12, opacity: 0.8 }, children: k }), _jsx("pre", { className: "dsh-tavern-scroll", style: { whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: 12, maxHeight: 160, overflow: 'auto' }, children: v })] }, k))), interactiveHtml !== null && (_jsx("div", { style: { marginTop: 8 }, children: _jsx(Btn, { onClick: () => setCardOpen(true), children: "\u6253\u5F00\u4EA4\u4E92\u5361" }) }))] })), cardOpen && interactiveHtml !== null && (_jsx(Dialog, { open: true, width: "lg", title: `交互卡：${detail?.name ?? ''}`, onClose: () => setCardOpen(false), children: _jsx("iframe", { sandbox: "allow-scripts", srcDoc: withCsp(interactiveHtml), title: "\u4EA4\u4E92\u5361", style: { width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' } }) }))] }));
}
export function CharactersSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listCharacters({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [detailId, setDetailId] = useState(null);
    const [pending, setPending] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const toast = useToast();
    const doImport = async (name, dataBase64, importWorldBook) => {
        setBusy(true);
        setError(null);
        try {
            const r = await remote.importCharacter({ name, dataBase64, importWorldBook });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(importWorldBook ? '已导入角色卡（含内嵌世界书）' : '已导入角色卡');
                reload();
            }
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
            setPending(null);
        }
    };
    const onImportFile = async (file) => {
        setBusy(true);
        setError(null);
        try {
            const dataBase64 = await fileToBase64(file);
            const inspected = await remote.inspectCharacter({ name: file.name, dataBase64 });
            if (!inspected.ok) {
                setError(inspected.error.message);
                return;
            }
            if (inspected.value.hasCharacterBook) {
                setPending({ name: file.name, dataBase64, preview: inspected.value });
                return;
            }
            await doImport(file.name, dataBase64, false);
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
        }
    };
    const onDelete = async () => {
        if (!toDelete)
            return;
        setBusy(true);
        const r = await remote.deleteCharacter({ cardId: toDelete.cardId });
        setBusy(false);
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(r.ok && r.value.salvagedLorebook
                ? `已删除「${toDelete.name}」，内嵌世界书已保留到世界书库：${r.value.salvagedLorebook}`
                : `已删除「${toDelete.name}」`);
            setToDelete(null);
            reload();
        }
    };
    const items = state.status === 'ready' ? state.value.items : [];
    return (_jsxs(Section, { title: "\u89D2\u8272\u5361", description: "\u5BFC\u5165 SillyTavern PNG / JSON\u3002\u5220\u9664\u4F1A\u6E05\u6389\u8BE5\u5361\u5DE5\u4F5C\u533A\uFF0C\u4EE5\u53CA\u4ECD\u6307\u5411\u5B83\u7684\u4F1A\u8BDD\u7ED1\u5B9A\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".png,.json", disabled: busy, onFile: (file) => void onImportFile(file), children: "\u5BFC\u5165 PNG / JSON" }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: "\u5237\u65B0" })] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 48 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u8FD8\u6CA1\u6709\u89D2\u8272\u5361" }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: "\u5BFC\u5165\u4E00\u5F20 SillyTavern \u89D2\u8272\u5361\uFF08PNG \u6216 JSON\uFF09\u5F00\u59CB\u3002" })] })), _jsx("div", { className: "dsh-tavern-list", children: items.map((item) => (_jsxs("div", { className: "dsh-tavern-listRow", children: [_jsx(CardAvatar, { remote: remote, cardId: item.cardId, name: item.name, size: 36 }), _jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "dsh-tavern-cardName", children: item.name }), item.hasCharacterBook ? (_jsxs(Muted, { children: ["\u5185\u5D4C\u4E16\u754C\u4E66", item.characterBookName ? `「${item.characterBookName}」` : '', typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0 ? ` ${item.characterBookEntryCount} 条` : ''] })) : (_jsx(Muted, { children: "\u65E0\u5185\u5D4C\u4E16\u754C\u4E66" }))] }), _jsx(IconBtn, { label: "\u67E5\u770B\u8BE6\u60C5", onClick: () => setDetailId(item.cardId), children: _jsx(IconSearchOutline16, {}) }), _jsx(IconBtn, { label: "\u5220\u9664", danger: true, disabled: busy, onClick: () => setToDelete(item), children: _jsx(IconTrashOutline16, {}) })] }, item.cardId))) }), detailId && _jsx(CharacterDetailDialog, { remote: remote, cardId: detailId, onClose: () => setDetailId(null) }), pending && (_jsx(Dialog, { open: true, title: "\u5BFC\u5165\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F", description: `角色卡「${pending.preview.name}」内嵌世界书${pending.preview.characterBookName ? `「${pending.preview.characterBookName}」` : ''}，共 ${pending.preview.entryCount} 条。导入后会作为该卡的主世界书。`, onClose: () => setPending(null), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, false), children: "\u8DF3\u8FC7" }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, true), children: "\u5BFC\u5165\u4E16\u754C\u4E66" })] }), children: _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }, children: "\u8DF3\u8FC7\u540E\u4ECD\u5BFC\u5165\u89D2\u8272\u5361\uFF08\u63CF\u8FF0\u3001\u5F00\u573A\u767D\u3001\u6B63\u5219\uFF09\uFF0C\u53EA\u662F\u4E0D\u542F\u7528\u8FD9\u672C\u5185\u5D4C\u4E16\u754C\u4E66\u3002" }) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u89D2\u8272\u5361\uFF1F", description: toDelete ? `确定删除角色「${toDelete.name}」？其工作区（记忆/世界状态）以及仍绑定该卡的会话都会解除。文件夹 ID 不会出现在对话标题里。` : '', confirmLabel: "\u5220\u9664", danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void onDelete() })] }));
}
